import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type AppConfig, resolveUserPath } from "../config";
import { executionEnvironment, executeJobStep, type JobStepInput, type JobStepResult } from "../jobs/executor";
import { readClaudeCredentialsAsync, fetchClaudeUsage } from "../providers/claude-oauth";
import { resumeProfileKey } from "../resume-gate";
import { findClaudeResumeTarget, resumeTaskKey, resumeWorkingDirectoryAvailable } from "../session-discovery";
import type { WorkPolicy, WorkProvider, WorkResult } from "./types";
import { workPolicyExpiresAtMs } from "./lifetime";

export interface WorkTarget { provider: WorkProvider; account: string; nativeSessionId: string }
export interface WorkBinding {
  profileKey: string; accountKey: string; cwd: string; nativeSessionId: string; profileRoot: string; model: string;
}
export interface WorkInspectionOptions {
  executable?: string;
  authStatus?: (profileRoot: string, cwd: string) => Promise<unknown>;
  subscriptionUsage?: (profileRoot: string) => Promise<unknown>;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** Settings are loaded by the CLI after its environment. An env allowlist alone
 * does not establish subscription routing. Refuse ambiguous credential helpers,
 * custom endpoints and cloud routing, including project/managed settings. */
function checkClaudeSettings(root: string, cwd: string): void {
  const paths = [join(root, "settings.json"), "/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"];
  for (let directory = cwd; ; directory = dirname(directory)) {
    paths.push(join(directory, ".claude", "settings.json"), join(directory, ".claude", "settings.local.json"));
    if (dirname(directory) === directory) break;
  }
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let setting: Record<string, any> | null;
    try {
      if (!statSync(path).isFile() || statSync(path).size > 1024 * 1024) throw new Error();
      setting = object(JSON.parse(readFileSync(path, "utf8")));
      if (!setting) throw new Error();
    } catch { throw new Error("claude-settings-unverified"); }
    if (setting.apiKeyHelper != null || setting.forceLoginMethod === "console" ||
      (object(setting.env) && Object.keys(setting.env).some(key =>
        /^(ANTHROPIC_|CLAUDE_CODE_(?:USE_|OAUTH|API|BASE)|CLAUDE_(?:CONFIG_DIR|SECURESTORAGE)|AWS_|GOOGLE_|AZURE_)/.test(key))))
      throw new Error("claude-subscription-routing-unverified");
  }
}

function sessionModel(root: string, nativeSessionId: string): string {
  const projects = join(root, "projects");
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(projects, entry.name, nativeSessionId + ".jsonl");
    if (!existsSync(file)) continue;
    const path = realpathSync(file);
    if (!path.startsWith(projects + "/")) throw new Error("thread-profile-unverified");
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error("thread-profile-unverified");
      const size = Math.min(stat.size, 2 * 1024 * 1024), start = stat.size - size;
      const bytes = Buffer.alloc(size);
      if (readSync(fd, bytes, 0, size, start) !== size) throw new Error("thread-profile-unverified");
      const lines = bytes.toString("utf8").split("\n");
      if (start) lines.shift();
      for (const line of lines.reverse()) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== "assistant" || event.sessionId !== nativeSessionId) continue;
        const model = event.message?.model;
        if (typeof model === "string" && /^claude-[a-zA-Z0-9._-]{1,190}$/.test(model)) return model;
      }
    } finally { closeSync(fd); }
  }
  throw new Error("session-model-unverified");
}

async function readAuthStatus(executable: string, profileRoot: string, cwd: string): Promise<unknown> {
  const child = Bun.spawn([executable, "auth", "status", "--json"], {
    cwd, env: executionEnvironment({ provider: "claude", profileRoot }), stdout: "pipe", stderr: "ignore", timeout: 10_000,
  });
  let bytes = 0, output = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    bytes += chunk.length;
    if (bytes > 65536) { child.kill(); await child.exited; throw new Error("claude-auth-unverified"); }
    output += decoder.decode(chunk, { stream: true });
  }
  if (await child.exited !== 0) throw new Error("claude-auth-required");
  try { return JSON.parse(output + decoder.decode()); } catch { throw new Error("claude-auth-unverified"); }
}

