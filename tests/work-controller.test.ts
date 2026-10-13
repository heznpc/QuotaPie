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
