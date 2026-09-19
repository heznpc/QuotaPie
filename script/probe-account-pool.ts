// Explicit live test: sends a short synthetic prompt using registered logins.
// Uses private temporary profiles and never rewrites a user's auth/config files.
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool, poolAccounts } from "../src/account-pool";
import { codexProfileRoot, loadConfig } from "../src/config";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";

const installed = process.argv.includes("--installed");
const config = loadConfig(), accounts = poolAccounts(config);
const source = accounts.find(a => a.id === (process.argv.slice(2).find(a => !a.startsWith("--")) ?? "default"));
const target = accounts.find(a => a.id !== source?.id && a.remaining != null && a.remaining > 0);
if (!source || !target) throw new Error("Two healthy file-backed logins required");
const run = mkdtempSync(join(tmpdir(), "quotapie-pool-"));
const home = join(run,"profile"), workspace = join(run,"workspace");
mkdirSync(home, {mode:0o700}); mkdirSync(workspace,{mode:0o700});
symlinkSync(join(codexProfileRoot(config.accounts.codex.find(p => p.id === source.id)!),"auth.json"),join(home,"auth.json"));
const evidence: CompactionRequestEvent[] = [];
const pool = installed ? null : new AccountPool({path:join(run,"routing.sqlite3"),sourceAccount:source.id,
  accounts:() => poolAccounts(config).map(a=>a.id === source.id ? {...a, remaining:0} : a),
  policy:()=>({enabled:true,accounts:[source.id,target.id]})});
const proxy = pool ? startCompactionProxy({accountPool:pool,taskSavings:{enabled:false,model:"gpt-5.6-luna",effort:"low"},
  onRequest:e=>evidence.push(e)}) : null;
const baseUrl = proxy?.baseUrl ?? JSON.parse(readFileSync(join(codexProfileRoot(config.accounts.codex.find(p => p.id === source.id)!),"config.toml"),"utf8").match(/^openai_base_url\s*=\s*(.+)$/m)?.[1] ?? "null");
if (typeof baseUrl !== "string" || new URL(baseUrl).hostname !== "127.0.0.1") throw new Error("Local installed relay required");
const collect = async (thread: string) => {
  if (!installed) return;
  const health = await (await fetch(baseUrl + "/quotapie-health")).json() as {accountPoolVersion?:number;recent:CompactionRequestEvent[]};
  if (health.accountPoolVersion !== 1) throw new Error("Installed relay lacks account pool support");
  evidence.splice(0, evidence.length, ...health.recent.filter(e=>e.threadId===thread));
};
writeFileSync(join(home,"config.toml"),`openai_base_url = ${JSON.stringify(baseUrl)}\ncli_auth_credentials_store = "file"\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[features]\nremote_plugin = false\napps = false\n`,{mode:0o600});
let exit = 1;
try {
  const child = Bun.spawn([config.collection.codexCommand,"exec","--skip-git-repo-check","--json","-C",workspace,
    "Do not use tools. Reply with exactly QUOTAPIE_POOL_OK."],
    {env:{...process.env,CODEX_HOME:home},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const timer = setTimeout(()=>child.kill("SIGTERM"),90_000);
  const [stdout,stderr,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  clearTimeout(timer);
  const thread = stdout.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(e=>e?.type==="thread.started")?.thread_id;
  if (installed && typeof thread !== "string") throw new Error("No observed Codex thread identity");
  await collect(thread);
  let resumed=false;
  if (code===0) {
    const followup=Bun.spawn([config.collection.codexCommand,"exec","resume","--last","--skip-git-repo-check","--json",
      "Do not use tools. Repeat the exact marker from your previous reply."],
      {cwd:workspace,env:{...process.env,CODEX_HOME:home},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
    const deadline=setTimeout(()=>followup.kill("SIGTERM"),90_000);
    const [output,,followupCode]=await Promise.all([new Response(followup.stdout).text(),new Response(followup.stderr).text(),followup.exited]);
    clearTimeout(deadline);
    await collect(thread);
    resumed=followupCode===0&&output.includes("QUOTAPIE_POOL_OK")&&evidence.some(e=>e.phase==="completed"&&e.accountRouting?.reason==="pinned"&&e.accountRouting.account===target.id);
  }
  const completed = evidence.filter(e=>e.phase === "completed" && e.accountRouting?.account === target.id);
  const report = {code,replyVerified:stdout.includes("QUOTAPIE_POOL_OK"),targetVerified:completed.length>0,
    installed,sourceQuotaSimulated:!installed,desktopPreflightVerified:false,resumed,
    events:evidence.map(e=>({phase:e.phase,status:e.status,account:e.accountRouting?.account,reason:e.accountRouting?.reason,errorCode:e.errorCode})),
    // Error codes only; never print provider payloads or prompts.
    failureCodes:[...new Set(stderr.match(/pool_[a-z_]+/g)??[])],
    run};
  console.log(JSON.stringify(report,null,2));
  writeFileSync(join(run,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  exit=code===0&&report.replyVerified&&report.targetVerified&&resumed?0:1;
} finally {proxy?.stop();pool?.close();}
process.exitCode=exit;