export async function inspectWorkTarget(config: AppConfig, target: WorkTarget, options: WorkInspectionOptions = {}): Promise<WorkBinding> {
  if (target.provider !== "claude") throw new Error("codex-managed-adapter-required");
  if (!UUID.test(target.nativeSessionId)) throw new Error("invalid-native-session");
  const profile = config.accounts.claude.find(p => p.enabled && p.id === target.account);
  if (profile?.desktopBinding) throw new Error("desktop-connection-read-only");
  const profileKey = resumeProfileKey(config, "claude", target.account);
  if (!profile || !profileKey) throw new Error("profile-unavailable");
  // The native CLI cannot be told to use an arbitrary collector-only Keychain
  // service; its login and the quota reader would then refer to different users.
  if (profile.keychainService) throw new Error("custom-credentials-unsupported");
  const profileRoot = realpathSync(resolveUserPath(profile.configDir));
  const session = await findClaudeResumeTarget(profileRoot, target.account, resumeTaskKey("claude", target.account, target.nativeSessionId));
  if (!session || session.nativeId !== target.nativeSessionId || !await resumeWorkingDirectoryAvailable(session.cwd))
    throw new Error("thread-profile-unverified");
  const cwd = realpathSync(session.cwd);
  const model = sessionModel(profileRoot, target.nativeSessionId);
  checkClaudeSettings(profileRoot, cwd);
  const auth = object(await (options.authStatus ?? ((root, directory) => readAuthStatus(options.executable ?? "claude", root, directory)))(profileRoot, cwd));
  if (!auth || auth.loggedIn !== true || auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty" ||
      !["pro", "max", "team", "enterprise"].includes(auth.subscriptionType) ||
      typeof auth.email !== "string" || !auth.email.trim() || typeof auth.orgId !== "string" || !auth.orgId.trim())
    throw new Error("claude-subscription-auth-required");
  // CLI OAuth authentication alone permits paid extra usage when enabled.
  const usage = object(await (options.subscriptionUsage ?? (async (root: string) => {
    const credential = await readClaudeCredentialsAsync(root, profile.keychainService);
    if (!credential.accessToken) throw new Error("claude-subscription-usage-unverified");
    return fetchClaudeUsage(credential.accessToken);
  }))(profileRoot));
  if (object(usage?.extra_usage)?.is_enabled !== false) throw new Error("claude-paid-overage-not-disabled");
  const accountKey = createHash("sha256").update(JSON.stringify(["claude.ai", auth.orgId, auth.email.trim().toLowerCase()])).digest("hex");
  return { profileKey, accountKey, cwd, nativeSessionId: session.nativeId, profileRoot, model };
}

export interface WorkTurnOptions extends WorkInspectionOptions {
  claimId: string; policyRevision: number; episodeId?: string; timeoutMs: number;
  signal?: AbortSignal; stillAuthorized: () => boolean | Promise<boolean>;
  inspect?: typeof inspectWorkTarget;
  execute?: (input: JobStepInput) => Promise<JobStepResult>;
  authorizationIntervalMs?: number;
}
export function progressSchema(claimId: string, revision: number) {
  return { type: "object", additionalProperties: false, properties: {
    claimId: { type: "string", const: claimId }, policyRevision: { type: "integer", const: revision },
    status: { type: "string", enum: ["turn-finished", "objective-completed", "needs-user-input"] },
    summary: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } },
    remainingWork: { type: "string" }, blockingQuestion: { type: "string" },
  }, required: ["claimId", "policyRevision", "status", "summary", "evidenceRefs", "remainingWork", "blockingQuestion"] };
}
export function parseWorkProgress(value: unknown, claimId: string, revision: number): WorkResult | null {
  const p = object(value);
  if (!p || p.claimId !== claimId || p.policyRevision !== revision ||
    !["turn-finished", "objective-completed", "needs-user-input"].includes(p.status) ||
    typeof p.summary !== "string" || !p.summary.trim() || p.summary.length > 16000 ||
    typeof p.remainingWork !== "string" || p.remainingWork.length > 16000 ||
    typeof p.blockingQuestion !== "string" || p.blockingQuestion.length > 4000 ||
    !Array.isArray(p.evidenceRefs) || p.evidenceRefs.length > 50 ||
    p.evidenceRefs.some((ref: unknown) => typeof ref !== "string" || !ref.trim() || ref.length > 2000) ||
    (p.status === "objective-completed" && (p.evidenceRefs.length === 0 || p.remainingWork.trim())) ||
    (p.status === "turn-finished" && !p.remainingWork.trim()) ||
    (p.status === "needs-user-input" && !p.blockingQuestion.trim())) return null;
  return { status: p.status, summary: p.summary, evidenceRefs: p.evidenceRefs,
    remainingWork: p.remainingWork, blockingQuestion: p.blockingQuestion, completionAssessment: "model-assessed" };
}

