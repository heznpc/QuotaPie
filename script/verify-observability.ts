// Local UI smoke test: isolated in-memory outbox, synthetic public posts and
// synthetic upstream SSE. Never reads Codex credentials or writes production history.
// bun script/verify-observability.ts /tmp/quotapie-verify-stage
// Stages: headers, completed, failed, announce, update, withdraw.
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { startCompactionProxy } from "../src/codex-compaction";
import { CompactionStatusReader } from "../src/compaction-status";
import { ResetSignalCollector } from "../src/signals/collector";

const stagePath=process.argv[2]; if(!stagePath) throw new Error("Stage path required");
const root=await mkdtemp(join(tmpdir(),"quotapie-observability-smoke-"));
const generation=join(root,"releases","1");await mkdir(generation,{recursive:true});
const token="ab".repeat(24);
let upstream!:ReadableStreamDefaultController<Uint8Array>;
const relay=startCompactionProxy({token,fetchUpstream:async()=>new Response(new ReadableStream({start(c){
  upstream=c;c.enqueue(new TextEncoder().encode(": smoke test\n\n"));
}}),{headers:{"content-type":"text/event-stream"}}),onRequest:e=>{void appendFile(join(generation,"relay.log"),JSON.stringify(e)+"\n")}});
await writeFile(join(generation,"settings.json"),JSON.stringify({port:Number(new URL(relay.baseUrl).port),token}),{mode:0o600});
const observer=new CompactionStatusReader(root);
const config=structuredClone(DEFAULT_CONFIG);config.dashboard.port=0;
config.collection.codexEnabled=false;config.collection.claudeOAuthEnabled=false;
config.resetSignals={enabled:true,tokenFile:null,pollSeconds:300};
config.alerts.enabled=true;config.alerts.macOSNotifications=true;config.alerts.command=null;config.profile.locale="ko";
const service=new QuotaPieService(config,new QuotaDatabase(":memory:"));
let text="";const postedAt=new Date().toISOString();
const collector=new ResetSignalCollector(service.resetSignals,config.resetSignals,(async(input:any)=>{
  if(String(input).includes("resetbeacon"))return Response.json({version:1,generatedAt:new Date().toISOString(),items:[]});
  return new Response(`<script id="$tsr-stream-barrier">activeSignals:[$R[1]={id:"100",kind:"hint",score:99,text:${JSON.stringify(text || "Synthetic unrelated text")},createdAt:"${postedAt}",sourceUrl:"https://x.com/thsottiaux/status/100",author:$R[2]={username:"thsottiaux"}}]</script>`);
}) as typeof fetch);
service.signalCollector.poll=()=>collector.poll(true);
const inner=startDashboard(service,config);
const outer=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const url=new URL(request.url);url.port=String(inner.port);
  const response=await fetch(new Request(url,request));
  if(url.pathname!=="/api/status")return response;
  const payload=await response.json() as any;
  return Response.json({...payload,compaction:await observer.status(),resetSignals:collector.status()});
}});
console.log(JSON.stringify({url:`http://127.0.0.1:${outer.port}`,root}));
let previous="";
let requestBody:Promise<string>|null=null;
const start=async()=>{
 const response=await fetch(relay.baseUrl+"/responses/compact",{method:"POST",headers:{session_id:"11111111-1111-4111-8111-111111111111"},
 body:JSON.stringify({model:"gpt-6-astra",reasoning:{effort:"xhigh"}})});requestBody=response.text();
};
await start();
setInterval(async()=>{
 const stage=(await readFile(stagePath,"utf8").catch(()=>"headers")).trim();
 if(stage===previous)return;previous=stage;
 if(stage==="completed") {upstream.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));upstream.close();await requestBody;}
 if(stage==="failed") {await start();upstream.enqueue(new TextEncoder().encode('data: {"type":"response.failed"}\n\n'));upstream.close();await requestBody;}
 const messages:Record<string,string>={announce:"[검증용] Codex reset is landing by midnight today",update:"[검증용] Codex reset moved to tomorrow",withdraw:"[검증용] No reset tomorrow, cancelled"};
 if(messages[stage]){text=messages[stage]!;await service.collectResetSignals();}
 console.log(JSON.stringify({stage,notifications:service.storage.db.query("SELECT title,disposition FROM app_notification_outbox").all()}));
},500);
let lastReceipts="";
setInterval(()=>{
 const receipts=JSON.stringify(service.storage.db.query("SELECT title,disposition FROM app_notification_outbox").all());
 if(receipts!==lastReceipts){lastReceipts=receipts;console.log(JSON.stringify({receipts:JSON.parse(receipts)}));}
},1000);
