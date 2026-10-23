import {expect,test} from "bun:test";
import {DEFAULT_CONFIG} from "../src/config";
import {QuotaStorage} from "../src/storage/database";
import {WorkStore} from "../src/work/store";
import {WorkController} from "../src/work/controller";
import {executionPoolPolicyHash,validExecutionTarget} from "../src/work/execution-target";
import {selectQuotaExecutionTarget,selectLocalRepairExecutionTarget,validateQuotaExecutionTarget,type ExecutionTargetAccounts} from "../src/work/execution-target-selection";
import type {WorkExecutionTarget,WorkPolicy,WorkResult} from "../src/work/types";
import type {WindowAnalysis} from "../src/types";

const NOW=2_000_000_000_000, THREAD="11111111-1111-4111-8111-111111111111", FAILED="22222222-2222-4222-8222-222222222222";
const hash=(n:number)=>String(n).repeat(64), bucket="codex:primary:300";
function policy():WorkPolicy{return {id:"incident-a",provider:"codex",account:"a",profileKey:hash(1),accountKey:hash(2),
 purpose:"quota-resume",quotaResume:{turnId:FAILED,stamp:"rollout-stamp",waitUntilRecovered:true},nativeSessionId:THREAD,cwd:"/tmp",model:"gpt-6.1-sol",
 prompt:"[QuotaPie quota recovery:incident-a]\nContinue once",objective:"continue",completionCriteria:["same session"],dispatchOwner:"local",enabled:true,
 trigger:"quota-ready",resetWithinMinutes:0,budgetByBucket:{[bucket]:{reservePercent:0,maxUsagePercent:20}},maxTurns:1,maxDurationSeconds:30,maxTotalDurationSeconds:30,
 expiresAtMs:NOW+3600000,priority:0,onReset:"continue",revision:1,state:{spentByBucket:{},baselines:{},turns:0,totalDurationSeconds:0,status:"waiting",activeExecutionId:null}};}
function fixture(){
 const window=(account:string,remaining:number)=>({provider:"codex",account,bucket,remainingPercent:remaining,reservePercent:0,resetsAtMs:NOW+3600000,
   observedAtMs:NOW,quality:"authoritative",freshness:"fresh",metadata:{ordinaryUsageAllowed:remaining>0}} as unknown as WindowAnalysis);
 const input:ExecutionTargetAccounts={pool:{enabled:true,accounts:["a","b","c"]},nowMs:NOW,maxAgeMs:120000,
  windows:[window("a",0),window("b",80),window("c",60)],binding:account=>account==="a"?{profileKey:hash(1),accountKey:hash(2)}:account==="b"?{profileKey:hash(3),accountKey:hash(4)}:{profileKey:hash(5),accountKey:hash(6)},
  accounts:["a","b","c"].map((id,i)=>({id,label:id,identity:hash(i+7),accessToken:"never-used",upstreamAccount:id,tokenExpiresAt:NOW+3600000,
    models:["gpt-6.1-sol"],remaining:id==="a"?0:id==="b"?80:60,validUntil:NOW+120000}))};
 const p=policy(),db=new QuotaStorage(":memory:"),store=new WorkStore(db);store.save(p,null,"save");
 let calls=0,end!:(result:WorkResult)=>void,check:()=>boolean=()=>false,seenTarget:WorkExecutionTarget|undefined,seenPolicy:WorkPolicy|undefined;
 const result=new Promise<WorkResult>(resolve=>end=resolve);
 const c=new WorkController(store,structuredClone(DEFAULT_CONFIG),{now:()=>input.nowMs,windows:()=>input.windows,announcement:()=>false,legacyBusy:()=>false,
   executionTarget:source=>selectQuotaExecutionTarget(source,input),validateExecutionTarget:(source,target)=>validateQuotaExecutionTarget(source,target,input),
   prepareExecutionTarget:async()=>{},
   inspect:async source=>({profileKey:source.profileKey,accountKey:source.accountKey,cwd:source.cwd,model:source.model}),
   execute:async(source,_id,authorized,_signal,target)=>{calls++;seenPolicy=source;seenTarget=target;check=authorized;return result;}});
 return {input,p,db,store,c,get calls(){return calls},get seenPolicy(){return seenPolicy},get seenTarget(){return seenTarget},check:()=>check(),
  end:async()=>{end({status:"turn-finished",remainingWork:"unknown"});await c.settle();await c.close();db.close();}};
}
test("a recovered login does not replace the history account during automatic continuation",async()=>{
 const f=fixture();try{
  f.input.continuationAccount=()=>"b";
  f.input.windows[0]!.remainingPercent=100;f.input.windows[0]!.metadata!.ordinaryUsageAllowed=true;
  f.input.accounts[0]!.remaining=100;
  f.input.accounts[2]!.remaining=95;
  const e=await f.c.dispatch(f.p.id,"local",1,"recovered-source");
  expect(e.executionTarget?.account).toBe("b");expect(f.seenTarget?.account).toBe("b");
  expect(f.seenPolicy?.account).toBe("a");expect(f.calls).toBe(1);
 }finally{await f.end();}
});

