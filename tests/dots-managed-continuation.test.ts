import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { resumeProfileKey, type ResumeGate } from "../src/resume-gate";
import { prepareManagedContinuation, runManagedContinuation, spawnManagedChild, type ManagedRunOptions, type ManagedProcessPlan } from "../src/dots/managed-continuation";
import type { DotPolicy } from "../src/dots/store";
import type { ProfileThreadStatus } from "../src/dots/thread-reader";
import type { SubscriptionGuardState } from "../src/subscription-guard";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const threadId = "11111111-2222-3333-4444-555555555555", turnId = "22222222-2222-3333-4444-555555555555";
const claimId = "33333333-2222-3333-4444-555555555555";
const now = 2_000_000_000_000;
const event = (type: string) => JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), type: "event_msg", payload: { type, turn_id: turnId } }) + "\n";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-managed-continuation-"))); roots.push(root);
  mkdirSync(join(root, "sessions")); mkdirSync(join(root, "thread-writer-locks"));
  const path = join(root, "sessions", "rollout.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n" + JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } }) + "\n" + event("task_started") + event("task_complete"));
  const db = new Database(join(root, "state_5.sqlite"));
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)");
  db.run("INSERT INTO threads VALUES (?,?,?)", [threadId, path, root]); db.close();
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "plus", label: "Plus", enabled: true, codexHome: root }];
  const policy: DotPolicy = { id: "original", threadId, account: "plus", profileKey: resumeProfileKey(config, "codex", "plus")!,
    accountKey: "a".repeat(64), executionMode: "profile-managed", continuation: "Report once without tools.", enabled: true,
    trigger: "quota.ready", reservePercent: 20, maxTurns: 1, maxUsagePercent: 5, expiresAtMs: now + 60000, priority: 0, resetWithinMinutes: 30 };
  const status: ProfileThreadStatus = { targetId: policy.id, threadId, found: true, title: "Original", account: "plus", appServerStatus: "notLoaded",
    runtimeStateVerified: false, resumeAllowed: false, evidence: { profileMatched: true, accountMatched: true, sessionMetadataMatched: true, rolloutPathMatched: true } };
  const windows = [{ bucket: "codex:primary:300", remainingPercent: 80, reservePercent: 10, observedAtMs: now - 1000, resetsAtMs: now + 3600000 }];
  const gate: ResumeGate = { schemaVersion: 1, provider: "codex", account: "plus", profileKey: policy.profileKey, accountKey: policy.accountKey,
    ready: true, reason: "ready", checkedAtMs: now, retryAtMs: null, windows };
  const state: SubscriptionGuardState = { version: 1, account: "plus", profileKey: policy.profileKey, ready: true, reason: "ready", checkedAtMs: now, windows };
  const plans: ManagedProcessPlan[] = [], prompts: string[] = [], kills: string[] = [], guardOptions: any[] = [], guardChecks: Array<{ model?: string } | undefined> = [];
  let stopped = 0, allowed = true;
  const output = [JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning transcript" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "One approved report." } }), JSON.stringify({ type: "turn.completed" })];
  const options: ManagedRunOptions = {
    readExecutionConfig: async () => ({ mcpServers: ["local-server", "namespaced.server"], unchanged: () => true }),
    now: () => now, stillAuthorized: () => allowed, threadStatus: status, readGate: async () => gate, binary: () => "/official/bundled/codex",
    guard: options => { guardOptions.push(options); return { intervalMs: 500,
      check: request => { guardChecks.push(request); return state; }, checkIdentity: () => state }; },
    proxy: () => ({ baseUrl: "http://127.0.0.1:12345/fixture/backend-api/codex", stop() { stopped++; } }),
    spawn: plan => { plans.push(plan); return { stdout: (async function* () { yield Buffer.from(output.join("\n") + "\n"); })(),
      stderr: (async function* () {})(), exited: Promise.resolve(0), sendPrompt(prompt) { prompts.push(prompt); }, kill(signal) { kills.push(signal); } }; },
  };
  return { root, path, config, policy, input: { config, policy, claimId }, options, plans, prompts, kills, guardOptions, guardChecks, output,
    get stopped() { return stopped; }, setAllowed: (value: boolean) => { allowed = value; } };
}

