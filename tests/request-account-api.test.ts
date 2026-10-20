import { expect, test } from "bun:test";
import { RequestAccountAPI } from "../src/request-account-api";
import type { AppConfig } from "../src/config";
import type { RoutingSummary, RequestRoute } from "../src/request-routing";
const threadId="10000000-0000-4000-8000-000000000001";
const config={accounts:{codex:[{id:"main",enabled:true,label:"Main"},{id:"other",enabled:true,label:"Other"}]}} as AppConfig;
const route={attribution:"relay-source",kind:"response",turnId:"20000000-0000-4000-8000-000000000002",threadId,sourceAccount:"main",account:"main",model:"gpt-6-astra",upstreamResponseObserved:true} as RequestRoute;
const routing={freshness:"fresh",active:[route],recent:[]} as unknown as RoutingSummary;
const metadata={threadId,sourceAccount:"retired",title:"My work",model:"old-model"};
function api(setTarget?: any){return new RequestAccountAPI(config,{accounts:()=>[],threads:()=>[metadata],targets:()=>[],setTarget});}
const labels=new Map([["other","Other"]]);
test("selection uses observed request source rather than physical metadata owner",async()=>{
 let input:any, options:any;
 const service=api(async(value:any,opts:any)=>{input=value;options=opts;return value;});
 const result=await service.choose({threadId,account:"other"},routing,["main"],labels);
 expect(input).toEqual({threadId,sourceAccount:"main",account:"other",model:"gpt-6-astra"});
 expect(result).toEqual({threadId,account:"other",label:"Other"});
 expect(options.pendingTurnId).toBe(route.turnId);
});
test("missing capability and stale observation cannot falsely report a saved choice",async()=>{
 let called=false;
 const service=api(async()=>{called=true;});
 await expect(service.choose({threadId,account:"other"},routing,[],labels)).rejects.toThrow("observer_unavailable");
 await expect(service.choose({threadId,account:"other"},{...routing,freshness:"stale"},["main"],labels)).rejects.toThrow("observer_unavailable");
 expect(called).toBe(false);
});
test("ambiguous sources and unseen threads cannot select another conversation",async()=>{
 const service=api();
 await expect(service.choose({threadId,account:"other"},{...routing,recent:[{...route,sourceAccount:"other"}]},["main","other"],labels)).rejects.toThrow("unknown_thread");
 await expect(service.choose({threadId,account:"other"},{...routing,active:[]},["main"],labels)).rejects.toThrow("unknown_thread");
});
test("extra caller supplied source and model are rejected",async()=>{
 await expect(api().choose({threadId,account:"other",sourceAccount:"other"},routing,["main"],labels)).rejects.toThrow("invalid_request");
});

test("verified quiet local conversations remain selectable without inventing past account attribution", async () => {
 let input:any;
 const service=new RequestAccountAPI(config,{accounts:()=>[],targets:()=>[],
   threads:()=>[{...metadata,hostAccount:"main",model:"gpt-6-astra"}],
   setTarget:async (value:any)=>{input=value;return value;}});
 const quiet={...routing,active:[],recent:[]};
 expect(service.read(quiet,labels).conversations[0]).toMatchObject({threadId,sourceAccount:"main",currentAccount:null});
 await service.choose({threadId,account:"other"},quiet,["main"],labels);
 expect(input.sourceAccount).toBe("main");
});

test("saved target remains recoverable after its route leaves recent telemetry", () => {
 const service=new RequestAccountAPI(config,{accounts:()=>[],threads:()=>[metadata],
   targets:()=>[{threadId,sourceAccount:"main",account:"other",model:"gpt-6-astra",selectedAtMs:1,revision:"saved"}]});
 expect(service.read({...routing,active:[],recent:[]},labels).conversations[0])
   .toMatchObject({threadId,sourceAccount:"main",targetAccount:"other",currentAccount:null});
});

import { supportedManualRoutingSources } from "../src/compaction-status";
test("mixed live listener versions cannot claim explicit routing support",()=>{
 const gen=(version:number)=>({reachable:true,health:{subscriptionGuardVersion:1,subscriptionGuard:{account:"main"},manualAccountRoutingVersion:version}});
 expect(supportedManualRoutingSources([gen(1),gen(0)])).toEqual([]);
 expect(supportedManualRoutingSources([gen(1),{reachable:true,health:{}}])).toEqual([]);
 expect(supportedManualRoutingSources([gen(1),gen(1)])).toEqual(["main"]);
 expect(supportedManualRoutingSources([gen(1),{...gen(0),reachable:false}])).toEqual(["main"]);
});

