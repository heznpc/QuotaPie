import { expect, test } from "bun:test";
import { TaskSavingsRouter, DEFAULT_TASK_SAVINGS, validateTaskSavings } from "../src/task-savings";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
const policy={...DEFAULT_TASK_SAVINGS,enabled:true};
const id="11111111-1111-4111-8111-111111111111";
const input=(text='Change the button label from "Save" to "Done".')=>({model:"gpt-6-astra",reasoning:{effort:"xhigh"},stream:true,
 input:[{type:"message",role:"user",content:[{type:"input_text",text}]}]});

test("Auto defaults on and routes bounded edits, preserves uncertainty and verifies model support",()=>{
 const router=new TaskSavingsRouter(()=>true);
 const original=input();
 expect(DEFAULT_TASK_SAVINGS.enabled).toBe(true);
 expect(router.route(original,{...DEFAULT_TASK_SAVINGS,enabled:false},id).reason).toBe("disabled");
 expect(router.route(original,policy,id).body).toMatchObject({model:"gpt-5.6-luna",reasoning:{effort:"low"}});
 expect(original.model).toBe("gpt-6-astra");
 for(const text of ['Fix the authentication button "Save" and security model.','Inspect and refactor the application','이것도 해결바람','Change the button "Buy" and implement payment handling.']) {
  expect(new TaskSavingsRouter(()=>true).route(input(text),policy,id).routed).toBe(false);
 }
 expect(new TaskSavingsRouter(()=>true).route(input('버튼 문구를 "저장"에서 "완료"로 바꿔 주세요.'),policy,id).routed).toBe(true);
 expect(new TaskSavingsRouter(()=>false).route(original,policy,id).reason).toBe("unsupported_model");
 expect(router.route(original,policy,null).reason).toBe("unidentified_task");
 expect(()=>validateTaskSavings({...policy,effort:"light"})).toThrow();
});

test("manual model and effort changes, failures, explicit undo and extended work release the override",()=>{
 for(const change of [{model:"gpt-5.6-terra"},{reasoning:{effort:"high"}}]) {
  const router=new TaskSavingsRouter(()=>true);router.route(input(),policy,id);
  expect(router.route({...input(),...change},policy,id).reason).toBe("manual_change");
  expect(router.route(input(),policy,id).routed).toBe(false);
  expect(router.route(input('Change the title from "Old" to "New".'),policy,id).reason).toBe("manual_change");
 }
 const router=new TaskSavingsRouter(()=>true);router.route(input(),policy,id);router.failed(id);
 expect(router.route(input(),policy,id).reason).toBe("failure_fallback");
 const next=new TaskSavingsRouter(()=>true);
 for(let i=0;i<8;i++) expect(next.route(input(),policy,id).routed).toBe(true);
 expect(next.route(input(),policy,id).reason).toBe("extended_work");
 expect(new TaskSavingsRouter(()=>true).route(input(),{...policy,bypassThreads:[id]},id).reason).toBe("task_disabled");
 const failed=input() as any;failed.input.push({type:"function_call_output",output:'Process exited with code 1; tests failed'});
 expect(new TaskSavingsRouter(()=>true).route(failed,policy,id).reason).toBe("failure_fallback");
});

test("real HTTP routing observes response model and usage separately, compaction remains independent",async()=>{
 const events:CompactionRequestEvent[]=[];const seen:any[]=[];
 let finish!:()=>void;
 const proxy=startCompactionProxy({taskSavings:policy,savingsModelSupported:()=>true,onRequest:e=>events.push(e),fetchUpstream:async(_url,init)=>{
  const body=JSON.parse(String(init.body));seen.push(body);
  return new Response(new ReadableStream({start(c){
   c.enqueue(new TextEncoder().encode(": ready\n\n"));
   finish=()=>{c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:"response.completed",response:{status:"completed",model:body.model,usage:{input_tokens:123,input_tokens_details:{cached_tokens:100},output_tokens:7}}})+'\n\n'));c.close();};
  }}),{headers:{"content-type":"text/event-stream"}});
 }});
 try {
  const response=await fetch(proxy.baseUrl+'/responses',{method:'POST',headers:{session_id:id},body:JSON.stringify(input())});
  expect(events.at(-1)?.phase).toBe("response_headers");expect(events.at(-1)?.responseModel).toBeNull();
  finish();await response.text();
  expect(seen[0].model).toBe("gpt-5.6-luna");expect(events.at(-1)).toMatchObject({phase:"completed",responseModel:"gpt-5.6-luna",usage:{input:123,cachedInput:100,output:7},savingsReason:"simple_text_edit"});
  const compact=await fetch(proxy.baseUrl+'/responses/compact',{method:'POST',body:JSON.stringify(input())});finish();await compact.text();
  expect(seen[1].model).toBe("gpt-5.6-sol");
  expect(JSON.stringify(events)).not.toContain('button label');
  const health=await(await fetch(proxy.baseUrl+'/quotapie-health')).json() as any;
  expect(health.attemptedCompactions).toBe(1);
 }finally{proxy.stop();}
});