test("A exhausted session claims B once; A recovery cannot change target or charge A",async()=>{
 const f=fixture();try{
  const e=await f.c.dispatch(f.p.id,"local",1,"request");
  expect(f.calls).toBe(1);expect(f.seenPolicy?.account).toBe("a");expect(f.seenPolicy?.nativeSessionId).toBe(THREAD);expect(f.seenTarget?.account).toBe("b");
  expect(e.executionTarget?.account).toBe("b");expect(f.check()).toBe(true);
  f.input.nowMs+=1000;for(const w of f.input.windows)w.observedAtMs=f.input.nowMs;
  f.input.windows[0]!.remainingPercent=100;f.input.windows[0]!.metadata!.ordinaryUsageAllowed=true;
  f.input.windows[1]!.remainingPercent=75;
  expect(f.check()).toBe(true);expect(f.store.getExecution(e.id)?.executionTarget?.account).toBe("b");
  expect(f.store.getExecution(e.id)?.targetAccounting?.spentByBucket[bucket]).toBe(5);
  expect(f.store.get(f.p.id)?.state.spentByBucket[bucket]??0).toBe(0);
  expect((await f.c.dispatch(f.p.id,"local",1,"request")).id).toBe(e.id);expect(f.calls).toBe(1);
 }finally{await f.end()}
});
test("B exhaustion or stale/denied identity cancels authorization without C or recovered A fallback",async()=>{
 for(const mutation of ["exhausted","stale","identity","policy","denied"]){
  const f=fixture();try{
   const e=await f.c.dispatch(f.p.id,"local",1,"request");
   f.input.windows[0]!.remainingPercent=100;f.input.windows[0]!.metadata!.ordinaryUsageAllowed=true;
   if(mutation==="exhausted")f.input.windows[1]!.remainingPercent=0;
   if(mutation==="stale")f.input.nowMs+=120001;
   if(mutation==="identity")f.input.accounts[1]!.identity=hash(0);
   if(mutation==="policy")f.input.pool.enabled=false;
   if(mutation==="denied")f.input.windows[1]!.metadata!.ordinaryUsageAllowed=false;
   expect(f.check()).toBe(false);expect(f.store.getExecution(e.id)?.executionTarget?.account).toBe("b");expect(f.calls).toBe(1);
  }finally{await f.end()}
 }
});
test("unknown B and C quota or identity cannot create a dispatch",async()=>{
 for(const mutation of ["stale","denied","identity","disabled"]){
  const f=fixture();try{
   f.input.pool.accounts=["a","b"];
   if(mutation==="stale")f.input.windows[1]!.freshness="stale";
   if(mutation==="denied")f.input.windows[1]!.metadata!.ordinaryUsageAllowed=false;
   if(mutation==="identity")f.input.binding=()=>null;
   if(mutation==="disabled")f.input.pool.enabled=false;
   await expect(f.c.dispatch(f.p.id,"local",1,"request")).rejects.toThrow();expect(f.store.executions()).toHaveLength(0);expect(f.calls).toBe(0);
  }finally{await f.end()}
 }
});
test("target account participates in shared claims and all restart retries remain fenced",async()=>{
 const f=fixture();try{
  const e=await f.c.dispatch(f.p.id,"local",1,"request");
  const other={...f.p,id:"other",account:"c",accountKey:hash(6),profileKey:hash(5),nativeSessionId:"44444444-4444-4444-8444-444444444444"};
  f.store.save(other,null,"other-save");
  expect(f.store.claim(other.id,"local",1,NOW,{...e.executionTarget!,sourceIdentity:hash(9)})).toBeNull();
  const restarted=new WorkController(f.store,structuredClone(DEFAULT_CONFIG),f.c.deps);
  expect((await restarted.dispatch(f.p.id,"local",1,"request")).id).toBe(e.id);
  await expect(restarted.dispatch(f.p.id,"local",1,"another-request")).rejects.toThrow();expect(f.calls).toBe(1);await restarted.close();
 }finally{await f.end()}
});
test("newer user input or changed source binding at final inspect never enqueues",async()=>{
 const f=fixture();try{
  f.c.deps.inspect=async()=>{throw new Error("auto-resume-superseded")};
  await expect(f.c.dispatch(f.p.id,"local",1,"request")).rejects.toThrow("auto-resume-superseded");expect(f.calls).toBe(0);expect(f.store.executions()).toHaveLength(0);
 }finally{await f.end()}
});
test("unavailable native relay holds before the one continuation attempt and may recover on a later tick",async()=>{
 const f=fixture();try{
  f.c.deps.prepareExecutionTarget=async()=>{throw new Error("execution-target-native-route-unverified")};
  const held=await f.c.dispatch(f.p.id,"local",1,"first");await f.c.settle();
  expect(f.calls).toBe(0);expect(f.store.get(f.p.id)).toMatchObject({enabled:true,state:{turns:0,status:"waiting",activeExecutionId:null}});
  expect(f.store.getExecution(held.id)?.dispatchedAtMs).toBeUndefined();
  expect(f.c.admission(f.store.get(f.p.id)!).reason).toBe("execution-target-native-route-unverified");
  expect((await f.c.dispatch(f.p.id,"local",1,"first")).id).toBe(held.id);expect(f.calls).toBe(0);
  f.input.nowMs+=30001;for(const w of f.input.windows)w.observedAtMs=f.input.nowMs;
  f.c.deps.prepareExecutionTarget=async()=>{};
  await f.c.dispatch(f.p.id,"local",1,"later");expect(f.calls).toBe(1);
 }finally{await f.end()}
});
test("target policy hash includes reserves and account membership independently of ordering",()=>{
 expect(executionPoolPolicyHash({enabled:true,accounts:["a","b"]})).toBe(executionPoolPolicyHash({enabled:true,accounts:["b","a"]}));
 expect(executionPoolPolicyHash({enabled:true,accounts:["a","b"],reservePercent:{b:10}})).not.toBe(executionPoolPolicyHash({enabled:true,accounts:["a","b"]}));
});


