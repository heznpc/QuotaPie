import { expect, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { hostQueueClientMessageId, type HostQueueReceipt } from "../src/quota-resume/host-queue";
import type { ExecutionTargetLease } from "../src/work/execution-target-lease";
import { reconcileNativeTargetResult } from "../src/work/native-target-lease";
import type { WorkExecutionTarget, WorkPolicy, WorkResult } from "../src/work/types";

const executionId="44444444-4444-4444-8444-444444444444", threadId="11111111-1111-4111-8111-111111111111",
  failedTurnId="22222222-2222-4222-8222-222222222222", turnId="33333333-3333-4333-8333-333333333333";
const hash=(n:number)=>String(n).repeat(64);
const finished:WorkResult={status:"turn-finished",summary:"1회 재개 종료",durationSeconds:23};

function fixture() {
  const policy={id:"incident",revision:1,account:"a",profileKey:hash(1),accountKey:hash(2),
    nativeSessionId:threadId,quotaResume:{turnId:failedTurnId,stamp:"stamp"}} as WorkPolicy;
  const target:WorkExecutionTarget={account:"b",profileKey:hash(3),accountKey:hash(4),identity:hash(5),sourceIdentity:hash(6),
    poolPolicyHash:hash(7),selectedAtMs:100,expiresAtMs:100000,budgetByBucket:{},baselineByBucket:{}};
  const receipt:HostQueueReceipt={threadId,turnId,clientUserMessageId:hostQueueClientMessageId(executionId),sentAtMs:200};
  const lease:ExecutionTargetLease={version:1,executionId,policyId:policy.id,policyRevision:1,
    source:{account:policy.account,profileKey:policy.profileKey,accountKey:policy.accountKey,identity:target.sourceIdentity,
      threadId,failedTurnId,evidenceStamp:"stamp"},target,marker:"marker",promptHash:hash(8),clientUserMessageId:receipt.clientUserMessageId,
    digest:hash(9),createdAtMs:100,expiresAtMs:100000,authorizationValidUntilMs:20000,state:"closed",turnId,
    targetRequest:{requestId:"request-1",fingerprint:hash(0),state:"completed",startedAtMs:300,finishedAtMs:400,status:200},
    upstreamResponse:{requestId:"request-1",turnId,identity:target.identity,status:200,observedAtMs:350}};
  return {executionId,policy,target,receipt,lease};
}

test("exact host turn plus the same target request's completed 2xx preserves completion",()=>{
  expect(reconcileNativeTargetResult(finished,fixture())).toBe(finished);
});

test("host completion alone cannot certify a missing or mismatched target response",()=>{
  const changes:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>{delete f.lease.targetRequest;}, f=>{delete f.lease.upstreamResponse;},
    f=>{f.lease.upstreamResponse!.identity=hash(0);}, f=>{f.lease.upstreamResponse!.requestId="older-request";},
    f=>{f.lease.upstreamResponse!.turnId=failedTurnId;}, f=>{f.receipt.turnId=failedTurnId;},
    f=>{f.receipt.clientUserMessageId="different-client-message";}, f=>{f.lease.source.account="other-account";},
    f=>{f.lease.policyRevision++;}, f=>{f.lease.targetRequest!.status=429;},
  ];
  for(const change of changes){
    const f=fixture();change(f);
    expect(reconcileNativeTargetResult(finished,f)).toEqual({status:"uncertain",reason:"execution-target-response-unverified",durationSeconds:23});
  }
  expect(reconcileNativeTargetResult(finished,{...fixture(),lease:null})).toEqual({status:"uncertain",reason:"execution-target-response-unverified",durationSeconds:23});
});

test("confirmed HTTP 429 and other provider rejections replace misleading host completion",()=>{
  for(const status of [429,401,403,500]){
    const f=fixture();f.lease.targetRequest!.state="failed";f.lease.targetRequest!.status=status;f.lease.upstreamResponse!.status=status;
    for(const result of [finished,{status:"failed",reason:"host-queue-turn-failed"} as WorkResult]){
      const actual=reconcileNativeTargetResult(result,f);
      expect(actual.status).toBe(status===429?"quota-blocked":"failed");
      expect(actual.reason).toBe(status===429?"execution-target-provider-quota-blocked":"execution-target-provider-rejected");
      expect(actual.summary).toBeUndefined();
    }
  }
});

test("transport, incomplete stream and unfinished send intent remain completion-unconfirmed",()=>{
  for(const [state,status] of [["failed",0],["failed",200],["unverified",200],["started",undefined]] as const){
    const f=fixture();f.lease.targetRequest!.state=state;f.lease.targetRequest!.status=status;
    if(status===0 || status===undefined)delete f.lease.upstreamResponse;
    expect(reconcileNativeTargetResult(finished,f)).toEqual({status:"uncertain",reason:"execution-target-completion-unconfirmed",durationSeconds:23});
  }
  const f=fixture();f.lease.targetRequest!.state="failed";f.lease.targetRequest!.status=429;
  f.lease.upstreamResponse!.requestId="older-2xx";
  expect(reconcileNativeTargetResult(finished,f).reason).toBe("execution-target-completion-unconfirmed");
});

test("pre-send failures and host interruption after a completed target response retain their meaning",()=>{
  const paused:WorkResult={status:"activity-paused",reason:"host-queue-turn-interrupted",durationSeconds:3};
  expect(reconcileNativeTargetResult(paused,fixture())).toBe(paused);
  const f=fixture();delete f.lease.targetRequest;delete f.lease.upstreamResponse;delete f.receipt.turnId;
  for(const result of [paused,{status:"failed",reason:"host-queue-not-empty"} as WorkResult]){
    expect(reconcileNativeTargetResult(result,f)).toBe(result);
    expect(reconcileNativeTargetResult(result,{...f,lease:null,receipt:undefined})).toBe(result);
  }
});

test("restart observation cannot promote a target execution from host completion without relay proof",async()=>{
  const f=fixture(),config=structuredClone(DEFAULT_CONFIG);
  config.accounts.codex[0]!.id=f.policy.account;config.alerts.macOSNotifications=false;
  const service=new QuotaPieService(config,new QuotaDatabase(":memory:"),{workState:null,quota:null});
  let status="dispatched";
  const spies=[
    spyOn(service.work.store,"executions").mockImplementation(()=>[{id:executionId,policySnapshot:f.policy,
      executionTarget:f.target,hostQueue:f.receipt,status}] as any),
    spyOn(service.work,"ownsExecution").mockReturnValue(false),
    spyOn(service as any,"workGoalAccountMatches").mockReturnValue(true),
    spyOn(service as any,"scheduleAutoResumeNotifications").mockImplementation(()=>{}),
    spyOn(service as any,"goalClient").mockReturnValue({readTurn:async()=>({threadId,turnId,status:"completed",completedAtMs:500})}),
  ];
  const finish=spyOn(service.work.store,"finish").mockImplementation(()=>({}) as any);
  const reconcile=spyOn(service.work.store,"reconcile").mockImplementation(()=>({}) as any);
  try{
    await (service as any).refreshHostQueueReceipts();
    expect(finish).toHaveBeenCalledWith(executionId,{status:"uncertain",reason:"execution-target-response-unverified"});
    status="uncertain";
    await (service as any).refreshHostQueueReceipts();
    expect(reconcile).toHaveBeenCalledWith(executionId,{status:"uncertain",reason:"execution-target-response-unverified"});
  }finally{finish.mockRestore();reconcile.mockRestore();for(const spy of spies)spy.mockRestore();await service.close();}
});
