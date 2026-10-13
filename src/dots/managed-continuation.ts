import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { codexProfileRoot, type AppConfig } from "../config";
import { AccountPool, poolAccounts, readPoolPolicy } from "../account-pool";
import { readCodexForkParent } from "../account-pool-lineage";
import { compactionCodexArgs, startCompactionProxy } from "../codex-compaction";
import { codexRequestIdentity } from "../codex-request-identity";
import { createSubscriptionGuard, type SubscriptionGuard } from "../subscription-guard";
import { gateAllows, readGate } from "./policy";
import { findBundledCodex, metadataPath, readConfiguredThread, readExecutionConfiguration, type ProfileThreadStatus } from "./thread-reader";
import type { DotPolicy } from "./store";
import type { ResumeGate } from "../resume-gate";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const QUOTA_HOLDS = new Set(["reserve-reached", "quota-exhausted", "upstream-quota-hold"]);
type Lifecycle = { type: "task_complete" | "turn_aborted"; atMs: number };
export interface ManagedPreparation {
  ready: boolean;
  reason: string;
  nativeThreadId: string;
  lastLifecycle: Lifecycle | null;
  runtimeStateVerified: false;
  nativeWriterLockVerified: false;
}
interface PreparationOptions {
  threadStatus?: ProfileThreadStatus;
  readThread?: typeof readConfiguredThread;
  now?: () => number;
}
export interface ManagedChild {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  sendPrompt(prompt: string): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  disposeStreams?(): void;
  cleanup?(): Promise<void>;
}
export interface ManagedProcessPlan { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export interface ManagedRunOptions extends PreparationOptions {
  stillAuthorized: () => boolean;
  readGate?: (policy: DotPolicy) => Promise<ResumeGate>;
  binary?: () => string | null;
  readExecutionConfig?: typeof readExecutionConfiguration;
  guard?: typeof createSubscriptionGuard;
  proxy?: (config: AppConfig, root: string, policy: DotPolicy, guard: SubscriptionGuard) => { baseUrl: string; stop(): void };
  spawn?: (plan: ManagedProcessPlan) => ManagedChild;
}
export interface ManagedContinuationResult {
  nativeThreadId: string;
  outcome: "completed" | "quota-blocked" | "failed";
  reason: string;
  attempts: 0 | 1;
  report?: string;
}

/** A lock file's absence and a completed rollout are only a snapshot. The
 * official CLI must still acquire its own native writer lock at dispatch.
 * Never acquire/remove another owner's lock or terminate that owner here. */
function inspectLifecycle(config: AppConfig, policy: DotPolicy) {
  const profile = config.accounts.codex.find(p => p.enabled && p.id === policy.account);
  if (!profile) throw new Error("profile-unavailable");
  const root = realpathSync(codexProfileRoot(profile));
  try {
    lstatSync(join(root, "thread-writer-locks", policy.threadId + ".lock"));
    throw new Error("native-writer-present");
  } catch (error: any) { if (error?.code !== "ENOENT") throw new Error("native-writer-present"); }
  const path = metadataPath(root, policy.threadId);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("lifecycle-unverified");
    const size = Math.min(before.size, 16 * 1024 * 1024), start = before.size - size;
    const bytes = Buffer.alloc(size), count = readSync(fd, bytes, 0, size, start);
    if (count !== size || (size && bytes.at(-1) !== 10)) throw new Error("lifecycle-unverified");
    const lines = bytes.toString("utf8").split("\n");
    if (start) lines.shift();
    let latest: { type: string; atMs: number; turnId: string } | null = null;
    let started: string | null = null;
    let model: string | null = null, effort: string | null = null;
    for (const line of lines) {
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { throw new Error("lifecycle-unverified"); }
      if (entry?.type === "turn_context") {
        const candidate = entry.payload?.model, reasoning = entry.payload?.effort;
        if (typeof candidate !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(candidate) ||
            (reasoning != null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoning)))
          throw new Error("thread-model-unverified");
        model = candidate; effort = reasoning ?? null;
      }
      if (entry?.type !== "event_msg") continue;
      const type = entry.payload?.type;
      if (!["task_started", "task_complete", "turn_aborted", "turn_failed"].includes(type)) continue;
      const atMs = Date.parse(entry.timestamp), turnId = entry.payload?.turn_id;
      if (!Number.isFinite(atMs) || typeof turnId !== "string" || !UUID.test(turnId)) throw new Error("lifecycle-unverified");
      if (type === "task_started") started = turnId;
      else if (started && started !== turnId) throw new Error("lifecycle-unverified");
      latest = { type, atMs, turnId };
    }
    if (!model) throw new Error("thread-model-unverified");
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
      throw new Error("lifecycle-changed");
    if (!latest || !["task_complete", "turn_aborted"].includes(latest.type))
      throw new Error(latest?.type === "task_started" ? "native-turn-active" : "lifecycle-unverified");
    const database = readdirSync(root).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0]!;
    const db = new Database(join(root, database), { readonly: true, strict: true });
    let cwd: string;
    try {
      const row = db.query<{ cwd: string; rollout_path: string }, [string]>("SELECT cwd,rollout_path FROM threads WHERE id=?").get(policy.threadId);
      if (!row || !isAbsolute(row.cwd) || realpathSync(row.rollout_path) !== path) throw new Error("thread-profile-unverified");
      cwd = realpathSync(row.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("workspace-unavailable");
    } finally { db.close(); }
    return { root, cwd, model, effort, stamp: `${path}:${after.ino}:${after.size}:${after.mtimeMs}`,
      lastLifecycle: { type: latest.type, atMs: latest.atMs } as Lifecycle };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function prepareManagedContinuation(config: AppConfig, policy: DotPolicy, options: PreparationOptions = {}): Promise<ManagedPreparation> {
  const result: ManagedPreparation = { ready: false, reason: "managed-mode-required", nativeThreadId: policy.threadId,
    lastLifecycle: null, runtimeStateVerified: false, nativeWriterLockVerified: false };
  if (policy.executionMode !== "profile-managed" || !UUID.test(policy.threadId)) return result;
  try {
    const thread = options.threadStatus ?? await (options.readThread ?? readConfiguredThread)(config, policy);
    if (!thread.found || thread.threadId !== policy.threadId || thread.targetId !== policy.id || thread.account !== policy.account ||
        !thread.evidence.profileMatched || !thread.evidence.accountMatched || !thread.evidence.sessionMetadataMatched || !thread.evidence.rolloutPathMatched)
      throw new Error("thread-profile-unverified");
    const snapshot = inspectLifecycle(config, policy);
    if (snapshot.lastLifecycle.atMs > (options.now ?? Date.now)()) throw new Error("lifecycle-unverified");
    return { ...result, ready: true, reason: "ready-native-lock-required", lastLifecycle: snapshot.lastLifecycle };
  } catch (error) {
    const code = error instanceof Error && /^[a-z-]{3,80}$/.test(error.message) ? error.message : "managed-preflight-unavailable";
    return { ...result, reason: code };
  }
}

function environment(root: string, reportOnly: boolean): NodeJS.ProcessEnv {
  // Work keeps the profile's existing tool environment. Provider credentials
  // and endpoint overrides cannot replace the fixed ChatGPT relay identity.
  const env: NodeJS.ProcessEnv = reportOnly ? {} : { ...process.env };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT_ID", "CHATGPT_BASE_URL"])
    delete env[key];
  return { ...env, CODEX_HOME: root, TERM: "dumb", NO_COLOR: "1" };
}
function startProxy(config: AppConfig, root: string, policy: DotPolicy, guard: SubscriptionGuard) {
  const pool = new AccountPool({ sourceAccount: policy.account, accounts: () => poolAccounts(config), policy: readPoolPolicy,
    forkParent: threadId => readCodexForkParent(root, threadId) });
  try {
    const proxy = startCompactionProxy({ accountPool: pool, subscriptionGuard: guard, reportOnly: policy.executionPurpose !== "continue-work",
      route: { from: "gpt-6-astra", to: "gpt-6-astra" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } });
    return { baseUrl: proxy.baseUrl, stop() { proxy.stop(); pool.close(); } };
  } catch (error) { pool.close(); throw error; }
}
export function spawnManagedChild(plan: ManagedProcessPlan): ManagedChild {
  // A distinct session owns the CLI and the shell/MCP children it starts. Only
  // this invocation's process group may be signalled, never the desktop owner.
  const child = Bun.spawn([plan.binary, ...plan.args], { cwd: plan.cwd, env: plan.env,
    detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
    try { process.kill(-child.pid, signal); } catch (error: any) { if (error?.code !== "ESRCH") throw error; }
  };
  const groupExists = () => {
    try { process.kill(-child.pid, 0); return true; } catch (error: any) { if (error?.code === "ESRCH") return false; throw error; }
  };
  const out = child.stdout.getReader(), err = child.stderr.getReader();
  const chunks = async function* (reader: ReadableStreamDefaultReader<Uint8Array>) {
    try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } }
    finally { reader.releaseLock(); }
  };
  return { stdout: chunks(out), stderr: chunks(err), exited: child.exited,
    sendPrompt(prompt) { child.stdin.write(prompt); child.stdin.end(); },
    kill: signalGroup,
    async cleanup() {
      if (!groupExists()) return;
      signalGroup("SIGTERM");
      // A CLI can exit before a tool that ignores TERM. Do not use only the
      // leader's exit promise as proof that its owned process group is gone.
      const deadline = performance.now() + 1000;
      while (groupExists() && performance.now() < deadline) await Bun.sleep(20);
      if (groupExists()) signalGroup("SIGKILL");
    },
    disposeStreams() {
      for (const reader of [out, err]) { try { void reader.cancel().catch(() => {}); } catch { /* Already released. */ } }
    } };
}

