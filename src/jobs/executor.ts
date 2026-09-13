import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface JobStepInput {
  provider: "codex" | "claude";
  executable: string;
  profileRoot: string;
  cwd: string;
  prompt: string;
  model?: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface JobStepResult {
  kind: "succeeded" | "quota" | "failed" | "uncertain";
  output?: string;
  sessionId?: string;
  reason: string;
  retryAtMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STDOUT_LIMIT = 2 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const QUOTA_CODES = new Set([
  "rate_limit", "rate_limit_error", "rate_limit_exceeded", "usage_limit_reached",
  "quota_exceeded", "insufficient_quota",
]);

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : null;
}

function authenticationError(value: unknown): boolean {
  if (value === "authentication_failed" || value === "authentication_error") return true;
  const entry = object(value);
  return entry !== null && ([entry.code, entry.type, entry.error_code, entry.error].some(
    code => code === "authentication_failed" || code === "authentication_error",
  ) || entry.api_error_status === 401);
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// Only error envelopes are inspected. Tool output and human-readable messages are
// deliberately excluded: "429", "overloaded", etc. can occur in ordinary work.
function quotaError(value: unknown, now: number, depth = 0): { retryAtMs?: number } | null {
  if (depth > 3) return null;
  if (typeof value === "string") return QUOTA_CODES.has(value) ? {} : null;
  const entry = object(value);
  if (!entry) return null;
  const nested = quotaError(entry.error, now, depth + 1);
  const knownCode = [entry.code, entry.type, entry.error_code].some(
    code => typeof code === "string" && QUOTA_CODES.has(code),
  );
  const status429 = [entry.status, entry.status_code, entry.statusCode, entry.http_status,
    entry.error_status, entry.api_error_status].some(code => code === 429);
  if (!knownCode && !status429 && !nested) return null;
  let retryAtMs = nested?.retryAtMs;
  for (const key of ["retryAtMs", "retry_at_ms", "reset_at_ms"]) {
    const time = entry[key];
    if (typeof time === "number" && Number.isSafeInteger(time) && time > now) retryAtMs = time;
  }
  for (const key of ["retry_at", "resets_at", "reset_at"]) {
    const time = entry[key];
    const parsed = typeof time === "number" ? time * 1000
      : typeof time === "string" ? Date.parse(time) : NaN;
    if (Number.isSafeInteger(parsed) && parsed > now) retryAtMs = parsed;
  }
  for (const [key, scale] of [["retry_after_ms", 1], ["retry_after", 1000]] as const) {
    const delay = entry[key];
    if (typeof delay === "number" && Number.isFinite(delay) && delay > 0 && delay <= 31 * 86400_000 / scale) {
      retryAtMs = now + Math.ceil(delay * scale);
    }
  }
  return retryAtMs === undefined ? {} : { retryAtMs };
}

function executionEnvironment(input: JobStepInput): NodeJS.ProcessEnv {
  // An allowlist also excludes custom API-key variables, cloud provider routing,
  // injected Node options and credentials inherited from the hosting AI session.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  if (input.provider === "codex") env.CODEX_HOME = input.profileRoot;
  else if (canonicalPath(input.profileRoot) !== canonicalPath(resolve(homedir(), ".claude"))) {
    // Claude's default native login uses the unqualified Keychain service.
    // Explicitly setting even ~/.claude selects a different credential namespace.
    env.CLAUDE_CONFIG_DIR = input.profileRoot;
  }
  return env;
}

function argumentsFor(input: JobStepInput): string[] {
  if (input.provider === "codex") {
    // exec's sandbox option precedes the resume subcommand, which does not itself
    // accept --sandbox. Never use --last: the task owns one exact native session.
    const args = ["exec", "--sandbox", "workspace-write"];
    if (input.sessionId) args.push("resume", input.sessionId);
    args.push("--json");
    if (input.model) args.push("--model", input.model);
    args.push("-");
    return args;
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"];
  if (input.sessionId) args.push("--resume", input.sessionId);
  if (input.model) args.push("--model", input.model);
  return args;
}

class ExecutionEvents {
  sessionId?: string;
  output?: string;
  invalid = false;
  sessionMismatch = false;
  terminal: "success" | "failure" | null = null;
  quota: { retryAtMs?: number } | null = null;
  permissionDenied = false;
  private agentMessage = false;
  private failureReason = "provider-turn-failed";

  constructor(private provider: JobStepInput["provider"], sessionId?: string | null) {
    this.sessionId = sessionId ?? undefined;
  }

  private acceptSession(value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== "string" || !UUID.test(value)) { this.invalid = true; return; }
    if (this.sessionId && this.sessionId.toLowerCase() !== value.toLowerCase()) this.sessionMismatch = true;
    else this.sessionId = value;
  }

  line(line: string): void {
    if (!line.trim()) return;
    let event: ObjectValue | null;
    try { event = object(JSON.parse(line)); } catch { this.invalid = true; return; }
    if (!event || typeof event.type !== "string") { this.invalid = true; return; }
    if (this.provider === "codex") this.codex(event);
    else this.claude(event);
  }

  private codex(event: ObjectValue): void {
    if (event.type === "thread.started") this.acceptSession(event.thread_id);
    if (event.type === "turn.started") {
      this.terminal = null;
      this.quota = null;
      this.agentMessage = false;
      this.output = undefined;
      this.failureReason = "provider-turn-failed";
    }
    const item = object(event.item);
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      this.agentMessage = item.text.trim().length > 0;
      this.output = item.text;
    }
    if (event.type === "error" || event.type === "turn.failed") {
      this.quota = quotaError(event, Date.now()) ?? this.quota;
      // This provider rejection is actionable without retaining its raw detail.
      // Inspect only the CLI error envelope, never agent/tool output or stderr.
      const message = event.type === "error" ? event.message : object(event.error)?.message;
      if (typeof message === "string" && message.includes("requires a newer version of Codex")) {
        this.failureReason = "cli-update-required";
      }
      this.terminal = "failure";
    }
    if (event.type === "turn.completed") {
      this.terminal = this.agentMessage ? "success" : null;
      this.quota = null; // A recovered transient error is not a quota pause.
    }
  }

  private claude(event: ObjectValue): void {
    // Subagent events can carry their own session identifiers and results.
    if (event.parent_tool_use_id != null) return;
    if (event.type === "system" && event.subtype === "init") this.acceptSession(event.session_id);
    if (event.type === "assistant" && event.error !== undefined) {
      this.quota = quotaError(event.error, Date.now()) ?? this.quota;
      if (authenticationError(event.error)) this.failureReason = "auth-required";
      if (event.error === "oauth_org_not_allowed") this.failureReason = "provider-access-denied";
    }
    if (event.type === "system" && event.subtype === "permission_denied") this.permissionDenied = true;
    if (event.type !== "result") return;
    // Follow-up results from background tasks do not complete the submitted step.
    const origin = object(event.origin);
    if (origin && origin.kind !== "user") return;
    this.acceptSession(event.session_id);
    this.permissionDenied ||= Array.isArray(event.permission_denials) && event.permission_denials.length > 0;
    const blocked = event.stop_reason === "tool_deferred" ||
      (typeof event.terminal_reason === "string" && event.terminal_reason !== "completed");
    if (event.subtype === "success" && event.is_error === false && !blocked && !this.permissionDenied && typeof event.result === "string") {
      this.output = event.result;
      this.terminal = "success";
      this.quota = null;
    } else {
      this.terminal = "failure";
      this.quota = quotaError(event, Date.now()) ?? this.quota;
      if (authenticationError(event)) this.failureReason = "auth-required";
    }
  }

  result(exitCode: number | null, stopped?: string): JobStepResult {
    const context = { ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.output !== undefined ? { output: this.output } : {}) };
    if (stopped) return { ...context, kind: "uncertain", reason: stopped };
    if (this.sessionMismatch) return { ...context, kind: "uncertain", reason: "session-mismatch" };
    if (this.invalid) return { ...context, kind: "uncertain", reason: "invalid-event-stream" };
    if (this.permissionDenied) return { ...context, kind: "uncertain", reason: "permission-required" };
    if (exitCode === 0 && this.terminal === "success") return { ...context, kind: "succeeded", reason: "completed" };
    if (this.quota) return { ...context, ...this.quota, kind: "quota", reason: "provider-quota" };
    if (this.terminal === "failure") return { ...context, kind: "uncertain", reason: this.failureReason };
    return { ...context, kind: "uncertain", reason: exitCode === 0 ? "completion-missing" : "process-exited-without-completion" };
  }
}

