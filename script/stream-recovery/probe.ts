import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCompactionProxy } from "../../src/codex-compaction";
import { TurnRecoveryFence, failureStage, type Lease } from "./fence";

// Offline only: production fetch is replaced; outer proxy only calls loopback.
const binary = process.env.PROBE_CODEX_BINARY;
if (!binary) throw Error("Set PROBE_CODEX_BINARY to an installed Codex executable");
const root = mkdtempSync(join(tmpdir(), "stream-recovery-"));
const enc = new TextEncoder();
function sse(events: unknown[]) {
 return new Response(enc.encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")), {headers:{"content-type":"text/event-stream"}});
}
const results = [];
for (const mode of ["baseline-tool-replay", "fenced-tool", "fenced-empty", "completed-tool"] as const) {
 const dir = join(root,mode); mkdirSync(dir);mkdirSync(join(dir,"home"));
 writeFileSync(join(dir,"AGENTS.md"), "Local offline fixture. Execute the fixture tool command once when requested. Do not contact any external service.\n");
 const marker = join(dir,"marker.txt");
 const fence = new TurnRecoveryFence(); let downstream=0, upstream=0;
 const terminals: unknown[]=[];const keys=new Map<string,Lease>(); const requests=new Map<string,Lease>();
 const relay = startCompactionProxy({
  fetchUpstream: async () => {
   upstream++;
   if (mode==="fenced-empty") return sse([]);
   const tool = mode==="baseline-tool-replay" ? upstream<=2 : upstream===1;
   const item = tool ? {
    type:"custom_tool_call",id:`ctc_${upstream}`,call_id:`call_${upstream}`,name:"exec",
    input:`text(await tools.exec_command(${JSON.stringify({cmd:`printf 'executed\\n' >> '${marker}'`,max_output_tokens:100})}));`,
   } : {type:"message",id:"msg_done",role:"assistant",content:[{type:"output_text",text:"Local fixture finished."}]};
   const response={id:`resp_${upstream}`,status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
   const events:unknown[]=[{type:"response.created",response:{...response,status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item}, {type:"response.output_item.done",output_index:0,item}];
   if(!tool || mode==="completed-tool") events.push({type:"response.completed",response});
   return sse(events);
  },
  onRequest(e) {
   if(e.phase==="started") { const k=keys.get(`${e.threadId}:${e.turnId}`); if(k)requests.set(e.requestId,k); }
   if (!["completed","failed","cancelled","unverified"].includes(e.phase)) return;
   terminals.push({phase:e.phase,status:e.status,stage:failureStage(e),bytes:e.upstreamBytes});
   const k=requests.get(e.requestId);if(k) fence.finish(k,e);requests.delete(e.requestId);
  },
 });
 const front = Bun.serve({hostname:"127.0.0.1",port:0, async fetch(req) {
  if(req.method!=="POST" || new URL(req.url).pathname!=="/responses") return new Response(null,{status:404});
  downstream++;
  if(downstream>8) return new Response("Fixture request limit",{status:400});
  if(mode!=="baseline-tool-replay") {
   let metadata: Record<string,string> = {};
   try { metadata=JSON.parse(req.headers.get("x-codex-turn-metadata") ?? "{}"); } catch {}
   const thread=req.headers.get("session_id") ?? metadata.thread_id ?? null,turn=req.headers.get("x-codex-turn-id") ?? metadata.turn_id ?? null;
   const admission=fence.begin(thread,turn);if("response" in admission)return admission.response;
   keys.set(`${thread}:${turn}`,admission.lease);
  }
  const h=new Headers(req.headers);h.delete("host");h.delete("content-length");
  return fetch(`${relay.baseUrl}/responses`,{method:"POST",headers:h,body:await req.arrayBuffer(),signal:req.signal});
 }});
 const args=[binary,"exec","--ignore-user-config","--ephemeral","--skip-git-repo-check","-C",dir,"-s","workspace-write","-m","gpt-6-astra",
  "-c",'model_provider="fixture"',"-c",'model_providers.fixture.name="Offline fixture"',
  "-c",`model_providers.fixture.base_url="http://127.0.0.1:${front.port}"`,"-c",'model_providers.fixture.wire_api="responses"',
  "-c",'model_providers.fixture.requires_openai_auth=false',"-c",'model_providers.fixture.supports_websockets=false',"--json",
  "Run the offline fixture's marker command when supplied, then report its result."];
 const child=Bun.spawn(args,{stdout:"pipe",stderr:"pipe",env:{...process.env,CODEX_HOME:join(dir,"home"),OPENAI_API_KEY:"",CODEX_API_KEY:""}});
 let timeout=false;const timer=setTimeout(()=>{timeout=true;child.kill();},30000);
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 clearTimeout(timer);front.stop(true);relay.stop();
 let executions=0;try{executions=readFileSync(marker,"utf8").trim().split("\n").length;}catch{}
 const events=stdout.trim().split("\n").flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
 const expected=mode==="baseline-tool-replay" ? {upstream:3,executions:2,exit:0} : mode==="completed-tool" ? {upstream:2,executions:1,exit:0} : {upstream:1,executions:mode==="fenced-tool"?1:0,exit:1};
 const pass=!timeout && upstream===expected.upstream && executions===expected.executions && exit===expected.exit;
 results.push({mode,pass,downstream,upstream,executions,exit,timeout,terminals,
  errorMessages:events.filter(e=>e.type==="error").map(e=>e.message),stderrPresent:stderr.length>0});
}
console.log(JSON.stringify({runtime:Bun.version,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
