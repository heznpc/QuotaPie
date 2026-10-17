import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { compactionCodexArgs, startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
import type { SubscriptionGuard } from "../src/subscription-guard";

// Exercise the installed CLI against isolated loopback responses. Never load a
// real login or send inference. This checks routing AND what the native client
// considers complete, rather than inferring client behavior from relay tests.
const cases = ["completed", "provider-error", "partial-eof", "completed-disconnect"] as const;
const modes = ["native-default", "managed-opt-in"] as const;
async function check(scenario: typeof cases[number], mode: typeof modes[number]) {
  const root = mkdtempSync(join(tmpdir(), "quotapie-native-route-"));
  const home = join(root, "home"); mkdirSync(home);
  const events: CompactionRequestEvent[] = [];
  let bypassed = 0, upstream = 0;
  const inherited = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){bypassed++;return Response.json({error:{message:"Wrong fixture route"}},{status:400});}});
  const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  // Source authentication itself has separate fixture tests. This guard permits
  // only this injected fake upstream; no login file or production origin is used.
  const fixtureGuard: SubscriptionGuard = { intervalMs: 60_000,
    check: () => ({ version: 1, account: null, profileKey: null, ready: true, reason: "fixture", checkedAtMs: Date.now(), windows: [] }),
    checkIdentity: () => fixtureGuard.check() };
  const proxy = startCompactionProxy({ ...(mode === "native-default"
    ? { executionMode: "interactive" as const, subscriptionGuard: fixtureGuard }
    : { executionMode: "managed" as const, taskSavings: {enabled:true,model:"gpt-5.6-luna" as const,effort:"low" as const,testOnly:true},
      savingsModelSupported:()=>true }), onRequest:e=>events.push(e), fetchUpstream:async (_url, init)=>{
      upstream++;
      const body=JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array));
      const response={id:`resp_fixture${upstream}`,status:"completed",model:body.model,
        output:[{id:`msg_fixture${upstream}`,type:"message",role:"assistant",content:[{type:"output_text",text:"Native routing fixture complete."}]}],
        usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
      if(scenario === "provider-error") return new Response(encode({type:"response.failed",response:{id:response.id,status:"failed",
        error:{code:"server_error",message:"An error occurred while processing your request. Synthetic fixture."}}}),{headers:{"content-type":"text/event-stream"}});
      if(scenario === "partial-eof") return new Response(encode({type:"response.created",response:{...response,status:"in_progress",output:[]}}),{headers:{"content-type":"text/event-stream"}});
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({pull(controller){
        if(!sent){sent=true;controller.enqueue(encode({type:"response.completed",response}));}
        else if(scenario === "completed-disconnect") controller.error(Object.assign(new Error("Synthetic socket reset"),{code:"ECONNRESET"}));
        else controller.close();
      }}),{headers:{"content-type":"text/event-stream"}});
    }});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    writeFileSync(join(home,"config.toml"),`cli_auth_credentials_store = "file"\nopenai_base_url = "http://127.0.0.1:${inherited.port}"\n`);
    const env: Record<string,string> = {CODEX_HOME:home,PATH:process.env.PATH??"/usr/bin:/bin",HOME:process.env.HOME!,TERM:"dumb"};
    const child=Bun.spawn([loadConfig().collection.codexCommand,...compactionCodexArgs(proxy.baseUrl,
      ["-c",'approval_policy="never"',"exec","--ephemeral","--skip-git-repo-check","-C",root,"-m","gpt-6-astra",
        // Offline providers have no model catalog: declare this fixture's
        // reasoning capability or the CLI correctly omits the effort field.
        "-c",'model_reasoning_effort="xhigh"',"-c","model_supports_reasoning_summaries=true","--json","Run npm test and report results."])
        .map(arg => arg.startsWith("model_providers.quotapie_compaction={")
          ? arg.replace('name="OpenAI"', 'name="Offline fixture"').replace("requires_openai_auth=true", "requires_openai_auth=false,request_max_retries=0,stream_max_retries=0") : arg)],
      {cwd:root,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
    let timedOut=false;timer=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");},20_000);
    const [stdout,,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    const native=stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const completed=native.some(e=>e.type==="turn.completed"), failed=native.some(e=>e.type==="turn.failed");
    const terminal=events.filter(e=>["completed","failed","unverified","cancelled"].includes(e.phase));
    const success=scenario === "completed" || scenario === "completed-disconnect";
    const expectedError=scenario === "provider-error" ? "provider_stream_error" : "missing_completion_event";
    const applied=terminal.some(e=>e.savingsReason==="test_only"&&e.responseModel==="gpt-5.6-luna");
    const preserved=terminal.length===1&&terminal[0]!.from==="gpt-6-astra"&&terminal[0]!.to==="gpt-6-astra"&&
      terminal[0]!.routed===false&&terminal[0]!.savingsReason==="disabled";
    const expectedRoute=mode==="native-default" ? preserved&&!applied
      : terminal.length===1&&terminal[0]!.to==="gpt-5.6-luna"&&terminal[0]!.routed===true&&terminal[0]!.savingsReason==="test_only";
    const passed=!timedOut && upstream===1 && bypassed===0 && expectedRoute && (success
      ? code===0&&completed&&!failed&&(mode==="native-default"||applied)&&terminal.length===1&&terminal[0]!.phase==="completed"
      : code!==0&&!completed&&failed&&terminal.length===1&&terminal[0]!.errorCode===expectedError);
    console.log(JSON.stringify({component:"native-cli-routing",mode,scenario,result:passed?"pass":"fail",code,timedOut,completed,failed,applied,preserved,upstream,bypassed,liveProvider:false,
      outcomes:terminal.map(e=>({phase:e.phase,errorCode:e.errorCode,savingsReason:e.savingsReason,from:e.from,to:e.to,routed:e.routed,requestedEffort:e.requestedEffort}))}));
    return passed;
  } finally {clearTimeout(timer);proxy.stop();inherited.stop(true);rmSync(root,{recursive:true,force:true});}
}
for(const mode of modes) for(const scenario of cases) if(!await check(scenario,mode)) process.exitCode=1;