test("preparation exposes only a terminal lifecycle snapshot, never a verified native lock", async () => {
  const f = fixture(); f.policy.enabled = false;
  const result = await prepareManagedContinuation(f.config, f.policy, f.options);
  expect(result).toMatchObject({ ready: true, nativeThreadId: threadId, runtimeStateVerified: false, nativeWriterLockVerified: false,
    lastLifecycle: { type: "task_complete", atMs: now - 1000 } });
  expect(JSON.stringify(result)).not.toContain(f.root); expect(f.plans).toHaveLength(0);
});

test("unclosed turns and any existing native writer lock fail closed", async () => {
  const f = fixture(); appendFileSync(f.path, event("task_started"));
  expect(await prepareManagedContinuation(f.config, f.policy, f.options)).toMatchObject({ ready: false, reason: "native-turn-active" });
  appendFileSync(f.path, event("turn_aborted"));
  expect((await prepareManagedContinuation(f.config, f.policy, f.options)).ready).toBeTrue();
  writeFileSync(join(f.root, "thread-writer-locks", threadId + ".lock"), "");
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 0, reason: "native-writer-present" });
  expect(f.plans).toHaveLength(0);
});

test("one fixed UUID uses stdin, read-only sandbox, subscription auth, fixed relay and existing model", async () => {
  const f = fixture();
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "must-not-inherit";
  try {
    expect(await runManagedContinuation(f.input, f.options)).toEqual({ nativeThreadId: threadId, outcome: "completed", reason: "completed", attempts: 1, report: "One approved report." });
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
  const plan = f.plans[0]!;
  expect(f.plans).toHaveLength(1); expect(f.prompts).toEqual([f.policy.continuation]); expect(plan.env.CODEX_HOME).toBe(f.root);
  expect(plan.env).not.toHaveProperty("OPENAI_API_KEY"); expect(plan.args).not.toContain(f.policy.continuation);
  expect(plan.args.slice(-7)).toEqual(["exec", "--sandbox", "read-only", "resume", threadId, "--json", "-"]);
  expect(plan.args).toContain('forced_login_method="chatgpt"'); expect(plan.args).toContain('cli_auth_credentials_store="file"');
  expect(plan.args).toContain('model="gpt-6.1-sol"'); expect(plan.args).toContain('model_reasoning_effort="high"'); expect(plan.args.join(" ")).toContain("http://127.0.0.1:12345/fixture/backend-api/codex");
  expect(plan.args.join(" ")).toContain("request_max_retries=0,stream_max_retries=0");
  expect(plan.args).toContain('mcp_servers={"local-server"={enabled=false},"namespaced.server"={enabled=false}}');
  for (const flag of ["plugins", "apps", "hooks", "goals", "multi_agent", "remote_plugin", "shell_tool", "unified_exec"])
    expect(plan.args).toContain(`features.${flag}=false`);
  expect(plan.args).toContain("orchestrator.mcp.enabled=false");
  expect(plan.args).toContain("notify=[]"); expect(plan.args).toContain('web_search="disabled"');
  expect(f.guardOptions[1].minimumReserveByBucket).toEqual({ "codex:primary:300": 75 });
  expect(f.guardChecks.every(check => check?.model === "gpt-6.1-sol")).toBeTrue();
  expect(f.guardOptions[1].baselineResetsAtByBucket).toEqual({ "codex:primary:300": now + 3600000 }); expect(f.stopped).toBe(1);
});

test("disabled, native-mode, exhausted or revoked policies cannot spawn", async () => {
  for (const patch of [{ enabled: false }, { executionMode: "native" as const }, { maxTurns: 2 }, { expiresAtMs: now }]) {
    const f = fixture(); Object.assign(f.policy, patch);
    expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 0 }); expect(f.plans).toHaveLength(0);
  }
  const f = fixture(); f.setAllowed(false);
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 0 });
});

