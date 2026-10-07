import { test, expect } from "bun:test";
import { TurnRecoveryFence, failureStage } from "./fence";
const thread = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
test("uncertain turn stays blocked; another turn can proceed", () => {
 const f = new TurnRecoveryFence(); const a = f.begin(thread, turn); expect("lease" in a).toBe(true);
 if (!("lease" in a)) throw Error();
 expect("response" in f.begin(thread, turn)).toBe(true);
 f.finish(a.lease, {phase:"failed",status:200,upstreamBytes:100});
 f.finish(a.lease, {phase:"completed",status:200});
 expect("response" in f.begin(thread, turn)).toBe(true);
 expect("lease" in f.begin(thread, other)).toBe(true);
});
test("successful sampling requests release reservation for tool-result continuation", () => {
 const f = new TurnRecoveryFence();const a = f.begin(thread,turn);if (!("lease" in a)) throw Error();
 f.finish(a.lease,{phase:"completed",status:200});expect("lease" in f.begin(thread,turn)).toBe(true);
});
test("no unsafe eviction, no identity fallback", () => {
 const f = new TurnRecoveryFence(1);expect("response" in f.begin(null,turn)).toBe(true);
 const a=f.begin(thread,turn);if (!("lease" in a)) throw Error();f.finish(a.lease,{phase:"cancelled",status:200});
 expect("response" in f.begin(thread,other)).toBe(true);
});
test("stage classification does not confuse connection with completion", () => {
 for(const [e,stage] of [
 [{phase:"failed",status:200,upstreamBytes:0},"empty_response"],
 [{phase:"failed",status:200,upstreamBytes:182488},"partial_response"],
 [{phase:"cancelled",status:200,upstreamBytes:22},"client_disconnected"],
 [{phase:"failed",status:507,upstreamBytes:53},"upstream_http_error"],
 [{phase:"failed",status:0},"before_response_headers"],
 [{phase:"completed",status:200},null],
 ] as const) expect(failureStage(e)).toBe(stage);
});

test("late completion cannot release the next sampling request", () => {
 const f=new TurnRecoveryFence();const a=f.begin(thread,turn);if (!("lease" in a)) throw Error();
 f.finish(a.lease,{phase:"completed",status:200});const b=f.begin(thread,turn);if (!("lease" in b)) throw Error();
 f.finish(a.lease,{phase:"completed",status:200});expect("response" in f.begin(thread,turn)).toBe(true);
});

import { fetchCodexUpstream } from "../../src/codex-transport";
test("existing pre-dispatch transport recovery is finite and can succeed", async () => {
 let calls=0,retries=0;
 const r=await fetchCodexUpstream(async()=>{calls++;if(calls<3)throw {code:"ECONNREFUSED"};return new Response("ok");},"http://127.0.0.1",{},()=>retries++);
 expect(await r.text()).toBe("ok");expect(calls).toBe(3);expect(retries).toBe(2);
});
test("reset/timeout and an empty HTTP 200 are never replayed by transport helper",async()=>{
 for(const code of ["ECONNRESET","ETIMEDOUT"]) {
  let calls=0;await expect(fetchCodexUpstream(async()=>{calls++;throw {code};},"http://127.0.0.1",{},()=>{throw Error("unsafe retry");})).rejects.toEqual({code});expect(calls).toBe(1);
 }
 let calls=0;await fetchCodexUpstream(async()=>{calls++;return new Response(null);},"http://127.0.0.1",{},()=>{throw Error("unsafe retry");});expect(calls).toBe(1);
});
test("pre-dispatch recovery stops at three attempts; cancellation stops before dispatch",async()=>{
 let calls=0;await expect(fetchCodexUpstream(async()=>{calls++;throw {code:"ECONNREFUSED"};},"http://127.0.0.1",{},()=>{})).rejects.toEqual({code:"ECONNREFUSED"});expect(calls).toBe(3);
 const c=new AbortController();c.abort();calls=0;
 await expect(fetchCodexUpstream(async()=>{calls++;return new Response();},"http://127.0.0.1",{signal:c.signal},()=>{})).rejects.toBeDefined();expect(calls).toBe(0);
});

import { startCompactionProxy } from "../../src/codex-compaction";
test("relay rejects WebSocket locally with 426 without upstream request",async()=>{
 let calls=0;const r=startCompactionProxy({fetchUpstream:async()=>{calls++;return new Response();}});
 try {const res=await fetch(`${r.baseUrl}/responses`,{headers:{upgrade:"websocket"}});expect(res.status).toBe(426);expect(calls).toBe(0);} finally {r.stop();}
});
test("upstream HTTP failure remains distinct from protocol EOF",async()=>{
 const outcomes:any[]=[];let calls=0;
 const r=startCompactionProxy({fetchUpstream:async()=>{calls++;return new Response("fixture failure",{status:507});},onRequest:e=>outcomes.push(e)});
 try {
  const res=await fetch(`${r.baseUrl}/responses`,{method:"POST",headers:{"content-type":"application/json",session_id:thread,"x-codex-turn-id":turn},body:JSON.stringify({model:"gpt-6-astra",stream:true,input:[]})});
  expect(res.status).toBe(507);await res.text();expect(calls).toBe(1);
  expect(outcomes.at(-1).errorCode).toBe("upstream_http_error");
 }finally{r.stop();}
});
test("downstream cancellation is not a missing-completion failure",async()=>{
 let resolve!: (e:any)=>void;const terminal=new Promise<any>(r=>resolve=r);let calls=0;
 const r=startCompactionProxy({fetchUpstream:async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"fixture"}}\n\n'));}}),{headers:{"content-type":"text/event-stream"}});},onRequest:e=>{if(e.phase==="cancelled")resolve(e);}});
 const abort=new AbortController();let timer:ReturnType<typeof setTimeout> | undefined;
 try{
  const res=await fetch(`${r.baseUrl}/responses`,{method:"POST",headers:{"content-type":"application/json",session_id:thread,"x-codex-turn-id":turn},body:JSON.stringify({model:"gpt-6-astra",stream:true,input:[]}),signal:abort.signal});
  await res.body!.getReader().read();abort.abort();
  const e=await Promise.race([terminal,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("cancel timeout")),1500);})]);
  expect(e.errorCode).toBe("client_disconnected");expect(calls).toBe(1);
 }finally{clearTimeout(timer);abort.abort();r.stop();}
});
