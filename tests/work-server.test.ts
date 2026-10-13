import {test,expect} from "bun:test";
import {loadConfig} from "../src/config";
import {QuotaDatabase} from "../src/db";
import {QuotaPieService} from "../src/service";
import {startDashboard} from "../src/server";
import {createSharedWorkClient} from "../src/dots/work-client";
import type {WindowAnalysis} from "../src/types";

test("actual HTTP Dots settings and app reads use one policy, revision and execution ledger",async()=>{
 const config=loadConfig();config.dashboard.port=0;config.dashboard.host="127.0.0.1";
 const service=new QuotaPieService(config,new QuotaDatabase(":memory:"));
 const now=Date.now();let calls=0;
 service.work.deps.windows=()=>[{provider:"claude",account:"default",bucket:"five_hour",remainingPercent:50,reservePercent:10,resetsAtMs:now+3600000,observedAtMs:now,quality:"authoritative",freshness:"fresh"} as WindowAnalysis];
 service.work.deps.inspect=async()=>({profileKey:"profile",accountKey:"account",cwd:"/tmp",model:"original-model"});
 service.work.deps.execute=async(_p,_id,authorized)=>{expect(authorized()).toBe(true);calls++;return {status:"turn-finished",remainingWork:"one more step",summary:"useful result"};};
 const server=startDashboard(service,config);config.dashboard.port=server.port!;
 const base=`http://127.0.0.1:${server.port}`;
 try{
  expect((await fetch(base+"/api/work")).status).toBe(403);
  const client=createSharedWorkClient(config);
  const saved=await client.save({action:"save",requestId:"create",expectedRevision:null,policy:{id:"shared",provider:"claude",account:"default",nativeSessionId:"session",prompt:"continue",objective:"task",completionCriteria:["proof"],dispatchOwner:"dots",enabled:false,trigger:"quota-ready",resetWithinMinutes:60,budgetByBucket:{five_hour:{reservePercent:0,maxUsagePercent:20}},maxTurns:3,maxDurationSeconds:60,maxTotalDurationSeconds:120,expiresAtMs:now+3600000,priority:0,onReset:"stop"}}) as any;
  expect(saved.policy.revision).toBe(1);
  const {actionToken}=await (await fetch(base+"/api/status")).json() as any;
  const headers={"x-quotapie-action-token":actionToken,"content-type":"application/json"};
  const app=await(await fetch(base+"/api/work",{headers})).json() as any;
  expect(app.policies[0].id).toBe("shared");expect(app.policies[0].budgetByBucket.five_hour.reservePercent).toBe(0);
  expect((await fetch(base+"/api/work",{headers:{...headers,origin:"https://untrusted.example"}})).status).toBe(403);
  const enabled=await(await fetch(base+"/api/work",{method:"POST",headers,body:JSON.stringify({action:"enabled",id:"shared",enabled:true,expectedRevision:1,requestId:"enable"})})).json() as any;
  expect(enabled.policy.revision).toBe(2);expect((await client.list()).policies[0]!.enabled).toBe(true);
  const first=await client.execute({id:"shared",expectedRevision:2,requestId:"one"}) as any;
  await service.work.settle();
  const retry=await client.execute({id:"shared",expectedRevision:2,requestId:"one"}) as any;
  expect(first.execution.id).toBe(retry.execution.id);expect(calls).toBe(1);
  const final=await client.list();expect(final.policies[0]!.state.turns).toBe(1);
  expect((final.executions as any[])[0].owner).toBe("dots");
 }finally{server.stop(true);await service.close();}
});