test("reviewed work keeps the original tools and workspace-write without report restrictions", async () => {
  const f = fixture(); Object.assign(f.policy, { executionPurpose: "continue-work", maxDurationSeconds: 3600, maxTurns: 3 });
  f.output[1] = JSON.stringify({ type: "item.completed", item: { type: "command_execution", exit_code: 0 } });
  const previous = process.env.QUOTAPIE_FIXTURE_TOOL_ENV, apiKey = process.env.OPENAI_API_KEY;
  process.env.QUOTAPIE_FIXTURE_TOOL_ENV = "original-tool-value"; process.env.OPENAI_API_KEY = "must-not-inherit";
  try {
    expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "completed", attempts: 1 });
  } finally {
    if (previous === undefined) delete process.env.QUOTAPIE_FIXTURE_TOOL_ENV; else process.env.QUOTAPIE_FIXTURE_TOOL_ENV = previous;
    if (apiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = apiKey;
  }
  const plan = f.plans[0]!;
  expect(plan.args.slice(-7)).toEqual(["exec", "--sandbox", "workspace-write", "resume", threadId, "--json", "-"]);
  expect(plan.args).toContain('model="gpt-6.1-sol"'); expect(plan.args).toContain('model_reasoning_effort="high"');
  expect(plan.args).toContain("never"); expect(plan.args).toContain('forced_login_method="chatgpt"');
  expect(plan.args.some(value => value.startsWith("features.") || value.startsWith("mcp_servers=") || value.startsWith("web_search="))).toBeFalse();
  expect(plan.args).not.toContain("notify=[]"); expect(plan.env.QUOTAPIE_FIXTURE_TOOL_ENV).toBe("original-tool-value");
  expect(plan.env).not.toHaveProperty("OPENAI_API_KEY"); expect(f.kills).toEqual([]);
});

test("work requires an explicit duration and unknown execution purposes cannot spawn", async () => {
  for (const patch of [{ executionPurpose: "continue-work" }, { executionPurpose: "continue-work", maxDurationSeconds: 0 },
    { executionPurpose: "unknown", maxDurationSeconds: 3600 }]) {
    const f = fixture(); Object.assign(f.policy, patch);
    expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 0 });
    expect(f.plans).toHaveLength(0);
  }
});

test("work is cancelled at its explicitly reviewed duration", async () => {
  const f = fixture(); Object.assign(f.policy, { executionPurpose: "continue-work", maxDurationSeconds: 1 });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  f.options.spawn = plan => { f.plans.push(plan); return {
    stdout: (async function* () { await exited; })(), stderr: (async function* () {})(), exited,
    sendPrompt() {}, kill(signal) { f.kills.push(signal); resolveExit(1); },
  }; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "continuation-timeout", attempts: 1 });
  expect(f.kills).toEqual(["SIGTERM"]);
});

test("owned process-group cleanup stops a tool child even when the CLI leader exits first", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-owned-processes-")); roots.push(root);
  const heartbeat = join(root, "heartbeat");
  const tool = `const {writeFileSync}=require("node:fs");process.on("SIGTERM",()=>{});let n=0;writeFileSync(${JSON.stringify(heartbeat)},String(n));console.log("tool-ready");setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},String(++n)),10);`;
  const leader = `const tool=Bun.spawn([process.execPath,"-e",${JSON.stringify(tool)}],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});await tool.exited;`;
  const child = spawnManagedChild({ binary: process.execPath, args: ["-e", leader], cwd: root, env: { PATH: process.env.PATH } });
  try {
    const ready = (async () => { for await (const chunk of child.stdout) if (new TextDecoder().decode(chunk).includes("tool-ready")) return; throw new Error("fixture-not-ready"); })();
    await ready;
    child.kill("SIGTERM"); await child.exited;
    await child.cleanup!();
    // The isolation sandbox can deny process-group inventory even after exit.
    // Its fail-closed proof is tested separately; the known tool PID below must be gone.
    expect(typeof child.ownedGroupStopped?.()).toBe("boolean");
    const stopped = readFileSync(heartbeat, "utf8");
    await Bun.sleep(60);
    expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
  } finally { child.kill("SIGKILL"); child.disposeStreams?.(); await child.cleanup?.(); }
});

