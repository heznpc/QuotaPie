import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_CONFIG} from "../src/config";
import {ExecutionTargetLeaseStore,type LocalRecoveryPermitInput} from "../src/work/execution-target-lease";
import {nativeTargetLease} from "../src/work/native-target-lease";
import type {WorkExecutionTarget,WorkPolicy} from "../src/work/types";

const NOW=2_000_000_000_000,THREAD="11111111-1111-4111-8111-111111111111",FAILED="22222222-2222-4222-8222-222222222222",
 TURN="33333333-3333-4333-8333-333333333333",EXECUTION="44444444-4444-4444-8444-444444444444",CLIENT="55555555-5555-4555-8555-555555555555",OTHER="66666666-6666-4666-8666-666666666666";
const hash=(n:number)=>String(n).repeat(64),bucket="codex:primary:300";
function fixture(path=":memory:"){
 const policy={id:"incident",provider:"codex",account:"a",profileKey:hash(1),accountKey:hash(2),purpose:"quota-resume",quotaResume:{turnId:FAILED,stamp:"stamp"},
  nativeSessionId:THREAD,model:"gpt-6.1-sol",dispatchOwner:"local",maxTurns:1,revision:1,prompt:"[QuotaPie quota recovery:incident]\nContinue once"} as WorkPolicy;
 const target:WorkExecutionTarget={account:"b",profileKey:hash(3),accountKey:hash(4),identity:hash(5),sourceIdentity:hash(6),poolPolicyHash:hash(7),selectedAtMs:NOW,expiresAtMs:NOW+60000,
  budgetByBucket:{[bucket]:{reservePercent:10,maxUsagePercent:20}},baselineByBucket:{[bucket]:{observationId:"b-sample",atMs:NOW,remainingPercent:80,epoch:String(NOW+3600000)}}};
 const store=new ExecutionTargetLeaseStore(path),lease=store.request(policy,EXECUTION,CLIENT,target,NOW);
 const request=(body:unknown,turnId=TURN)=>({sourceProfileKey:policy.profileKey,threadId:THREAD,turnId,body,relayInstanceId:"relay-generation"});
 const body={input:[{role:"user",content:policy.prompt}]};
 return {policy,target,store,lease,request,body};
}
test("unacknowledged lease cannot route; exact source/thread/prompt binds just one new native turn",()=>{
 const f=fixture();try{
  expect(()=>f.store.bindRequest(f.request(f.body),NOW)).toThrow("execution-target-lease-unavailable");
  f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
  expect(()=>f.store.bindRequest(f.request(f.body,FAILED),NOW)).toThrow();
  expect(f.store.bindRequest(f.request(f.body),NOW)?.target.account).toBe("b");
  expect(f.store.bindRequest(f.request({input:[{role:"tool",content:"result"}]}),NOW)?.target.account).toBe("b");
  expect(()=>f.store.bindRequest(f.request(f.body,OTHER),NOW)).toThrow();
  expect(()=>f.store.bindRequest({...f.request(f.body),relayInstanceId:"new-generation"},NOW)).toThrow();
 }finally{f.store.close()}
});
test("native context envelope needs exact official client-message receipt and never falls to ordinary routing",()=>{
 const f=fixture();try{
  f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
  const envelope={input:[...f.body.input,{role:"user",content:"<environment_context>host context</environment_context>"}]};
  expect(()=>f.store.bindRequest(f.request(envelope),NOW)).toThrow("execution-target-message-order-unverified");
  expect(()=>f.store.bindCorrelatedTurn(EXECUTION,f.lease.digest,"relay-generation",{threadId:THREAD,turnId:TURN,clientUserMessageId:OTHER},NOW)).toThrow();
  f.store.bindCorrelatedTurn(EXECUTION,f.lease.digest,"relay-generation",{threadId:THREAD,turnId:TURN,clientUserMessageId:CLIENT},NOW);
  expect(f.store.bindRequest(f.request(envelope),NOW)?.target.identity).toBe(f.target.identity);
  expect(()=>f.store.bindRequest(f.request({input:[]},""),NOW)).toThrow("execution-target-turn-unverified");
  const manual={input:[...envelope.input,{role:"user",content:"Actually do this other task"}]};
  expect(f.store.bindRequest(f.request(manual,OTHER),NOW)).toBeNull();
 }finally{f.store.close()}
});
test("closed and expired old markers do not hijack newer manual turns while delayed recovery stays blocked",()=>{
 for(const closed of [true,false]){
  const f=fixture();try{
   f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
   if(closed)f.store.closeLease(EXECUTION,f.lease.digest,"finished");
   const now=NOW+60001;
   f.store.bindCorrelatedTurn(EXECUTION,f.lease.digest,"new-listener",{threadId:THREAD,turnId:TURN,clientUserMessageId:CLIENT},now);
   expect(f.store.get(EXECUTION)?.state).toBe("closed");
   const envelope={input:[...f.body.input,{role:"user",content:"<environment_context>host context</environment_context>"}]};
   expect(()=>f.store.bindRequest({...f.request(envelope),relayInstanceId:"new-listener"},now)).toThrow();
   expect(()=>f.store.bindRequest({...f.request({input:[]},""),relayInstanceId:"new-listener"},now)).toThrow("execution-target-turn-unverified");
   expect(f.store.bindRequest({...f.request({...envelope,input:[...envelope.input,{role:"user",content:"New manual request"}]},OTHER),relayInstanceId:"new-listener"},now)).toBeNull();
  }finally{f.store.close()}
 }
});
test("restart preserves immutable target, duplicate request and closed lease tombstone",()=>{
 const directory=mkdtempSync(join(tmpdir(),"quotapie-target-lease-")),path=join(directory,"lease.sqlite");
 const f=fixture(path);f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);f.store.bindRequest(f.request(f.body),NOW);f.store.close();
 const reopened=new ExecutionTargetLeaseStore(path);
 try{
  expect(reopened.request(f.policy,EXECUTION,CLIENT,f.target,NOW).turnId).toBe(TURN);
  expect(()=>reopened.request(f.policy,EXECUTION,CLIENT,{...f.target,account:"c"},NOW)).toThrow("execution-target-lease-conflict");
  reopened.closeLease(EXECUTION,f.lease.digest,"finished");
  expect(()=>reopened.renew(EXECUTION,f.lease.digest,NOW)).toThrow();
  expect(()=>reopened.request(f.policy,EXECUTION,CLIENT,f.target,NOW)).toThrow();
 }finally{reopened.close();rmSync(directory,{recursive:true,force:true})}
});
for(const acknowledged of [false,true]) test(`closed preflight row preserves audit without obscuring next lease (acknowledged ${acknowledged})`,()=>{
 const f=fixture();try{
  if(acknowledged)f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
  f.store.closeLease(EXECUTION,f.lease.digest,"preflight-unavailable");
  const next=f.store.request(f.policy,OTHER,"77777777-7777-4777-8777-777777777777",f.target,NOW);
  f.store.acknowledge(OTHER,next.digest,"relay-generation",f.policy.profileKey,NOW);
  if(acknowledged)expect(()=>f.store.bindRequest(f.request(f.body),NOW)).toThrow("execution-target-lease-conflict");
  else {
   expect(f.store.bindRequest(f.request(f.body),NOW)?.executionId).toBe(OTHER);
   expect(()=>f.store.bindCorrelatedTurn(EXECUTION,f.lease.digest,"relay-generation",{threadId:THREAD,turnId:TURN,clientUserMessageId:CLIENT},NOW)).toThrow();
  }
  expect(f.store.list()).toHaveLength(2);
  expect(f.store.get(EXECUTION)?.turnId).toBeUndefined();expect(f.store.get(EXECUTION)?.state).toBe("closed");
 }finally{f.store.close()}
});
function localPermit(f:ReturnType<typeof fixture>):LocalRecoveryPermitInput {
 return {parentExecutionId:EXECUTION,childPolicyId:"repair-incident",sourceQuotaTurnId:FAILED,goalFingerprint:hash(7),
  host:{threadId:THREAD,turnId:TURN,clientUserMessageId:CLIENT,status:"failed",errorType:"quotapie_subscription_guard",
   errorCode:"subscription_pool_execution_target_conflict",completedAtMs:NOW+3},
  relay:{instanceId:"relay-generation",requestId:"99999999-9999-4999-8999-999999999999",status:400,origin:"relay",
   reason:"pool_execution_target_conflict",observedAtMs:NOW+2}};
}
test("typed local repair binds the failed host turn atomically and consumes only one successful child ACK",()=>{
 const f=fixture();try{
  f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
  f.store.closeLease(EXECUTION,f.lease.digest,"host-queue-execution-ended");
  const input=localPermit(f),permit=f.store.createLocalRecoveryPermit(input,NOW+4);
  expect(f.store.get(EXECUTION)?.turnId).toBe(TURN);expect(f.store.get(EXECUTION)?.state).toBe("closed");
  expect(f.store.createLocalRecoveryPermit(input,NOW+4).id).toBe(permit.id);
  expect(f.store.get(EXECUTION)?.localRecoveryPermit?.goalFingerprint).toBe(input.goalFingerprint);
  expect(()=>f.store.createLocalRecoveryPermit({...input,goalFingerprint:hash(8)},NOW+4)).toThrow("execution-target-local-recovery-conflict");
  expect(()=>f.store.createLocalRecoveryPermit({...input,childPolicyId:"another-repair"},NOW+4)).toThrow();
  const child={...f.policy,id:input.childPolicyId,prompt:`[QuotaPie quota recovery:${input.childPolicyId}]\nContinue once`,
   quotaResume:{turnId:TURN,stamp:"local-error-stamp",localBeforeSendRecovery:{permitId:permit.id,parentExecutionId:EXECUTION,sourceQuotaTurnId:FAILED}}};
  const first=f.store.request(child,OTHER,"77777777-7777-4777-8777-777777777777",f.target,NOW+4);
  expect(f.store.validateLocalRecoveryPermit(permit.id,EXECUTION,child.id,FAILED,TURN).consumedExecutionId).toBeUndefined();
  expect(()=>f.store.acknowledge(OTHER,first.digest,"new-generation",f.policy.profileKey,NOW+4)).toThrow();
  f.store.closeLease(OTHER,first.digest,"preflight-unavailable");
  const secondId="88888888-8888-4888-8888-888888888888";
  const second=f.store.request(child,secondId,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",f.target,NOW+4);
  f.store.acknowledge(secondId,second.digest,"relay-generation",f.policy.profileKey,NOW+4);
  expect(f.store.acknowledge(secondId,second.digest,"relay-generation",f.policy.profileKey,NOW+5).state).toBe("acknowledged");
  expect(f.store.validateLocalRecoveryPermit(permit.id,EXECUTION,child.id,FAILED,TURN).consumedExecutionId).toBe(secondId);
  f.store.closeLease(secondId,second.digest,"host-queue-execution-ended");
  expect(()=>f.store.request(child,"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","cccccccc-cccc-4ccc-8ccc-cccccccccccc",f.target,NOW+6)).toThrow();
  expect(()=>f.store.bindRequest(f.request(f.body,TURN),NOW+6)).toThrow();
  expect(f.store.bindRequest(f.request({input:[{role:"user",content:"New manual task"}]},"dddddddd-dddd-4ddd-8ddd-dddddddddddd"),NOW+6)).toBeNull();
 }finally{f.store.close()}
});
test("local repair never accepts provider rejection, uncorrelated host failure, wrong generation or a send intent",()=>{
 for(const variant of ["host-code","host-client","relay-origin","relay-generation","relay-code","source-quota-turn","send-intent","goal-missing","goal-invalid"]){
  const f=fixture();try{
   f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
   if(variant==="send-intent"){
    f.store.bindRequest(f.request(f.body),NOW);
    f.store.beginTargetRequest(EXECUTION,f.lease.digest,"relay-generation",{requestId:"already-started",turnId:TURN,identity:f.target.identity,fingerprint:hash(0)},NOW);
   }
   f.store.closeLease(EXECUTION,f.lease.digest,"host-queue-execution-ended");
   const input=localPermit(f);
   if(variant==="host-code")(input.host as any).errorCode="usageLimitExceeded";
   if(variant==="host-client")input.host.clientUserMessageId=OTHER;
   if(variant==="relay-origin")(input.relay as any).origin="provider";
   if(variant==="relay-generation")input.relay.instanceId="different";
   if(variant==="relay-code")input.relay.reason="pool_execution_target_unavailable";
   if(variant==="source-quota-turn")input.sourceQuotaTurnId=TURN;
   if(variant==="goal-missing")delete (input as any).goalFingerprint;
   if(variant==="goal-invalid")input.goalFingerprint="not-a-goal-hash";
   expect(()=>f.store.createLocalRecoveryPermit(input,NOW+4)).toThrow("execution-target-local-recovery-unverified");
   expect(f.store.get(EXECUTION)?.localRecoveryPermit).toBeUndefined();
   if(variant!=="send-intent")expect(f.store.get(EXECUTION)?.turnId).toBeUndefined();
  }finally{f.store.close()}
 }
});
for(const finalAccount of ["b","a"])test(`two proven unsent repairs preserve the root audit, select ${finalAccount} per attempt and stop at the durable root budget`,()=>{
 const directory=mkdtempSync(join(tmpdir(),"quotapie-repair-chain-")),path=join(directory,"leases.sqlite"),f=fixture(path);
 let store=f.store;
 try{
  store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);
  store.closeLease(EXECUTION,f.lease.digest,"host-queue-execution-ended");
  const first=store.createLocalRecoveryPermit(localPermit(f),NOW+4);
  const childPolicy={...f.policy,id:"repair-incident",prompt:"[QuotaPie quota recovery:repair-incident]\nContinue once",
   quotaResume:{turnId:TURN,stamp:"local-one",localBeforeSendRecovery:{permitId:first.id,parentExecutionId:EXECUTION,sourceQuotaTurnId:FAILED}}};
  const childClient="77777777-7777-4777-8777-777777777777",childTurn="88888888-8888-4888-8888-888888888888";
  const childTarget={...f.target,account:"c",identity:hash(8),profileKey:hash(9),accountKey:hash(0)};
  const child=store.request(childPolicy,OTHER,childClient,childTarget,NOW+4);
  store.acknowledge(OTHER,child.digest,"relay-generation",f.policy.profileKey,NOW+4);
  store.closeLease(OTHER,child.digest,"host-queue-execution-ended");
  store.close();store=new ExecutionTargetLeaseStore(path);
  const secondInput:LocalRecoveryPermitInput={...localPermit(f),parentExecutionId:OTHER,childPolicyId:"repair-two",
   host:{...localPermit(f).host,turnId:childTurn,clientUserMessageId:childClient,errorCode:"subscription_pool_execution_target_unavailable",completedAtMs:NOW+8},
   relay:{...localPermit(f).relay,requestId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",reason:"pool_execution_target_unavailable",observedAtMs:NOW+7}};
  expect(()=>store.createLocalRecoveryPermit({...secondInput,goalFingerprint:hash(0)},NOW+9)).toThrow("execution-target-local-recovery-unverified");
  const second=store.createLocalRecoveryPermit(secondInput,NOW+9);
  expect(second.rootPolicyId).toBe(f.policy.id);expect(store.get(EXECUTION)?.localRecoveryPermit).toEqual({...first,consumedExecutionId:OTHER});
  expect(store.get(OTHER)?.turnId).toBe(childTurn);expect(store.get(OTHER)?.target.account).toBe("c");
  const leafId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",leafClient="cccccccc-cccc-4ccc-8ccc-cccccccccccc",leafTurn="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const leafPolicy={...f.policy,id:"repair-two",prompt:"[QuotaPie quota recovery:repair-two]\nContinue once",
   quotaResume:{turnId:childTurn,stamp:"local-two",localBeforeSendRecovery:{permitId:second.id,parentExecutionId:OTHER,sourceQuotaTurnId:FAILED}}};
  const leafTarget=finalAccount==="a"?{...f.target,account:"a",identity:f.target.sourceIdentity,profileKey:f.policy.profileKey,accountKey:f.policy.accountKey}:f.target;
  const leaf=store.request(leafPolicy,leafId,leafClient,leafTarget,NOW+9);
  store.acknowledge(leafId,leaf.digest,"relay-generation",f.policy.profileKey,NOW+9);
  expect(store.bindRequest({sourceProfileKey:f.policy.profileKey,threadId:THREAD,turnId:leafTurn,body:{input:[{role:"user",content:leafPolicy.prompt}]},relayInstanceId:"relay-generation"},NOW+9)?.target.account).toBe(finalAccount);
  store.closeLease(leafId,leaf.digest,"host-queue-execution-ended");
  expect(()=>store.createLocalRecoveryPermit({...secondInput,parentExecutionId:leafId,childPolicyId:"repair-three",
   host:{...secondInput.host,turnId:leafTurn,clientUserMessageId:leafClient,completedAtMs:NOW+12},relay:{...secondInput.relay,observedAtMs:NOW+11}},NOW+13)).toThrow("execution-target-local-recovery-consumed");
  expect(store.list().filter(l=>l.localRecoveryPermit)).toHaveLength(2);
  expect(store.get(EXECUTION)?.state).toBe("closed");expect(store.get(OTHER)?.state).toBe("closed");
  expect(store.validateLocalRecoveryPermit(first.id,EXECUTION,childPolicy.id,FAILED,TURN).id).toBe(first.id);
  expect(store.validateLocalRecoveryPermit(second.id,OTHER,leafPolicy.id,FAILED,childTurn).id).toBe(second.id);
 }finally{store.close();rmSync(directory,{recursive:true,force:true})}
});
test("live ACK adapter requires current listener's exact durable acknowledgement and unchanged host owner",async()=>{
 for(const mode of ["ok","wrong-target","owner-changed","unsupported"]){
  const f=fixture();f.store.close();const store=new ExecutionTargetLeaseStore(":memory:");let ownerReads=0;
  const handle=nativeTargetLease(structuredClone(DEFAULT_CONFIG),f.policy,EXECUTION,f.target,()=>true,{store,now:()=>NOW,
   endpoint:()=>"http://127.0.0.1:12345/token/backend-api/codex",owner:async()=>({pid:mode==="owner-changed"&&ownerReads++>0?42:41,startedAtMs:NOW-100000}),
   fetch:(async(_url:any,init:any)=>{
    const request=JSON.parse(init.body),lease=store.get(request.executionId)!;
    if(mode==="unsupported")return Response.json({reason:"execution-target-native-route-unverified"},{status:409});
    const ack=store.acknowledge(request.executionId,request.digest,"relay-generation",f.policy.profileKey,NOW);
    return Response.json({executionId:ack.executionId,digest:ack.digest,relayInstanceId:ack.relayInstanceId,acknowledgedAtMs:ack.acknowledgedAtMs,
     sourceProfileKey:ack.source.profileKey,targetIdentity:mode==="wrong-target"?hash(0):lease.target.identity});
   }) as typeof fetch});
  try{
   if(mode==="ok"){await handle.acknowledge();expect(handle.current()).toBe(true);await handle.renew();}
   else {await expect(handle.acknowledge()).rejects.toThrow();expect(handle.current()).toBe(false);}
  }finally{handle.close("test-ended");store.close()}
 }
});
test("only matching actual target provider response becomes usage evidence",()=>{
 const f=fixture();try{
  f.store.acknowledge(EXECUTION,f.lease.digest,"relay-generation",f.policy.profileKey,NOW);f.store.bindRequest(f.request(f.body),NOW);
  expect(f.store.get(EXECUTION)?.upstreamResponse).toBeUndefined();
  expect(()=>f.store.recordTargetResponse(EXECUTION,f.lease.digest,"relay-generation",{requestId:"request",turnId:TURN,identity:hash(0),status:200,observedAtMs:NOW})).toThrow();
  f.store.recordTargetResponse(EXECUTION,f.lease.digest,"relay-generation",{requestId:"request",turnId:TURN,identity:f.target.identity,status:200,observedAtMs:NOW});
  expect(f.store.get(EXECUTION)?.upstreamResponse?.identity).toBe(f.target.identity);
 }finally{f.store.close()}
});
test("independent authorization renewal covers a slow host wake without extending revoked consent",async()=>{
 const f=fixture();f.store.close();const store=new ExecutionTargetLeaseStore(":memory:");let now=NOW,allowed=true;
 const handle=nativeTargetLease(structuredClone(DEFAULT_CONFIG),f.policy,EXECUTION,f.target,()=>allowed,{store,now:()=>now,renewalIntervalMs:1,
  endpoint:()=>"http://127.0.0.1:12345/token/backend-api/codex",owner:async()=>({pid:41,startedAtMs:NOW-100000}),fetch:(async(_url:any,init:any)=>{
   const request=JSON.parse(init.body),lease=store.acknowledge(EXECUTION,request.digest,"relay-generation",f.policy.profileKey,now);
   return Response.json({executionId:EXECUTION,digest:lease.digest,relayInstanceId:lease.relayInstanceId,acknowledgedAtMs:now,sourceProfileKey:f.policy.profileKey,targetIdentity:f.target.identity});
  }) as typeof fetch});
 try{
  await handle.acknowledge();
  // No queue-loop renew() call: advance through a 40s blocking host handshake.
  for(let i=0;i<8;i++){now+=5000;await new Promise(resolve=>setTimeout(resolve,4));expect(handle.current()).toBe(true);}
  expect(store.get(EXECUTION)?.authorizationValidUntilMs).toBeGreaterThan(now);
  allowed=false;await new Promise(resolve=>setTimeout(resolve,4));expect(handle.current()).toBe(false);expect(store.get(EXECUTION)?.state).toBe("closed");
 }finally{handle.close("test-ended");store.close()}
});
