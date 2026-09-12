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
 if(req.method==='account/read')result=state.noIdentity?{}:{account:{type:'chatgpt',email:state.email,planType:state.plan}};
 if(req.method==='account/rateLimits/read'){
  result={rateLimits:{limitId:'codex',planType:state.plan,primary:{usedPercent:state.used,windowDurationMins:state.period,resetsAt:2000000000}}};
  if(state.race)writeFileSync(path,JSON.stringify({...state,email:'raced@example.invalid',race:false}));
 }
 console.log(JSON.stringify({id:req.id,result}));
}
`,{mode:0o700});
  const set=(extra={})=>writeFileSync(remote,JSON.stringify({email:"a@example.invalid",plan:"plus",used:90,period:300,...extra}));
  set();
  return {dir,auth,set,client:()=>new CodexAppServerClient(binary,"default",2000,dir)};
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
  const unknown=(await first.readRateLimits())[0]!;
  expect(unknown.metadata?.accountContext).toBeUndefined();
  expect(codexContextChange(before,unknown)).toBeNull();
  expect(unknown.metadata?.planType).toBe("pro");
 }finally{await first.close();await second.close();rmSync(f.dir,{recursive:true,force:true})}
});

test("a login that changes during quota lookup cannot mix identity with the wrong snapshot",async()=>{
 const f=fixture(),client=f.client();f.set({race:true});
 try{await expect(client.readRateLimits()).rejects.toThrow("login changed during quota lookup");}
 finally{await client.close();rmSync(f.dir,{recursive:true,force:true})}
});