test("another thread ID in native output stops the owned child and is never retried", async () => {
  const f = fixture(); f.output[0] = JSON.stringify({ type: "thread.started", thread_id: turnId });
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 1, reason: "continuation-thread-mismatch" });
  expect(f.plans).toHaveLength(1); expect(f.kills).toContain("SIGTERM");
});

test("native writer errors fail closed without returning diagnostics or replaying", async () => {
  const f = fixture(); f.output.splice(0, f.output.length, JSON.stringify({ type: "error", message: "thread already has an active writer /private/secret" }));
  const result = await runManagedContinuation(f.input, f.options);
  expect(result).toMatchObject({ outcome: "failed", attempts: 1, reason: "native-writer-conflict" });
  expect(JSON.stringify(result)).not.toContain("private"); expect(f.plans).toHaveLength(1);
});

test("authentication and stale-observation failures cannot re-arm as quota recovery", async () => {
  for (const code of ["subscription_account_identity_changed", "subscription_quota_stale", "subscription_model_unverified",
    "subscription_quota_exhausted", "subscription_reserve_reached"]) {
    const f = fixture();
    f.output.splice(1, f.output.length, JSON.stringify({ type: "turn.failed", error: { code } }));
    expect((await runManagedContinuation(f.input, f.options)).outcome).toBe(
      ["subscription_quota_exhausted", "subscription_reserve_reached"].includes(code) ? "quota-blocked" : "failed");
    expect(f.plans).toHaveLength(1);
  }
});

test("only the final agent report is returned and is bounded to 1000 characters", async () => {
  const f = fixture(); f.output[2] = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(2000) } });
  const result = await runManagedContinuation(f.input, f.options);
  expect(result.report).toHaveLength(1000); expect(JSON.stringify(result)).not.toContain("private reasoning transcript");
});

test("dispatch rechecks the lifecycle after preparing the relay", async () => {
  const f = fixture(), proxy = f.options.proxy!;
  f.options.proxy = (...args) => { const result = proxy(...args); appendFileSync(f.path, event("task_started")); return result; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 0 });
  expect(f.plans).toHaveLength(0); expect(f.stopped).toBe(1);
});

test("wrong-thread model requests are rejected at the fixed relay before spawning", async () => {
  const f = fixture(), proxy = f.options.proxy!;
  f.options.proxy = (config, root, policy, guard) => {
    expect(guard.check({ model: "gpt-6-astra", headers: new Headers({ "thread-id": turnId }) }).ready).toBeFalse();
    return proxy(config, root, policy, guard);
  };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", attempts: 0 }); expect(f.plans).toHaveLength(0);
});

test("revocation stops only the invocation child within the authorization polling interval", async () => {
  const f = fixture(); let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  f.options.spawn = plan => { f.plans.push(plan); return {
    stdout: (async function* () { await exited; })(), stderr: (async function* () {})(), exited,
    sendPrompt() { f.setAllowed(false); }, kill(signal) { f.kills.push(signal); resolveExit(1); },
  }; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "continuation-authorization-ended", attempts: 1 });
  expect(f.plans).toHaveLength(1); expect(f.kills).toContain("SIGTERM");
});

