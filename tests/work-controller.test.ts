import {test,expect} from "bun:test";
import {QuotaStorage} from "../src/storage/database";
import {WorkStore} from "../src/work/store";
import {WorkController} from "../src/work/controller";
import {loadConfig} from "../src/config";
import type {WorkPolicyInput,WorkResult} from "../src/work/types";
import type {WindowAnalysis} from "../src/types";
const NOW=Date.now();
const input=(owner:"local"|"dots"="local"):WorkPolicyInput=>({id:"work",provider:"claude",account:"default",profileKey:"profile",accountKey:"identity",nativeSessionId:"session",cwd:"/tmp",prompt:"work",objective:"task",completionCriteria:["proof"],dispatchOwner:owner,enabled:true,trigger:"quota-ready",budgetByBucket:{five_hour:{reservePercent:0,maxUsagePercent:20}},resetWithinMinutes:60,maxTurns:1,maxDurationSeconds:30,maxTotalDurationSeconds:60,expiresAtMs:NOW+3600000,priority:0,onReset:"stop"});
const window=()=>({provider:"claude",account:"default",bucket:"five_hour",remainingPercent:50,reservePercent:10,resetsAtMs:NOW+3600000,observedAtMs:NOW,quality:"authoritative",freshness:"fresh"} as WindowAnalysis);
test("Dots and local share a durable single-use dispatch including racing HTTP retries",async()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db); let calls=0;
 let release!:()=>void; const barrier=new Promise<void>(r=>release=r);
 const c=new WorkController(store,loadConfig(),{now:()=>NOW,windows:()=>[window()],announcement:()=>false,legacyBusy:()=>false,
 inspect:async()=>{await barrier;return {profileKey:"profile",accountKey:"identity",cwd:"/tmp"};},
 execute:async(_p,_id,authorized)=>{calls++;expect(authorized()).toBe(true);return {status:"objective-completed",summary:"done",evidenceRefs:["test"],completionAssessment:"machine"};}});
 store.save(input("dots"),null,"save");
 const a=c.dispatch("work","dots",1,"request"),b=c.dispatch("work","dots",1,"request");release();
 const [first,second]=await Promise.all([a,b]); await c.settle();
 expect(first.id).toBe(second.id);expect(calls).toBe(1);expect(store.executions()).toHaveLength(1);
 expect(store.get("work")!.state.turns).toBe(1);expect(store.get("work")!.enabled).toBe(false);
 expect((await c.dispatch("work","dots",1,"request")).id).toBe(first.id);expect(calls).toBe(1);
 await c.close();db.close();
});
test("changing dispatch owner preserves usage and cannot replay a running claim",async()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);let calls=0;
 let end!:(r:WorkResult)=>void;const result=new Promise<WorkResult>(r=>end=r);
 const c=new WorkController(store,loadConfig(),{now:()=>NOW,windows:()=>[window()],announcement:()=>false,legacyBusy:()=>false,
 inspect:async()=>({profileKey:"profile",accountKey:"identity",cwd:"/tmp"}),execute:async()=>{calls++;return result;}});
 store.save({...input(),maxTurns:3},null,"save");await c.dispatch("work","local",1,"one");
 expect(()=>store.save({...input("dots"),maxTurns:3},1,"change-active")).toThrow();
 await expect(c.dispatch("work","dots",1,"two")).rejects.toThrow();
 end({status:"turn-finished",remainingWork:"remaining task"});await c.settle();
 store.save({...input("dots"),maxTurns:3},1,"change");
 expect(store.get("work")!.state.turns).toBe(1);expect(calls).toBe(1);await c.close();db.close();
});
test("a stale authoritative observation and a legacy execution both hold dispatch",async()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);let legacy=false;
 const config=loadConfig();config.collection.staleAfterSeconds=120;
 const c=new WorkController(store,config,{now:()=>NOW+360000,windows:()=>[window()],announcement:()=>true,legacyBusy:()=>legacy,
 inspect:async()=>({profileKey:"profile",accountKey:"identity",cwd:"/tmp"}),execute:async()=>{throw new Error("must not execute");}});
 store.save(input(),null,"save");expect(c.list()[0]!.admission.ready).toBe(false);
 await expect(c.dispatch("work","local",1,"one")).rejects.toThrow();legacy=true;
 expect(c.list()[0]!.admission.reason).toBe("legacy-work-active");expect(store.executions()).toHaveLength(0);await c.close();db.close();
});
test("Codex task reserve overrides a preference, explicit account restriction still wins",async()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);let mandatory=0;
 const p={...input(),provider:"codex" as const,budgetByBucket:{"codex:weekly":{reservePercent:0,maxUsagePercent:20}}};
 const w={...window(),provider:"codex" as const,bucket:"codex:weekly",remainingPercent:1,reservePercent:15};
 const c=new WorkController(store,loadConfig(),{now:()=>NOW,windows:()=>[w],announcement:()=>false,legacyBusy:()=>false,minimumReserveByBucket:()=>({"codex:weekly":mandatory}),
 inspect:async()=>({profileKey:"profile",accountKey:"identity",cwd:"/tmp"}),execute:async()=>({status:"turn-finished",remainingWork:"more"})});
 store.save(p,null,"save");expect(c.list()[0]!.admission.ready).toBe(true);mandatory=2;expect(c.list()[0]!.admission.reason).toBe("reserve-reached");
 await c.close();db.close();
});
test("preconfigured defaults inherit global then provider then account without changing task authority",()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 store.savePreferences("global",undefined,undefined,{expectedWorkMinutes:30,finishBufferMinutes:3},null);
 store.savePreferences("provider","claude",undefined,{expectedWorkMinutes:20},null);
 store.savePreferences("account","claude","default",{expectedWorkMinutes:10},null);
 const resolved=store.resolvePreferences({...input(),finishBufferMinutes:0});
 expect(resolved.input.expectedWorkMinutes).toBe(10);expect(resolved.input.finishBufferMinutes).toBe(0);
 expect(resolved.effectivePreferences.expectedWorkMinutes).toBe("account");expect(resolved.effectivePreferences.finishBufferMinutes).toBe("task");
 expect(resolved.input.enabled).toBe(true);expect(resolved.input.dispatchOwner).toBe("local");
 expect(()=>store.savePreferences("global",undefined,undefined,{enabled:true} as any,1)).toThrow("work-invalid-preferences");
 expect(()=>store.savePreferences("global",undefined,undefined,{startProbability:2},1)).toThrow("work-invalid-probability");
 expect(()=>store.savePreferences("global",undefined,undefined,{expectedWorkMinutes:5},null)).toThrow("work-revision-conflict");
 db.close();
});
test("clearing an inherited preference on an existing policy does not reintroduce the default",async()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 store.savePreferences("global",undefined,undefined,{expectedWorkMinutes:10},null);
 const c=new WorkController(store,loadConfig(),{now:()=>NOW,windows:()=>[window()],announcement:()=>false,legacyBusy:()=>false,
 inspect:async()=>({profileKey:"profile",accountKey:"identity",cwd:"/tmp"}),execute:async()=>({status:"turn-finished",remainingWork:"more"})});
 const saved=await c.save(input(),null,"save");expect(saved.expectedWorkMinutes).toBe(10);
 const edited={...saved};delete edited.expectedWorkMinutes;
 const after=await c.save(edited,1,"edit");expect(after.expectedWorkMinutes).toBeUndefined();
 await c.close();db.close();
});
test("forecast trigger requires a selected budgeted reset bucket",()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 expect(()=>store.save({...input(),trigger:"forecast-probability"},null,"missing")).toThrow("work-forecast-bucket-required");
 expect(()=>store.save({...input(),trigger:"forecast-probability",resetBucket:"seven_day"},null,"unbudgeted")).toThrow("work-forecast-bucket-required");
 expect(store.save({...input(),trigger:"forecast-probability",resetBucket:"five_hour"},null,"selected").resetBucket).toBe("five_hour");
 db.close();
});
test("personal deadline fallback cannot be saved without a chosen planning assumption",()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 expect(()=>store.save({...input(),unknownForecastAction:"personal-deadline"},null,"missing")).toThrow("work-personal-deadline-required");
 expect(()=>store.save({...input(),unknownForecastAction:"personal-deadline",personalDeadline:NOW+10000},null,"not-opted-in")).toThrow("work-personal-deadline-required");
 expect(store.save({...input(),unknownForecastAction:"personal-deadline",personalDeadline:NOW+10000,usePersonalDeadlineForPlanning:true},null,"selected").personalDeadline).toBe(NOW+10000);
 db.close();
});
test("planning settings reject unsupported quantile and fractional history duration before execution",()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 expect(()=>store.save({...input(),earlyResetQuantile:1},null,"quantile")).toThrow("work-invalid-probability");
 expect(()=>store.save({...input(),timingHistoryDays:1.5},null,"history")).toThrow("work-invalid-planning");
 expect(()=>store.savePreferences("global",undefined,undefined,{timingHistoryDays:1.5},null)).toThrow("work-invalid-planning");
 db.close();
});
test("global budget defaults stay within the task provider namespace and preserve explicit overrides",()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 store.savePreferences("global",undefined,undefined,{budgetByBucket:{
  "codex:primary:300":{reservePercent:15,maxUsagePercent:20},
  "gpt-6:secondary:10080":{reservePercent:10,maxUsagePercent:25},
  seven_day_opus:{reservePercent:5,maxUsagePercent:10},five_hour:{reservePercent:5,maxUsagePercent:10},seven_day:{reservePercent:10,maxUsagePercent:30},
  legacy:{reservePercent:3,maxUsagePercent:10},
 }},null);
 const claude=store.resolvePreferences(input()).input;
 expect(Object.keys(claude.budgetByBucket).sort()).toEqual(["five_hour","seven_day"]);
 expect(claude.budgetByBucket.five_hour!.reservePercent).toBe(0);
 const codex=store.resolvePreferences({...input(),provider:"codex",model:"gpt-6",budgetByBucket:{"codex:primary:300":{reservePercent:0,maxUsagePercent:5}}}).input;
 expect(Object.keys(codex.budgetByBucket).sort()).toEqual(["codex:primary:300","gpt-6:secondary:10080"]);
 expect(codex.budgetByBucket["codex:primary:300"]!.maxUsagePercent).toBe(5);
 const codexGeneral=store.resolvePreferences({...input(),provider:"codex",budgetByBucket:{"codex:primary:300":{reservePercent:0,maxUsagePercent:5}}}).input;
 expect(Object.keys(codexGeneral.budgetByBucket)).toEqual(["codex:primary:300"]);
 const missing={...input()};delete (missing as Partial<WorkPolicyInput>).budgetByBucket;
 expect(Object.keys(store.resolvePreferences(missing).input.budgetByBucket).sort()).toEqual(["five_hour","seven_day"]);
 const legacy=store.resolvePreferences({...input(),budgetByBucket:{legacy:{reservePercent:0,maxUsagePercent:1}}}).input;
 expect(legacy.budgetByBucket.legacy!.reservePercent).toBe(0);
 db.close();
});
test("registration resolves model defaults from the inspected session, never a client model override",async()=>{
 const db=new QuotaStorage(":memory:"),store=new WorkStore(db);
 store.savePreferences("global",undefined,undefined,{budgetByBucket:{seven_day_opus:{reservePercent:5,maxUsagePercent:10},seven_day_sonnet:{reservePercent:5,maxUsagePercent:10}}},null);
 const c=new WorkController(store,loadConfig(),{now:()=>NOW,windows:()=>[window(),{...window(),bucket:"seven_day_opus"}],announcement:()=>false,legacyBusy:()=>false,
 inspect:async()=>({profileKey:"profile",accountKey:"identity",cwd:"/tmp",model:"claude-opus-4-6"}),execute:async()=>({status:"turn-finished",remainingWork:"more"})});
 const saved=await c.save(input(),null,"session-model");
 expect(saved.model).toBe("claude-opus-4-6");expect(saved.budgetByBucket.seven_day_opus!.maxUsagePercent).toBe(10);
 expect(saved.budgetByBucket.seven_day_sonnet).toBeUndefined();
 expect(saved.preferenceSources?.budgetByBucket).toBe("task"); // task five_hour overrides its own lane
 const attempted=await c.save({...input(),id:"override",model:"claude-sonnet-4-6"},null,"client-model");
 expect(attempted.model).toBe("claude-opus-4-6");expect(attempted.budgetByBucket.seven_day_opus).toBeDefined();
 expect(attempted.budgetByBucket.seven_day_sonnet).toBeUndefined();
 await c.close();db.close();
});