/** Executes one already-dispatched claim. The caller owns the durable single-use
 * lease; this adapter never claims, schedules, retries or chooses another task. */
export async function runManagedContinuation(input: { config: AppConfig; policy: DotPolicy; claimId: string }, options: ManagedRunOptions): Promise<ManagedContinuationResult> {
  const { config, policy } = input, now = options.now ?? Date.now;
  const reportOnly = policy.executionPurpose !== "continue-work";
  const durationSeconds = policy.maxDurationSeconds ?? (reportOnly ? 60 : NaN);
  let attempts: 0 | 1 = 0;
  const failed = (reason: string): ManagedContinuationResult => ({ nativeThreadId: policy.threadId, outcome: "failed", reason, attempts });
  const authorized = () => {
    try { return policy.enabled && policy.executionMode === "profile-managed" &&
      (policy.executionPurpose == null || ["report-check", "continue-work"].includes(policy.executionPurpose)) &&
      Number.isInteger(policy.maxTurns) && policy.maxTurns >= 1 && policy.maxTurns <= 100 && (!reportOnly || policy.maxTurns === 1) &&
      Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= (reportOnly ? 60 : 7 * 86400) &&
      policy.expiresAtMs > now() && UUID.test(input.claimId) && options.stillAuthorized() === true; }
    catch { return false; }
  };
  if (!authorized() || !policy.continuation.trim() || policy.continuation.length > 2000 ||
      !Number.isFinite(policy.maxUsagePercent) || policy.maxUsagePercent <= 0 || policy.maxUsagePercent > 100)
    return failed("managed-policy-not-authorized");
  const preparation = await prepareManagedContinuation(config, policy, options);
  if (!preparation.ready) return failed(preparation.reason);
  const gateReader = options.readGate ?? (p => readGate(config, p));
  let gate: ResumeGate;
  try { gate = await gateReader(policy); } catch { return failed("policy-or-quota-hold"); }
  if (!gateAllows(policy, gate, now()) || !authorized()) return failed("policy-or-quota-hold");
  let snapshot: ReturnType<typeof inspectLifecycle>;
  try { snapshot = inspectLifecycle(config, policy); } catch { return failed("dispatch-precondition-changed"); }
  const binary = (options.binary ?? findBundledCodex)();
  if (!binary) return failed("bundled-codex-unavailable");
  let executionConfig: Awaited<ReturnType<typeof readExecutionConfiguration>>;
  try { executionConfig = await (options.readExecutionConfig ?? readExecutionConfiguration)(config, policy, snapshot.cwd); }
  catch { return failed("execution-config-unverified"); }
  const guardOptions = { codexHome: snapshot.root, sourceAccount: policy.account, config: () => config };
  const createGuard = options.guard ?? createSubscriptionGuard;
  const baseline = createGuard(guardOptions).check({ model: snapshot.model });
  if (!baseline.ready || baseline.profileKey !== policy.profileKey || !baseline.windows.length) return failed("subscription-guard-hold");
  const minimumReserveByBucket: Record<string, number> = {}, baselineResetsAtByBucket: Record<string, number> = {};
  for (const w of baseline.windows) {
    if (w.remainingPercent == null || w.resetsAtMs == null) return failed("subscription-budget-unverified");
    minimumReserveByBucket[w.bucket] = Math.max(policy.reservePercent, w.remainingPercent - policy.maxUsagePercent);
    baselineResetsAtByBucket[w.bucket] = w.resetsAtMs;
  }
  const sourceGuard = createGuard({ ...guardOptions, minimumReserveByBucket, baselineResetsAtByBucket });
  // Bind the guard's captured credential identity to the durable policy account,
  // even if authentication changed after the earlier quota gate.
  try { gate = await gateReader(policy); } catch { return failed("policy-or-quota-hold"); }
  if (!gateAllows(policy, gate, now()) || !sourceGuard.check({ model: snapshot.model }).ready || !authorized()) return failed("policy-or-quota-hold");
  let blocked: string | null = null;
  const guard: SubscriptionGuard = { intervalMs: 500, observeResponse: status => sourceGuard.observeResponse?.(status),
    checkIdentity(request) {
      const state = sourceGuard.checkIdentity(request);
      return authorized() ? state : { ...state, ready: false, reason: "continuation-authorization-ended" };
    },
    check(request) {
      const state = sourceGuard.check({ ...request, model: request?.model ?? snapshot.model });
      const mismatch = request?.headers && request.model !== undefined && codexRequestIdentity(request.headers).threadId !== policy.threadId;
      const reason = blocked ?? (!authorized() ? "continuation-authorization-ended" : mismatch ? "continuation-thread-mismatch" : !state.ready ? state.reason : null);
      if (reason) { blocked = reason; return { ...state, ready: false, reason }; }
      return state;
    } };
  let proxy: { baseUrl: string; stop(): void } | undefined;
  try {
    proxy = (options.proxy ?? startProxy)(config, snapshot.root, policy, guard);
    if (!executionConfig.unchanged() || !guard.check().ready || !authorized() || inspectLifecycle(config, policy).stamp !== snapshot.stamp)
      return failed("dispatch-precondition-changed");
    const disabledFeatures = ["hooks", "goals", "multi_agent", "apps", "plugins", "remote_plugin", "shell_tool", "unified_exec", "skill_mcp_dependency_install"];
    const mcp = `mcp_servers={${executionConfig.mcpServers.map(name => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
    const reportRestrictions = reportOnly ? [...disabledFeatures.flatMap(name => ["-c", `features.${name}=false`]),
      "-c", "orchestrator.mcp.enabled=false", "-c", "notify=[]", "-c", 'web_search="disabled"', "-c", "apps._default.enabled=false", "-c", mcp] : [];
    const args = compactionCodexArgs(proxy.baseUrl, ["-a", "never", ...reportRestrictions,
      "-c", `model=${JSON.stringify(snapshot.model)}`,
      ...(snapshot.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(snapshot.effort)}`] : []),
      "-c", 'forced_login_method="chatgpt"',
      "-c", 'cli_auth_credentials_store="file"', "exec", "--sandbox", reportOnly ? "read-only" : "workspace-write", "resume", policy.threadId, "--json", "-"]);
    // This table is generated above, never supplied by the caller. Pin native
    // transport retries too: one managed attempt must not reconnect/replay.
    const providerIndex = args.findIndex(arg => arg.startsWith("model_providers.quotapie_compaction={"));
    if (providerIndex < 0 || !args[providerIndex]!.endsWith("}")) return failed("managed-provider-unverified");
    args[providerIndex] = args[providerIndex]!.slice(0, -1) + ",request_max_retries=0,stream_max_retries=0}";
    const child = (options.spawn ?? spawnManagedChild)({ binary, args, cwd: snapshot.cwd, env: environment(snapshot.root, reportOnly) });
    attempts = 1;
    let stopped: string | null = null, finished = false, exited = false, matched = false, complete = false, report = "", quota = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined, stopDeadline: ReturnType<typeof setTimeout> | undefined;
    let resolveStopped!: (value: { code: number; exited: false }) => void;
    const stoppedExit = new Promise<{ code: number; exited: false }>(resolve => { resolveStopped = resolve; });
    const stop = (reason: string) => {
      if (finished || stopped) return;
      stopped = reason;
      if (!exited) {
        child.kill("SIGTERM"); hardKill = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1000);
        stopDeadline = setTimeout(() => resolveStopped({ code: 1, exited: false }), 1500);
      }
    };
    const authTimer = setInterval(() => { if (!authorized()) stop("continuation-authorization-ended"); }, 500);
    const timeout = setTimeout(() => stop("continuation-timeout"), Math.min(durationSeconds * 1000, policy.expiresAtMs - now()));
    const stdout = (async () => {
      const decoder = new TextDecoder(); let buffer = "", bytes = 0;
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        if (reportOnly && bytes > 2 * 1024 * 1024) { stop("continuation-output-limit"); break; }
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          if (line.length > 2 * 1024 * 1024) { stop("continuation-output-limit"); break; }
          let event: any;
          try { event = JSON.parse(line); } catch { stop("continuation-invalid-output"); continue; }
          if (event.type === "thread.started") {
            if (event.thread_id !== policy.threadId) stop("continuation-thread-mismatch"); else matched = true;
          }
          if (reportOnly && ["item.started", "item.updated", "item.completed"].includes(event.type) &&
              !["agent_message", "reasoning"].includes(event.item?.type)) stop("continuation-tool-violation");
          if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string")
            report = event.item.text.slice(0, 1000);
          if (["error", "turn.failed"].includes(event.type)) {
            const error = event.error ?? event, text = typeof error.message === "string" ? error.message : "";
            quota ||= error.status === 429 || error.api_error_status === 429 ||
              /^(?:subscription_(?:reserve_reached|quota_exhausted|upstream_quota_hold)$|quota_|usage_limit|rate_limit)/.test(String(error.code ?? error.type ?? ""));
            stop(text.includes("active writer") || text.includes("thread writer lock") ? "native-writer-conflict" : quota ? "subscription-quota-blocked" : "continuation-provider-failed");
          }
          if (event.type === "turn.completed") complete = true;
        }
        if (buffer.length > 2 * 1024 * 1024) { stop("continuation-output-limit"); break; }
      }
      if (buffer.trim()) stop("continuation-truncated-output");
    })().catch(() => stop("continuation-output-unavailable"));
    const stderr = (async () => {
      const decoder = new TextDecoder(); let tail = "", size = 0;
      for await (const chunk of child.stderr) {
        size += chunk.length; tail = (tail + decoder.decode(chunk, { stream: true })).slice(-512);
        if (tail.includes("active writer") || tail.includes("thread writer lock")) stop("native-writer-conflict");
        if (reportOnly && size > 262144) { stop("continuation-diagnostic-limit"); break; }
      }
    })().catch(() => stop("continuation-output-unavailable"));
    try {
      if (!authorized()) stop("continuation-authorization-ended");
      else { try { child.sendPrompt(policy.continuation); } catch { stop("continuation-input-failed"); } }
      const exitResult = await Promise.race([child.exited.then(code => ({ code, exited: true })).catch(async () => {
        stop("continuation-exit-unverified"); return stoppedExit;
      }), stoppedExit]);
      const code = exitResult.code; exited = exitResult.exited;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([Promise.all([stdout, stderr]).then(() => true),
          new Promise<false>(resolve => { drainTimer = setTimeout(() => resolve(false), 1000); })]);
        if (!drained) { stop("continuation-output-unavailable"); child.disposeStreams?.(); }
      } finally { clearTimeout(drainTimer); }
      finished = true;
      const blockedReason = blocked as string | null;
      if (blockedReason && !QUOTA_HOLDS.has(blockedReason)) return failed(blockedReason);
      if (blocked || quota) return { nativeThreadId: policy.threadId, outcome: "quota-blocked", reason: blocked ?? "subscription-quota-blocked", attempts };
      if (stopped) return failed(stopped);
      if (code !== 0 || !matched || !complete || !report.trim()) return failed("continuation-completion-unverified");
      return { nativeThreadId: policy.threadId, outcome: "completed", reason: "completed", attempts, report };
    } finally {
      finished = true; clearInterval(authTimer); clearTimeout(timeout); clearTimeout(hardKill); clearTimeout(stopDeadline);
      child.disposeStreams?.();
      await child.cleanup?.();
    }
  } catch { return failed("managed-execution-unavailable"); }
  finally { proxy?.stop(); }
}
