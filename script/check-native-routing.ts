import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { compactionCodexArgs, startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";

// Real installed CLI, isolated profile and unauthenticated loopback fixture.
// This detects CLI argument precedence that mocked launch plans cannot test.
const root = mkdtempSync(join(tmpdir(), "quotapie-native-route-"));
const home = join(root, "home"); mkdirSync(home);
const events: CompactionRequestEvent[] = [];
let bypassed = 0, upstream = 0;
const inherited = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){bypassed++;return Response.json({error:{message:"Wrong fixture route"}},{status:400});}});
const proxy = startCompactionProxy({ taskSavings: {enabled:true,model:"gpt-5.6-luna",effort:"low",testOnly:true},
  savingsModelSupported:()=>true, onRequest:e=>events.push(e), fetchUpstream:async (_url, init)=>{
    upstream++;
    const body=JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array));
    const response={id:"resp_fixture12345",status:"completed",model:body.model,
      output:[{id:"msg_fixture12345",type:"message",role:"assistant",content:[{type:"output_text",text:"Native routing fixture complete."}]}],
      usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    return new Response(`data: ${JSON.stringify({type:"response.completed",response})}\n\n`,{headers:{"content-type":"text/event-stream"}});
  }});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  writeFileSync(join(home,"config.toml"),`cli_auth_credentials_store = "file"\nopenai_base_url = "http://127.0.0.1:${inherited.port}"\n`);
  const env: Record<string,string> = {CODEX_HOME:home,PATH:process.env.PATH??"/usr/bin:/bin",HOME:process.env.HOME!,TERM:"dumb"};
  const child=Bun.spawn([loadConfig().collection.codexCommand,...compactionCodexArgs(proxy.baseUrl,
    ["-c",'approval_policy="never"',"exec","--ephemeral","--skip-git-repo-check","-C",root,"-m","gpt-6-astra",
      "-c",'model_reasoning_effort="xhigh"',"--json","Run npm test and report results."])
      .map(arg => arg.startsWith("model_providers.quotapie_compaction={")
        ? arg.replace('name="OpenAI"', 'name="Offline fixture"').replace("requires_openai_auth=true", "requires_openai_auth=false") : arg)],
    {cwd:root,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  let timedOut=false;timer=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");},20_000);
  const [stdout,,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const completed=stdout.split("\n").some(line=>{try{return JSON.parse(line).type==="turn.completed";}catch{return false;}});
  const applied=events.some(e=>e.phase==="completed"&&e.savingsReason==="test_only"&&e.responseModel==="gpt-5.6-luna");
  const passed=!timedOut&&code===0&&completed&&applied&&upstream===1&&bypassed===0;
  console.log(JSON.stringify({component:"native-cli-routing",result:passed?"pass":"fail",code,timedOut,completed,applied,upstream,bypassed,liveProvider:false,failures:events.filter(e=>e.phase==="failed"||e.phase==="unverified").slice(0,2).map(e=>({phase:e.phase,errorCode:e.errorCode})),nativeErrors:stdout.split("\n").flatMap(line=>{try{const e=JSON.parse(line);return e.type==="turn.failed"?[e.error?.message?.replace(/(?:https?|wss?):\/\/[^\s]+/g,"[endpoint]")]:[];}catch{return [];}})}));
  if(!passed)process.exitCode=1;
} finally {clearTimeout(timer);proxy.stop();inherited.stop(true);rmSync(root,{recursive:true,force:true});}