test("compaction model never replaces the conversation response model",async()=>{
 let input:any;
 await api(async(value:any)=>{input=value;return value;}).choose({threadId,account:"other"},
  {...routing,active:[{...route,kind:"compaction",model:"gpt-5.6-sol"},route]},["main"],labels);
 expect(input.model).toBe("gpt-6-astra");
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
test("request account endpoint requires local action authentication for reads and writes",async()=>{
 const root=mkdtempSync(join(tmpdir(),"qp-request-api-"));
 const c=loadConfig(join(root,"config.json")); c.dashboard.port=0;
 const service=new QuotaPieService(c,new QuotaDatabase(":memory:"));
 const server=startDashboard(service,c,{compactionRoot:root,poolDatabasePath:join(root,"pool.db"),requestAccountDatabasePath:join(root,"manual.db"),poolPolicyPath:join(root,"pool.json")});
 const origin=`http://127.0.0.1:${server.port}`;
 try{
  const status=await fetch(origin+"/api/status").then(r=>r.json()) as any;
  const headers={"x-quotapie-action-token":status.actionToken};
  expect((await fetch(origin+"/api/request-accounts")).status).toBe(403);
  expect((await fetch(origin+"/api/request-accounts",{headers:{...headers,origin:"https://example.invalid"}})).status).toBe(403);
  expect((await fetch(origin+"/api/request-accounts",{headers,method:"DELETE"})).status).toBe(405);
  expect((await fetch(origin+"/api/request-accounts",{headers,method:"POST",body:"{"})).status).toBe(400);
  expect((await fetch(origin+"/api/request-accounts",{headers,method:"POST",body:"x".repeat(2049)})).status).toBe(400);
  expect((await fetch(origin+"/api/request-accounts",{headers,method:"POST",body:JSON.stringify({threadId,account:"other"})})).status).toBe(409);
 }finally{server.stop(true);await service.close();rmSync(root,{recursive:true,force:true});}
});

test("pending legacy native fallback is granted only for an observed source response",async()=>{
 for (const patch of [{account:"other"},{upstreamResponseObserved:false},{attribution:"unknown"}]) {
  let options:any;
  await api(async(value:any,opts:any)=>{options=opts;return value;}).choose({threadId,account:"other"},
   {...routing,active:[{...route,...patch} as RequestRoute]},["main"],labels);
  expect(options.pendingTurnId).toBeNull();
 }
});


test("account list exposes the actual quota reason and credit consent stays independent of auto switching", () => {
 const root=mkdtempSync(join(tmpdir(),"qp-credit-policy-")), policyPath=join(root,"pool.json");
 const account:any={id:"other",identity:"b".repeat(64),tokenExpiresAt:Date.now()+600000,remaining:0,validUntil:Date.now()+600000};
 const service=new RequestAccountAPI(config,{policyPath,accounts:()=>[account],threads:()=>[],targets:()=>[]});
 try {
  savePoolPolicy({enabled:false,accounts:["main","other"],reservePercent:{other:10}},policyPath);
  expect(service.read(routing,labels).accounts[1]).toMatchObject({available:false,reason:"pool_manual_quota_exhausted",canAllowCredits:true,creditAllowed:false});
  service.configureCredits({account:"other",allow:true});
  expect(readPoolPolicy(policyPath)).toMatchObject({enabled:false,reservePercent:{other:10}});
  expect(service.read(routing,labels).accounts[1]).toMatchObject({available:true,reason:null,creditAllowed:true});
  configurePoolPolicy({enabled:true},policyPath);
  expect(service.read(routing,labels).accounts[1]!.creditAllowed).toBe(true);
  service.configureCredits({account:"other",allow:false});
  expect(service.read(routing,labels).accounts[1]).toMatchObject({available:false,creditAllowed:false});
  account.tokenExpiresAt=0;
  expect(service.read(routing,labels).accounts[1]).toMatchObject({reason:"pool_manual_authentication_unavailable",canAllowCredits:false});
  expect(()=>service.configureCredits({account:"other",allow:true})).toThrow("authentication_unavailable");
 } finally {rmSync(root,{recursive:true,force:true});}
});
import { savePoolPolicy, readPoolPolicy, configurePoolPolicy } from "../src/account-pool";

for (const phase of ["started", "failed"]) test(`a ${phase} request preserves prior confirmed account as history`, () => {
 const prior = { ...route, requestId: "prior", active: false, observedAtMs: 10 };
 const pending = { ...route, requestId: "new", phase, account: "other", upstreamResponseObserved: false, observedAtMs: 20 };
 const result = api().read({ ...routing, active: [pending], recent: [prior] }, labels).conversations[0];
 expect(result).toMatchObject({ currentAccount: "main", active: false });
});
test("conversation history survives eviction from the recent activity list", () => {
 const result = api().read({ ...routing, active: [], recent: [], history: [{...route, active: false}] }, labels).conversations[0];
 expect(result).toMatchObject({ currentAccount: "main", active: false });
});
test("unknown attribution cannot be promoted to a confirmed account", () => {
 expect(api().read({ ...routing, active: [{ ...route, attribution: "unknown" }] }, labels).conversations[0]?.currentAccount).toBeNull();
});
