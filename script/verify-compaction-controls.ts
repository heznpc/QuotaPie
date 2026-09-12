// Isolated native UI verification. No provider credentials or live inference.
// bun script/verify-compaction-controls.ts /tmp/quotapie-controls-stage
// Write finish, next, finish-next to the stage file. The app can save its model
// through the production authenticated API while the first request is held.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { appendFileSync, watchFile, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { startCompactionProxy, validateCompactionRoute, type CompactionRoute } from "../src/codex-compaction";

const stagePath = process.argv[2]; if (!stagePath) throw new Error("Stage path required");
const root = await mkdtemp(join(tmpdir(), "quotapie-controls-smoke-"));
const generation = join(root, "releases", "1"); await mkdir(generation, {recursive: true});
const route: CompactionRoute = {from:"gpt-6-astra",to:"gpt-5.6-sol",effort:"low"};
const token = "ab".repeat(24);
let upstream!: ReadableStreamDefaultController<Uint8Array>;
const relay = startCompactionProxy({ route, token, onRequest: event => appendFileSync(join(generation,"relay.log"),JSON.stringify(event)+"\n"),
  fetchUpstream: async (_url, init) => {
    const body=JSON.parse(String(init.body));
    const compact=body.input?.at(-1)?.type==="compaction_trigger";
    return new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode(": fixture\n\n"));
      if(compact) upstream=controller;
      else { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));controller.close(); }
    }}), {headers:{"content-type":"text/event-stream"}});
  }});
const settingsPath=join(generation,"settings.json");
await writeFile(settingsPath,JSON.stringify({port:Number(new URL(relay.baseUrl).port),token,route}),{mode:0o600});
await writeFile(join(root,"current.json"),JSON.stringify({settings_path:settingsPath,retired_settings:[]}));
watchFile(settingsPath,{interval:200},async()=>{Object.assign(route,validateCompactionRoute(JSON.parse(await readFile(settingsPath,"utf8")).route));});
const config=structuredClone(DEFAULT_CONFIG);config.dashboard.port=0;config.collection.codexEnabled=false;
config.collection.claudeOAuthEnabled=false;config.resetSignals.enabled=false;config.alerts.enabled=false;
const service=new QuotaPieService(config,new QuotaDatabase(":memory:"));
const server=startDashboard(service,config,{compactionRoot:root});
console.log(JSON.stringify({url:`http://127.0.0.1:${server.port}`,root}));
const threadId=randomUUID(); let turnId=randomUUID(); let body:Promise<string>;
const request=async(compact:boolean)=>{
  const response=await fetch(relay.baseUrl+"/responses",{method:"POST",headers:{session_id:threadId,"x-codex-turn-id":turnId},
    body:JSON.stringify({model:"gpt-6-astra",reasoning:{effort:"xhigh"},stream:true,input:compact?[{type:"compaction_trigger"}]:[]})});
  return response.text();
};
body=request(true);
let previous="",busy=false;
const timer=setInterval(async()=>{
  if(busy)return;busy=true;
  try {
    const stage=(await readFile(stagePath,"utf8").catch(()=>"")).trim();
    if(stage===previous)return;previous=stage;
    if(stage==="finish"||stage==="finish-next") {
      upstream.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));upstream.close();
      await body!; await request(false);
    }
    if(stage==="next") {turnId=randomUUID();body=request(true);}
    console.log(JSON.stringify({stage,route}));
  } finally {busy=false;}
},200);
const stop=()=>{clearInterval(timer);unwatchFile(settingsPath);server.stop(true);relay.stop();void service.close();process.exit(0);};
process.once("SIGTERM",stop);process.once("SIGINT",stop);
