import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/providers/codex-appserver";
import { QuotaPieService } from "../src/service";
import { QuotaDatabase } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";
import { codexContextChange } from "../src/domain/codex-context";
import { planTriggers } from "../src/triggers";

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"quotapie-context-"));
  const remote=join(dir,"remote.json"),auth=join(dir,"auth.json"),binary=join(dir,"fake-codex");
  writeFileSync(auth,"{}");
  writeFileSync(binary,`#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const path=process.env.CODEX_HOME+'/remote.json';
for await(const line of createInterface({input:process.stdin})){
 const req=JSON.parse(line);if(req.id==null)continue;
 const state=JSON.parse(readFileSync(path,'utf8'));
 let result={};
 if(req.method==='account/read' && state.identityError){
  console.log(JSON.stringify({id:req.id,error:{code:state.identityError,message:'Synthetic account lookup failure'}}));continue;
 }
 if(req.method==='account/read')result=state.noIdentity?{}:{account:{type:'chatgpt',email:state.email,planType:state.plan}};
 if(req.method==='account/rateLimits/read'){
  result={rateLimits:{limitId:state.limitId??'codex',planType:state.plan,primary:{usedPercent:state.used,windowDurationMins:state.period,resetsAt:state.resetsAt??2000000000}}};
  if(state.race)writeFileSync(path,JSON.stringify({...state,email:'raced@example.invalid',race:false}));
 }
 console.log(JSON.stringify({id:req.id,result}));
}
`,{mode:0o700});
  const set=(extra={})=>writeFileSync(remote,JSON.stringify({email:"a@example.invalid",plan:"plus",used:90,period:300,...extra}));
  set();
  return {dir,auth,binary,set,client:()=>new CodexAppServerClient(binary,"default",2000,dir)};
}

test("login switch, same-login plan change and same-plan window change have separate evidence and alerts",async()=>{
 const f=fixture(),client=f.client(),config=structuredClone(DEFAULT_CONFIG),db=new QuotaDatabase(":memory:");
 config.alerts.enabled=true;config.profile.locale="ko";
 const service=new QuotaPieService(config,db);
 const base=Date.now();let tick=0;
 const read=async()=>{const observations=(await client.readRateLimits()).map(o=>({...o,observedAtMs:base+tick++*1000}));
  return {observations,events:service.ingestCodexSnapshot(observations)};};
 try {
  const first=await read();expect(first.observations[0]?.metadata?.planType).toBe("plus");
  // Token refresh/reconnect alone is not a different account or subscription.
  writeFileSync(f.auth,'{"changed":true}');utimesSync(f.auth,new Date(),new Date(Date.now()+2000));
  const refresh=await read();expect(refresh.events.some(e=>["account_changed","plan_changed"].includes(e.kind))).toBe(false);
  expect(refresh.observations[0]?.metadata?.accountContext).toBe(first.observations[0]?.metadata?.accountContext);
  f.set({email:"b@example.invalid",plan:"pro",used:5,period:10080});
  const switched=await read();expect(switched.events.filter(e=>e.kind==="account_changed")).toHaveLength(1);
  expect(switched.events.some(e=>["plan_changed","window_changed","external_relief","allowance_relief"].includes(e.kind))).toBe(false);
  expect(service.analyses(base+2000)).toHaveLength(1);
  f.set({email:"b@example.invalid",plan:"plus",used:2,period:300});
  const plan=await read();expect(plan.events.filter(e=>e.kind==="plan_changed")).toHaveLength(1);
  expect(plan.events.find(e=>e.kind==="plan_changed")?.details).toEqual({fromPlan:"pro",toPlan:"plus"});
  expect(plan.events.some(e=>["account_changed","window_changed","external_relief"].includes(e.kind))).toBe(false);
  f.set({email:"b@example.invalid",plan:"plus",used:2,period:10080});
  const layout=await read();expect(layout.events.find(e=>e.kind==="window_changed")?.displayText).toContain("미확인");
  expect((await read()).events.some(e=>["account_changed","plan_changed","window_changed"].includes(e.kind))).toBe(false);
  for(const [events,title] of [[switched.events,"alert.event.title.account"],[plan.events,"alert.event.title.plan"]] as const){
   expect(planTriggers([],events,config,base,base+10000).some(d=>d.presentation?.title.key===title)).toBe(true);
  }
  const saved=db.db.query("SELECT metadata_json FROM snapshots").all();
  expect(JSON.stringify(saved)).not.toContain("example.invalid");expect(JSON.stringify(saved)).not.toContain("email");
 }finally{await client.close();await service.close();rmSync(f.dir,{recursive:true,force:true})}
});

test("collector restarts and missing identity do not establish an account or plan change",async()=>{
 const f=fixture();const first=f.client(),second=f.client();
 try{
  const before=(await first.readRateLimits())[0]!;
  const after=(await second.readRateLimits())[0]!;
  expect(codexContextChange(before,after)).toBeNull();
  f.set({noIdentity:true,plan:"pro"});
  await expect(first.readRateLimits()).rejects.toThrow("identity unavailable");
  const unknownClient=f.client();
  const unknown=(await unknownClient.readRateLimits())[0]!;
  await unknownClient.close();
  expect(unknown.metadata?.accountContext).toBeUndefined();
  expect(codexContextChange(before,unknown)).toBeNull();
  expect(unknown.metadata?.planType).toBe("pro");
 }finally{await first.close();await second.close();rmSync(f.dir,{recursive:true,force:true})}
});

