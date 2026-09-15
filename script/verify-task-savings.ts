// Explicit, bounded real-provider smoke test. Prompts and credentials never enter the report.
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { startCompactionProxy, compactionCodexArgs, type CompactionRequestEvent } from "../src/codex-compaction";
const root = await mkdtemp(join(tmpdir(),"quotapie-savings-live-"));
await writeFile(join(root,"index.html"),'<button id="save">Save</button>\n');
const events:CompactionRequestEvent[]=[];
const catalog=JSON.parse(await readFile(join(homedir(),".codex/models_cache.json"),"utf8"));
const supported=catalog.models.some((m:any)=>m.slug==='gpt-5.6-luna' && m.supported_reasoning_levels.some((r:any)=>r.effort==='low'));
let shape:unknown=null;
const proxy=startCompactionProxy({taskSavings:{enabled:true,model:'gpt-5.6-luna',effort:'low'},savingsModelSupported:()=>supported,
 onRequest:event=>{events.push(event);console.log(JSON.stringify({phase:event.phase,from:event.from,to:event.to,reason:event.savingsReason,responseModel:event.responseModel}));},
 fetchUpstream:async(url,init)=>{
  if(url.endsWith('/responses')) {
   const body=JSON.parse(String(init.body));
   shape={inputArray:Array.isArray(body.input),roles:body.input?.map((i:any)=>({type:i.type,role:i.role,contentType:typeof i.content,parts:Array.isArray(i.content)?i.content.map((p:any)=>({type:p.type,length:p.text?.length})):null}))};
  }
  return fetch(url,init);
 }});
const installed=process.argv.includes("--installed");
let endpoint=proxy.baseUrl;
if(installed) {
 const manifest=JSON.parse(await readFile(join(homedir(),".local/lib/quotapie-compaction/current.json"),"utf8"));
 const settings=JSON.parse(await readFile(manifest.settings_path,"utf8"));
 endpoint=`http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex`;
 const health=await(await fetch(endpoint+"/quotapie-health")).json() as any;
 if(!health.taskSavings?.enabled) throw new Error("Enable task savings in QuotaPie before the installed smoke test");
}
const binary=process.argv.find(arg=>arg.endsWith('/codex')) ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
const args=compactionCodexArgs(endpoint,['-s','workspace-write','-a','never','-c','model_reasoning_effort="xhigh"','exec','--skip-git-repo-check','--json','-C',root,'-m','gpt-6-astra','Change the button label in index.html from "Save" to "Done".']);
const child=Bun.spawn([binary,...args],{stdout:'pipe',stderr:'pipe'});
const timeout=setTimeout(()=>child.kill('SIGKILL'),90000);
try {
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 if(installed) {
  const thread=stdout.split('\n').flatMap(l=>{try{const e=JSON.parse(l);return e.type==='thread.started'?[e.thread_id]:[];}catch{return[];}})[0];
  const health=await(await fetch(endpoint+"/quotapie-health")).json() as any;
  events.push(...health.recent.filter((e:any)=>e.threadId===thread));
 }
 const result={exitCode:code,correct:await readFile(join(root,'index.html'),'utf8')==='<button id="save">Done</button>\n',supported,events,shape,
  providerEvents:stdout.split('\n').flatMap(l=>{try{return [JSON.parse(l).type];}catch{return[];}}),stderrPresent:stderr.length>0};
 await writeFile(join(root,'report.json'),JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify({report:join(root,'report.json'),exitCode:code,correct:result.correct,events:events.length,shape}));
}finally{clearTimeout(timeout);proxy.stop();}