/** One shared claim runs one original Claude session. Scheduling and budget
 * accounting belong to WorkStore; no second local queue or paid API fallback. */
export async function executeWorkTurn(config: AppConfig, policy: WorkPolicy, options: WorkTurnOptions): Promise<WorkResult> {
  const start = Date.now();
  const result = (value: WorkResult): WorkResult => ({ ...value, durationSeconds: (Date.now() - start) / 1000 });
  if (policy.provider !== "claude") return result({ status: "failed", reason: "codex-managed-adapter-required" });
  const timeoutMs = Math.min(options.timeoutMs, policy.maxDurationSeconds * 1000,
    (policy.maxTotalDurationSeconds - policy.state.totalDurationSeconds) * 1000,
    workPolicyExpiresAtMs(policy) - start, (policy.workDeadline ?? Infinity) - start);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return result({ status: "time-budget-ended", reason: "time-budget-ended" });
  if (options.policyRevision !== policy.revision || options.signal?.aborted || !await options.stillAuthorized())
    return result({ status: "uncertain", reason: "authorization-ended" });
  const inspector = options.inspect ?? inspectWorkTarget;
  let binding: WorkBinding;
  try { binding = await inspector(config, policy, options); }
  catch (error) { return result({ status: "failed", reason: error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "target-unverified" }); }
  if (binding.accountKey !== policy.accountKey || binding.profileKey !== policy.profileKey ||
      binding.cwd !== resolve(policy.cwd) || binding.nativeSessionId !== policy.nativeSessionId ||
      (policy.model !== undefined && binding.model !== policy.model))
    return result({ status: "failed", reason: "account-session-mismatch" });
  const controller = new AbortController();
  let stopReason: string | null = null, checking = false;
  const abort = () => { stopReason ??= "authorization-ended"; controller.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  let lastIdentityCheck = Date.now();
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (options.signal?.aborted || !await options.stillAuthorized()) abort();
      if (!controller.signal.aborted && Date.now() - lastIdentityCheck >= 30_000) {
        lastIdentityCheck = Date.now();
        const current = await inspector(config, policy, options);
        if (current.accountKey !== binding.accountKey || current.profileKey !== binding.profileKey || current.cwd !== binding.cwd || current.model !== binding.model)
          throw new Error("account-session-mismatch");
      }
    } catch { stopReason = "authorization-unverified"; controller.abort(); }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, options.authorizationIntervalMs ?? 500);
  try {
    await check();
    if (Date.now() - start >= timeoutMs) return result({ status: "time-budget-ended", reason: "time-budget-ended" });
    const schema = progressSchema(options.claimId, policy.revision);
    const prompt = `${policy.prompt}\n\nObjective: ${policy.objective}\nCompletion criteria:\n${policy.completionCriteria.map(c => "- " + c).join("\n")}\n\nFirst inspect previous work and tool results; do not repeat already completed actions. Finish with the required structured progress result. A finished turn is not automatically a completed objective. claimId=${options.claimId}, policyRevision=${policy.revision}. Include concrete evidence references; describe remainingWork, or a blockingQuestion only if user input is truly required.`;
    const turn = await (options.execute ?? executeJobStep)({ provider: "claude", executable: options.executable ?? "claude",
      profileRoot: binding.profileRoot, cwd: binding.cwd, sessionId: policy.nativeSessionId, model: binding.model,
      prompt, signal: controller.signal, timeoutMs: Math.max(1, Math.floor(timeoutMs - (Date.now() - start))), structuredOutputSchema: schema, verifyOwnedStop: true });
    if (stopReason) return result({ status: stopReason === "authorization-ended" && turn.ownedProcessStopped ? "activity-paused" : "uncertain", reason: stopReason });
    if (turn.reason === "timeout" && turn.ownedProcessStopped) return result({ status: "activity-paused", reason: "turn-duration-ended" });
    if (turn.kind === "quota") return result({ status: "quota-blocked", reason: turn.reason });
    if (turn.kind !== "succeeded") return result({ status: turn.kind === "failed" ? "failed" : "uncertain", reason: turn.reason });
    if (turn.sessionId !== policy.nativeSessionId) return result({ status: "uncertain", reason: "session-mismatch" });
    const progress = parseWorkProgress(turn.structuredOutput, options.claimId, policy.revision);
    return result(progress ?? { status: "uncertain", reason: "progress-result-unverified" });
  } finally { clearInterval(timer); options.signal?.removeEventListener("abort", abort); }
}
