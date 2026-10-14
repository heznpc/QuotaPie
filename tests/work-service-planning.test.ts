import {test,expect} from "bun:test";
import {loadConfig} from "../src/config";
import {QuotaDatabase} from "../src/db";
import {QuotaPieService} from "../src/service";
import {startDashboard} from "../src/server";
import {classifyPost} from "../src/signals/classify";
import type {WorkPolicyInput} from "../src/work/types";
import type {WindowAnalysis} from "../src/types";

function fixture() {
 const config=loadConfig();config.dashboard.port=0;config.alerts.enabled=true;
 const service=new QuotaPieService(config,new QuotaDatabase(":memory:"));
 const now=Date.now();const signal=classifyPost({id:"service-planning",author:"thsottiaux",text:"Global reset landing by EOD",
 createdAtMs:now-60_000,conversationId:"service-planning",references:[]},new Map())!;
 service.resetSignals.save([signal],now);service.resetTiming.sync([signal],[],[{provider:"codex",account:"default"}],now);
 const policy:WorkPolicyInput={id:"plan",provider:"codex",account:"default",profileKey:"profile",accountKey:"account",nativeSessionId:"session",cwd:"/tmp",
 prompt:"continue",objective:"verify",completionCriteria:["evidence"],dispatchOwner:"local",enabled:true,trigger:"forecast-probability",resetBucket:"codex:weekly",resetWithinMinutes:60,
 budgetByBucket:{"codex:weekly":{reservePercent:0,maxUsagePercent:10}},maxTurns:2,maxDurationSeconds:60,maxTotalDurationSeconds:120,expiresAtMs:now+3600000,priority:0,onReset:"stop",
 expectedWorkMinutes:20,finishBufferMinutes:5,startProbability:0.7,unknownForecastAction:"announcement"};
 service.work.deps.windows=()=>[{provider:"codex",account:"default",bucket:"codex:weekly",remainingPercent:50,reservePercent:0,resetsAtMs:now+86400000,
 observedAtMs:now,quality:"authoritative",freshness:"fresh"} as WindowAnalysis];
 service.work.deps.minimumReserveByBucket=()=>({});service.work.deps.legacyBusy=()=>false;
 service.work.deps.inspect=async()=>({profileKey:"profile",accountKey:"account",cwd:"/tmp"});
 return {config,service,now,policy,signal};
}
test("service connects policy horizon to durable forecast and uses selected unknown fallback",async()=>{
 const {service,policy,now}=fixture();
 try {
 service.work.store.save(policy,null,"save");
 const first=service.work.list()[0]!;expect(first.admission.ready).toBe(true);
 const forecasts=service.resetTiming.listForecasts();expect(forecasts).toHaveLength(1);
 expect(forecasts[0]!.policyId).toBe(policy.id);expect(forecasts[0]!.policyVersion).toBe(1);
 expect(forecasts[0]!.horizonAtMs-now).toBeGreaterThanOrEqual(25*60000);
 expect(forecasts[0]!.actionProbabilityEstimate).toBeNull();
 service.work.list();expect(service.resetTiming.listForecasts()).toHaveLength(1);
 service.work.store.save({...policy,unknownForecastAction:"wait"},1,"wait");
 expect(service.work.list()[0]!.admission.reason).toBe("forecast-unavailable");
 expect(service.work.store.executions()).toHaveLength(0);
 }finally{await service.close();}
});
test("notify-only uses durable dedup and never dispatches, muting applies independently",async()=>{
 const {service,policy}=fixture();let notices=0;
 try {
 service.work.store.save({...policy,trigger:"notify-only"},null,"save");
 (service as any).deliverDecision=async()=>{notices++;return {complete:true,succeededChannels:[]};};
 await service.deliverWorkNotifications();await service.deliverWorkNotifications();
 expect(notices).toBe(1);expect(service.work.store.executions()).toHaveLength(0);
 service.work.store.save({...policy,trigger:"notify-only"},1,"edit");service.config.alerts.topics.resumeReady=false;
 await service.deliverWorkNotifications();expect(notices).toBe(1);
 service.config.alerts.topics.resumeReady=true;await service.deliverWorkNotifications();expect(notices).toBe(2);
 }finally{await service.close();}
});
test("preferences HTTP route validates scope and is shared with the collector",async()=>{
 const {service,config}=fixture();const server=startDashboard(service,config);const base=`http://127.0.0.1:${server.port}`;
 try {
 const {actionToken}=await(await fetch(base+"/api/status")).json() as any;
 const headers={"x-quotapie-action-token":actionToken,"content-type":"application/json"};
 expect((await fetch(base+"/api/work/preferences")).status).toBe(403);
 const saved=await fetch(base+"/api/work/preferences",{method:"POST",headers,body:JSON.stringify({scope:"global",values:{expectedWorkMinutes:17},expectedRevision:null})});
 expect(saved.status).toBe(200);expect(service.work.store.preferences()[0]!.values.expectedWorkMinutes).toBe(17);
 const read=await(await fetch(base+"/api/work/preferences",{headers})).json() as any;expect(read.preferences[0].revision).toBe(1);
 const invalid=await fetch(base+"/api/work/preferences",{method:"POST",headers,body:JSON.stringify({scope:"account",provider:"codex",account:"not-configured",values:{},expectedRevision:null})});
 expect(invalid.status).toBe(409);
 }finally{server.stop(true);await service.close();}
});

test("short task learning window cannot prune shared timing history",async()=>{
 const {service,policy}=fixture();
 try {
 service.work.store.save({...policy,timingHistoryDays:7},null,"save");
 let retention=0;
 service.resetTiming.setRetentionDays=(days:number)=>{retention=days;};
 service.refreshResetTiming();
 expect(service.resetTimingStatus().error).toBeNull();expect(retention).toBe(365);
 }finally{await service.close();}
});