/** Run one explicitly authorized job step. Does not approve, retry or schedule work. */
export async function executeJobStep(input: JobStepInput): Promise<JobStepResult> {
  if ((input.provider !== "codex" && input.provider !== "claude") ||
      basename(input.executable) !== input.provider ||
      (input.executable !== input.provider && !isAbsolute(input.executable)) ||
      !isAbsolute(input.profileRoot) || !isAbsolute(input.cwd) ||
      !input.prompt.trim() || Buffer.byteLength(input.prompt) > STDOUT_LIMIT ||
      (input.sessionId != null && !UUID.test(input.sessionId)) ||
      (input.model !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model)) ||
      (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0))) {
    return { kind: "failed", reason: "invalid-arguments" };
  }
  if (input.signal?.aborted) return { kind: "failed", reason: "aborted-before-start", ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
  const events = new ExecutionEvents(input.provider, input.sessionId);
  return await new Promise<JobStepResult>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executable, argumentsFor(input), {
        cwd: input.cwd, env: executionEnvironment(input), shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { resolve({ kind: "failed", reason: "process-start-failed", ...(input.sessionId ? { sessionId: input.sessionId } : {}) }); return; }
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopped: string | undefined;
    let finished = false;
    let spawned = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string): void => {
      if (finished || exited || stopped) return;
      stopped = reason;
      // Only this invocation's child is signalled. Never kill by name/session ID.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1000);
    };
    const timeout = setTimeout(() => stop("timeout"), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const abort = (): void => stop("aborted");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      input.signal?.removeEventListener("abort", abort);
      if (!stopped) events.line(buffer + decoder.end());
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(events.result(code, stopped));
    };
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => {
      if (!spawned) {
        finished = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", abort);
        resolve({ kind: "failed", reason: "process-start-failed", ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
      } else stop("process-error");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stopped || finished) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT) { stop("stdout-limit"); return; }
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        events.line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    // Count and discard diagnostics. Raw stderr can contain credentials/URLs.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > STDERR_LIMIT) stop("stderr-limit");
    });
    child.stdout?.on("error", () => stop("stdout-error"));
    child.stderr?.on("error", () => stop("stderr-error"));
    child.stdin?.on("error", () => stop("stdin-error"));
    child.once("exit", (code: number | null) => {
      exited = true;
      // A descendant can retain pipes after the CLI exits. Don't wait forever
      // or report a complete stream when it never closes.
      drainTimer = setTimeout(() => { stopped ??= "stream-close-missing"; finish(code); }, 1000);
    });
    child.once("close", (code: number | null) => finish(code));
    child.stdin?.end(input.prompt);
  });
}