test("a proven unsent local repair selects fresh B or C without changing its source session",async()=>{
 const f=fixture();try{
  const prior=selectQuotaExecutionTarget(f.p,f.input)!;
  f.input.windows[0]!.remainingPercent=100;f.input.windows[0]!.metadata!.ordinaryUsageAllowed=true;
  expect(selectQuotaExecutionTarget(f.p,f.input)).toBeNull();
  f.p.quotaResume!.localBeforeSendRecovery={permitId:"a".repeat(64),parentExecutionId:THREAD,sourceQuotaTurnId:FAILED};
  expect(selectLocalRepairExecutionTarget(f.p,prior,f.input)?.account).toBe("b");
  f.input.windows[1]!.remainingPercent=0;
  expect(selectLocalRepairExecutionTarget(f.p,prior,f.input)?.account).toBe("c");
  f.input.windows[2]!.remainingPercent=0;
  expect(selectLocalRepairExecutionTarget(f.p,prior,f.input)).toBeNull();
  f.input.accounts[0]!.remaining=100;
  const recovered=selectLocalRepairExecutionTarget(f.p,prior,f.input)!;
  expect(recovered.account).toBe("a");
  expect(validExecutionTarget(f.p,recovered,NOW)).toBe(true);
  expect(validExecutionTarget({...f.p,quotaResume:{...f.p.quotaResume!,localBeforeSendRecovery:undefined}},recovered,NOW)).toBe(false);
  expect(validExecutionTarget(f.p,{...recovered,profileKey:hash(0)},NOW)).toBe(false);
  expect(validExecutionTarget(f.p,{...recovered,accountKey:hash(0)},NOW)).toBe(false);
  expect(validExecutionTarget(f.p,{...recovered,identity:hash(0)},NOW)).toBe(false);
  f.input.windows[1]!.remainingPercent=80;f.input.pool.accounts=["a","b"];
  expect(selectLocalRepairExecutionTarget(f.p,prior,f.input)).toBeNull();
  f.input.pool.accounts=["a","b","c"];f.input.accounts[0]!.identity="changed";
  expect(selectLocalRepairExecutionTarget(f.p,prior,f.input)).toBeNull();
 }finally{await f.end()}
});