test("a prompt pipe failure terminates and reaps its child without retry", async () => {
  const f = fixture(); let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  f.options.spawn = plan => { f.plans.push(plan); return {
    stdout: (async function* () { await exited; })(), stderr: (async function* () {})(), exited,
    sendPrompt() { throw new Error("private pipe detail"); }, kill(signal) { f.kills.push(signal); resolveExit(1); },
  }; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "continuation-input-failed", attempts: 1 });
  expect(f.kills).toEqual(["SIGTERM"]); expect(f.stopped).toBe(1);
});

test("exited children cannot leave a stalled output stream holding the runner forever", async () => {
  const f = fixture(); let dispose!: () => void, disposed = 0;
  const streamClosed = new Promise<void>(resolve => { dispose = resolve; });
  f.options.spawn = plan => { f.plans.push(plan); return {
    stdout: (async function* () { await streamClosed; })(), stderr: (async function* () {})(), exited: Promise.resolve(1),
    sendPrompt() {}, kill(signal) { f.kills.push(signal); }, disposeStreams() { disposed++; dispose(); },
  }; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "continuation-output-unavailable", attempts: 1 });
  expect(disposed).toBeGreaterThan(0); expect(f.kills).toEqual([]); expect(f.stopped).toBe(1);
});


test("a login change between the quota gate and final guard binding cannot dispatch", async () => {
  const f = fixture(), readGate = f.options.readGate!; let calls = 0;
  f.options.readGate = async policy => { const gate = await readGate(policy); return ++calls > 1 ? { ...gate, accountKey: "b".repeat(64) } : gate; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "policy-or-quota-hold", attempts: 0 });
  expect(calls).toBe(2); expect(f.plans).toHaveLength(0);
});

test("the original turn model is required rather than silently selecting the current profile default", async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n" + event("task_complete"));
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "thread-model-unverified", attempts: 0 });
  expect(f.plans).toHaveLength(0);
});


test("an unexpected tool item fails the report-only execution even if the model later reports success", async () => {
  const f = fixture(); f.output[1] = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "private" } });
  const result = await runManagedContinuation(f.input, f.options);
  expect(result).toMatchObject({ outcome: "failed", reason: "continuation-tool-violation", attempts: 1 });
  expect(JSON.stringify(result)).not.toContain("private"); expect(f.kills).toContain("SIGTERM");
});

test("a config layer changed after snapshot cannot reach the child", async () => {
  const f = fixture(); f.options.readExecutionConfig = async () => ({ mcpServers: [], unchanged: () => false });
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "dispatch-precondition-changed", attempts: 0 });
  expect(f.plans).toHaveLength(0);
});


test("a rejected exit promise still terminates the owned child and returns within the cleanup deadline", async () => {
  const f = fixture();
  f.options.spawn = plan => { f.plans.push(plan); return {
    stdout: (async function* () {})(), stderr: (async function* () {})(), exited: Promise.reject(new Error("private exit detail")),
    sendPrompt() {}, kill(signal) { f.kills.push(signal); },
  }; };
  expect(await runManagedContinuation(f.input, f.options)).toMatchObject({ outcome: "failed", reason: "continuation-exit-unverified", attempts: 1 });
  expect(f.kills).toEqual(["SIGTERM", "SIGKILL"]); expect(f.stopped).toBe(1);
});

test("intentional managed stop requires owned group proof independently of leader exit", async () => {
  for (const proven of [false, true]) {
    const f=fixture(); Object.assign(f.policy,{executionPurpose:"continue-work",maxDurationSeconds:1});
    let resolveExit!:(code:number)=>void;
    const exited=new Promise<number>(resolve=>{resolveExit=resolve;});
    let cleaned=false;
    f.options.spawn=()=>({stdout:(async function*(){await exited;})(),stderr:(async function*(){})(),exited,
      sendPrompt(){f.setAllowed(false);},kill(){resolveExit(1);},async cleanup(){cleaned=true;},
      ownedGroupStopped:()=>proven&&cleaned});
    const result=await runManagedContinuation(f.input,f.options);
    expect(result.reason).toBe("continuation-authorization-ended");
    expect(result.processStopped).toBe(proven?true:undefined);
  }
});
