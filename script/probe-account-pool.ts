// Explicit live test: sends a short synthetic prompt using registered logins.
// Standalone uses a private profile; installed mode creates a synthetic task in
// the source profile so the daemon can resolve lineage. Neither rewrites config/auth.
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPoolProbeStage, probeReplyMatches, probeFailureCodes, redProbePng } from "../src/pool-probe-evidence";
import { AccountPool, poolAccounts } from "../src/account-pool";
import { codexProfileRoot, loadConfig } from "../src/config";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";

const installed = process.argv.includes("--installed");
const withImage = process.argv.includes("--with-image");
const config = loadConfig(), accounts = poolAccounts(config);
const source = accounts.find(a => a.id === (process.argv.slice(2).find(a => !a.startsWith("--")) ?? "default"));
const target = accounts.find(a => a.id !== source?.id && a.remaining != null && a.remaining > 0);
if (!source || !target) throw new Error("Two healthy file-backed logins required");
const run = mkdtempSync(join(tmpdir(), "quotapie-pool-"));
const sourceHome = codexProfileRoot(config.accounts.codex.find(p => p.id === source.id)!);
const home = installed ? sourceHome : join(run,"profile"), workspace = join(run,"workspace");
if (!installed) mkdirSync(home, {mode:0o700});
mkdirSync(workspace,{mode:0o700});
// Synthetic 64x64 red PNG. The vision prompt does not disclose the color.
const imagePath = join(run, "fixture.png");
if (withImage) writeFileSync(imagePath, redProbePng(), {mode:0o600});
if (!installed) symlinkSync(join(sourceHome,"auth.json"),join(home,"auth.json"));
const evidence: CompactionRequestEvent[] = [];
const pool = installed ? null : new AccountPool({path:join(run,"routing.sqlite3"),sourceAccount:source.id,
  accounts:() => poolAccounts(config).map(a=>a.id === source.id ? {...a, remaining:0} : a),
  policy:()=>({enabled:true,accounts:[source.id,target.id]})});
const proxy = pool ? startCompactionProxy({accountPool:pool,taskSavings:{enabled:false,model:"gpt-5.6-luna",effort:"low"},
  onRequest:e=>evidence.push(e)}) : null;
const baseUrl = proxy?.baseUrl ?? JSON.parse(readFileSync(join(sourceHome,"config.toml"),"utf8").match(/^openai_base_url\s*=\s*(.+)$/m)?.[1] ?? "null");
if (typeof baseUrl !== "string" || new URL(baseUrl).hostname !== "127.0.0.1") throw new Error("Local installed relay required");
const collect = async (thread?: string) => {
  if (!installed) return;
  const health = await (await fetch(baseUrl + "/quotapie-health")).json() as {accountPoolVersion?:number;accountPoolInlineImagesVersion?:number;recent:CompactionRequestEvent[]};
  if (health.accountPoolVersion !== 1) throw new Error("Installed relay lacks account pool support");
  if (withImage && health.accountPoolInlineImagesVersion !== 2) throw new Error("Installed relay lacks inline image evidence support");
  if (thread !== undefined) evidence.splice(0, evidence.length, ...health.recent.filter(e=>e.threadId===thread));
};
// Every turn receives command-local settings. Installed mode must not write the
// source profile's files, and resume must not inherit a more expensive model.
const overrides = [
  `openai_base_url=${JSON.stringify(baseUrl)}`, 'cli_auth_credentials_store="file"',
  'model="gpt-5.6-luna"', 'model_reasoning_effort="low"',
  'approval_policy="never"', 'sandbox_mode="read-only"',
  'features.remote_plugin=false', 'features.apps=false',
].flatMap(setting => ["-c", setting]);
const runTurn = async (prompt: string, options: {thread?: string; image?: string} = {}) => {
  const child = Bun.spawn([config.collection.codexCommand,...overrides,"exec",
    ...(options.thread ? ["resume",options.thread] : []),"--skip-git-repo-check","--json",
    ...(options.image ? ["--image",options.image] : []),prompt],
    {cwd:workspace,env:{...process.env,CODEX_HOME:home},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const timer = setTimeout(()=>child.kill("SIGTERM"),90_000);
  try {
    const [stdout,stderr,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {stdout,stderr,code};
  } finally { clearTimeout(timer); }
};
let exit = 1;
try {
  await collect(); // Reject an old installed relay before spending inference quota.
  const {stdout,stderr,code} = await runTurn("Do not use tools. Reply with exactly QUOTAPIE_POOL_OK.");
  const thread = stdout.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(e=>e?.type==="thread.started")?.thread_id;
  if (installed && typeof thread !== "string") throw new Error("No observed Codex thread identity");
  await collect(thread);
  const initial = verifyPoolProbeStage(evidence, {previousRequestIds:new Set(),thread,account:target.id});
  const seenRequestIds = new Set(evidence.map(e=>e.requestId));
  const stderrStages = [stderr];
  const stages: Record<string, ReturnType<typeof verifyPoolProbeStage>> = {initial};
  let resumed=false, imageFollowupVerified: boolean | null = null;
  if (code===0 && initial.verified) {
    if (typeof thread !== "string") throw new Error("No observed Codex thread identity");
    const {stdout:output,stderr:followupStderr,code:followupCode} = await runTurn(
      withImage ? "Do not use tools. Look at the attached image. Reply exactly IMAGE_ followed by the uppercase English name of its dominant color."
        : "Do not use tools. Repeat the exact marker from your previous reply.",
      {thread,...(withImage ? {image:imagePath} : {})});
    await collect(thread);
    stderrStages.push(followupStderr);
    stages.resume = verifyPoolProbeStage(evidence, {previousRequestIds:seenRequestIds,thread,account:target.id,requirePinned:true,requireImages:withImage});
    for (const e of evidence) seenRequestIds.add(e.requestId);
    resumed=followupCode===0&&probeReplyMatches(output, withImage ? "IMAGE_RED" : "QUOTAPIE_POOL_OK")&&stages.resume.verified;
    if (withImage && resumed) {
      const {stdout:text,stderr:nextStderr,code:exitCode} = await runTurn(
        "Do not use tools. Repeat the exact marker you just gave for the image.", {thread});
      await collect(thread);
      stderrStages.push(nextStderr);
      stages.imageFollowup = verifyPoolProbeStage(evidence, {previousRequestIds:seenRequestIds,thread,account:target.id,requirePinned:true,requireImages:true});
      imageFollowupVerified=exitCode===0&&probeReplyMatches(text,"IMAGE_RED")&&stages.imageFollowup.verified;
    }
  }
  const report = {code,replyVerified:probeReplyMatches(stdout,"QUOTAPIE_POOL_OK"),targetVerified:initial.verified, stages,
    installed,sourceQuotaSimulated:!installed,desktopPreflightVerified:false,resumed,withImage,imageFollowupVerified,
    events:evidence.map(e=>({requestId:e.requestId,inlineImageCount:e.inlineImageCount,phase:e.phase,status:e.status,account:e.accountRouting?.account,reason:e.accountRouting?.reason,errorCode:e.errorCode})),
    // Error codes only; never print provider payloads or prompts.
    failureCodes:probeFailureCodes(stderrStages,evidence),
    run};
  console.log(JSON.stringify(report,null,2));
  writeFileSync(join(run,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  exit=code===0&&report.replyVerified&&report.targetVerified&&resumed&&(!withImage||imageFollowupVerified===true)?0:1;
} finally {proxy?.stop();pool?.close();}
process.exitCode=exit;
