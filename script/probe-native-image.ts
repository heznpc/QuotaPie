// Opt-in live subscription verification. Uses a private disposable profile and
// one image request. Never sends a message to an existing desktop conversation.
import { copyFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const [account, runtimeRoot] = process.argv.slice(2);
if (!account || !runtimeRoot) throw new Error("Usage: bun script/probe-native-image.ts ACCOUNT RUNTIME_ROOT");
const root = resolve(runtimeRoot);
const {loadConfig,codexProfileRoot} = await import(pathToFileURL(join(root,"src/config.ts")).href);
const {startCompactionProxy,compactionCodexArgs} = await import(pathToFileURL(join(root,"src/codex-compaction.ts")).href);
const {createSubscriptionGuard} = await import(pathToFileURL(join(root,"src/subscription-guard.ts")).href);
const config=loadConfig(), profile=config.accounts.codex.find((p: any)=>p.id===account&&p.enabled);
if(!profile) throw new Error("Enabled subscription profile required");
const sourceHome=codexProfileRoot(profile), run=mkdtempSync(join(tmpdir(),"quotapie-native-image-"));
const home=join(run,"profile"), workspace=join(run,"workspace");mkdirSync(home,{mode:0o700});mkdirSync(workspace,{mode:0o700});
copyFileSync(join(sourceHome,"auth.json"),join(home,"auth.json"));
writeFileSync(join(home,"config.toml"),'cli_auth_credentials_store = "file"\n[features]\nimage_generation = true\nremote_plugin = false\napps = false\n');
const guard=createSubscriptionGuard({codexHome:sourceHome,sourceAccount:account,config:()=>config,quotaObservationMode:"advisory"});
const requests: {path:string;status:number}[]=[];
let imageAttempts=0;
const proxy=startCompactionProxy({subscriptionGuard:guard,fetchUpstream:async(url:string,init:RequestInit)=>{
  const path=new URL(url).pathname;
  if (/\/images\/(generations|edits)$/.test(path) && ++imageAttempts>1)
    return Response.json({error:{message:"The one-image probe budget is exhausted.",code:"probe_budget_exhausted"}},{status:400});
  const response=await fetch(url,init);requests.push({path,status:response.status});return response;
}});
let timer: ReturnType<typeof setTimeout>|undefined;
try {
  const env={...process.env,CODEX_HOME:home,TERM:"dumb"};
  for(const key of ["OPENAI_API_KEY","OPENAI_BASE_URL","OPENAI_API_BASE","CHATGPT_BASE_URL","CODEX_THREAD_ID","CODEX_SESSION_ID"])
    delete (env as Record<string,unknown>)[key];
  const child=Bun.spawn([config.collection.codexCommand,...compactionCodexArgs(proxy.baseUrl,["-c",'approval_policy="never"',"exec","--skip-git-repo-check","--sandbox","workspace-write","-C",workspace,"-m","gpt-6-astra","-c",'model_reasoning_effort="low"',"--json",
    "This is an authorized native image generation integration test. Use the native image generation tool exactly once to make a plain blue square with no text. Let the native tool save its generated image in its normal output directory. Do not use shell, Python, SVG, browser, or other tools as a substitute. Do not read other files. Stop after the native generation result; if the native tool fails, report failure without retrying."])],{cwd:workspace,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  let timedOut=false;timer=setTimeout(()=>{timedOut=true;child.kill("SIGTERM");},180_000);
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const native=stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const images: string[]=[];
  function inspect(directory:string){for(const item of readdirSync(directory,{withFileTypes:true})){
    const path=join(directory,item.name);if(item.isDirectory())inspect(path);
    else if(/\.png$/i.test(item.name)&&statSync(path).size>100&&
      readFileSync(path).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))images.push(path);
  }}inspect(workspace);
  const generated=join(home,"generated_images");if(existsSync(generated))inspect(generated);
  const imageRequests=requests.filter(r=>/\/images\/(generations|edits)$/.test(r.path));
  const passed=!timedOut&&code===0&&native.some(e=>e.type==="turn.completed")&&images.length>0&&imageRequests.length===1&&imageRequests[0]!.status===200;
  const report={passed,code,timedOut,requests,images,workspace,
    nativeErrors:native.filter(e=>e.type==="turn.failed"||e.type==="error").map(e=>String(e.error?.message??e.message??"").replace(/(?:https?|wss?):\/\/\S+/g,"[endpoint]")),
    stderrPresent:!!stderr};
  writeFileSync(join(run,"result.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));if(!passed)process.exitCode=1;
} finally {clearTimeout(timer);proxy.stop();rmSync(join(home,"auth.json"),{force:true});}