test("consolidated B keeps consent while primary A hosts and fresh B, A or C supplies an explicit target",async()=>{
 const f=fixture();try{
  const p={...f.p,account:"b",profileKey:hash(3),accountKey:hash(4)};
  const owner={account:"a",profileKey:hash(1),accountKey:hash(2),identity:hash(7),manifestSHA256:hash(0)};
  f.input.sessionOwner=()=>owner;
  // B is already usable: a moved session still requires a frozen lease on A.
  const first=selectQuotaExecutionTarget(p,f.input)!;
  expect(first.account).toBe("b");expect(first.sourceIdentity).toBe(hash(7));expect(first.sessionOwner).toEqual(owner);
  expect(validExecutionTarget(p,first,NOW)).toBe(true);expect(validateQuotaExecutionTarget(p,first,f.input)).toBeNull();
  expect(p.account).toBe("b");expect(p.nativeSessionId).toBe(THREAD);
  f.input.accounts[0]!.remaining=100;f.input.windows[0]!.remainingPercent=100;f.input.windows[0]!.metadata!.ordinaryUsageAllowed=true;
  const primary=selectQuotaExecutionTarget(p,f.input)!;
  expect(primary.account).toBe("a");expect(validExecutionTarget(p,primary,NOW)).toBe(true);
  f.input.windows[0]!.remainingPercent=0;f.input.windows[1]!.remainingPercent=0;
  expect(selectQuotaExecutionTarget(p,f.input)?.account).toBe("c");
  f.input.sessionOwner=()=>({...owner,manifestSHA256:hash(9)});
  expect(validateQuotaExecutionTarget(p,first,f.input)).toBe("execution-target-session-owner-changed");
  f.input.sessionOwner=()=>null;
  expect(selectQuotaExecutionTarget(p,f.input)).toBeNull();
  expect(validateQuotaExecutionTarget(p,first,f.input)).toBe("execution-target-session-owner-changed");
  f.input.sessionOwner=()=>({...owner,manifestSHA256:undefined});
  expect(selectQuotaExecutionTarget(p,f.input)).toBeNull();
 }finally{await f.end()}
});