test("failed account reads preserve the last trusted plan until a comparable snapshot returns", async () => {
  for (const interruption of [{ identityError: -32603 }, { noIdentity: true }]) {
    const f = fixture(), client = f.client();
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), new QuotaDatabase(":memory:"));
    const now = Date.now();
    const ingest = async (tick: number) => service.ingestCodexSnapshot(
      (await client.readRateLimits()).map(o => ({ ...o, observedAtMs: now + tick * 1000 })));
    try {
      await ingest(0);
      f.set({ ...interruption, plan: "pro", used: 0, resetsAt: 2000086400 });
      await expect(ingest(1)).rejects.toThrow();
      expect(service.recentEvents().some(e => ["external_relief", "allowance_relief"].includes(e.kind))).toBe(false);
      f.set({ plan: "pro", used: 0, resetsAt: 2000086400 });
      expect((await ingest(2)).filter(e => e.kind === "plan_changed")).toHaveLength(1);
      expect(service.resetTracking(now + 3000).accounts[0]!.windows[0]!.recovery).toBeNull();
      expect((await ingest(3)).some(e => e.kind === "plan_changed")).toBe(false);
    } finally { await client.close(); await service.close(); rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test("older providers without account/read keep quota support and isolate known plan changes", async () => {
  const f = fixture(), client = f.client();
  try {
    f.set({ identityError: -32601 });
    const first = (await client.readRateLimits())[0]!;
    f.set({ identityError: -32601, plan: "pro", used: 0 });
    const second = (await client.readRateLimits())[0]!;
    expect(second.usedPercent).toBe(0);
    expect(second.metadata?.accountContext).toBeUndefined();
    expect(second.metadata?.collectorEpoch).not.toBe(first.metadata?.collectorEpoch);
  } finally { await client.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("the resident service retains trusted context across rejected account lookups", async () => {
  for (const change of ["plan", "account"]) {
    const f = fixture(), config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexCommand = f.binary;
    config.accounts.codex[0]!.codexHome = f.dir;
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    try {
      await service.pollCodex();
      const next = { plan: "pro", used: 0, resetsAt: 2000086400,
        ...(change === "account" ? { email: "b@example.invalid" } : {}) };
      f.set({ ...next, identityError: -32603 });
      await expect(service.pollCodex()).rejects.toThrow("all configured Codex accounts failed");
      expect(service.db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
      f.set(next);
      const events = await service.pollCodex();
      expect(events.filter(e => e.kind === `${change}_changed`)).toHaveLength(1);
      expect(events.some(e => ["external_relief", "allowance_relief"].includes(e.kind))).toBe(false);
      expect((await service.pollCodex()).some(e => e.kind === `${change}_changed`)).toBe(false);
    } finally { await service.close(); rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test("a retained old general window cannot repeat an account switch or hide the new account's recovery", async () => {
  const f = fixture(), client = f.client();
  const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), new QuotaDatabase(":memory:"));
  const now = Date.now();
  const ingest = async (tick: number) => service.ingestCodexSnapshot(
    (await client.readRateLimits()).map(o => ({ ...o, observedAtMs: now + tick * 1000 })));
  try {
    await ingest(0);
    f.set({ email: "b@example.invalid", plan: "pro", limitId: "codex_bengalfox" });
    expect((await ingest(1)).filter(e => e.kind === "account_changed")).toHaveLength(1);
    f.set({ email: "b@example.invalid", plan: "pro", limitId: "codex_bengalfox", used: 0, resetsAt: 2000086400 });
    const recovered = await ingest(2);
    expect(recovered.some(e => e.kind === "external_relief")).toBe(true);
    expect(recovered.some(e => e.kind === "account_changed")).toBe(false);
    expect(service.resetTracking(now + 3000).accounts[0]!.windows[0]!.recovery).not.toBeNull();
  } finally { await client.close(); await service.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("transition notification titles identify each configured account in both locales", () => {
  const config = structuredClone(DEFAULT_CONFIG), now = Date.now();
  config.accounts.codex = ["personal", "work"].map(id => ({ id, label: `${id} label`, enabled: true, codexHome: null }));
  for (const locale of ["en", "ko"]) {
    config.profile.locale = locale;
    for (const kind of ["account_changed", "plan_changed", "window_changed"] as const) {
      const events = config.accounts.codex.map(({ id: account }) => ({ provider: "codex" as const, account,
        bucket: "codex:primary:300", kind, severity: "info" as const, confidence: "high" as const,
        occurredAtMs: now, displayText: "synthetic", details: { fromPlan: "plus", toPlan: "pro", fromLabel: "5h", toLabel: "weekly" } }));
      const decisions = planTriggers([], events, config, 0, now);
      expect(decisions[0]!.title).toContain("personal label");
      expect(decisions[1]!.title).toContain("work label");
      expect(decisions[0]!.presentation?.title.params.account).toBe("personal label");
    }
  }
});

test("a login that changes during quota lookup cannot mix identity with the wrong snapshot",async()=>{
 const f=fixture(),client=f.client();f.set({race:true});
 try{await expect(client.readRateLimits()).rejects.toThrow("login changed during quota lookup");}
 finally{await client.close();rmSync(f.dir,{recursive:true,force:true})}
});
