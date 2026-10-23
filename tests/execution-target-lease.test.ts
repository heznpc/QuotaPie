import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_CONFIG} from "../src/config";
import {ExecutionTargetLeaseStore} from "../src/work/execution-target-lease";
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
