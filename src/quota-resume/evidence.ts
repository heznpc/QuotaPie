import { Database } from "bun:sqlite";
import { constants, lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { codexProfileRoot, codexUsesFileCredentials, type AppConfig } from "../config";
import { metadataPath } from "../dots/thread-reader";
import { CodexAppServerClient, type CodexThreadTurnSummary } from "../providers/codex-appserver";

export interface QuotaResumeEvidence {
  threadId: string;
  turnId: string;
  failedAtMs: number;
  stamp: string;
  cwd: string;
  model: string;
  /** Present only after the caller verifies this failed turn belongs to its
   * durable prior recovery execution. A prompt marker is not authorization. */
  recoveryIncidentId?: string;
}
export interface QuotaResumeEvidenceOptions {
  /** Must retain the provider client's account/credential identity fence. */
  readLatestTurn?: (threadId: string) => Promise<CodexThreadTurnSummary | null>;
  now?: () => number;
  /** Discovery may display an idle host-owned failure. Execution stays strict. */
  allowNativeWriter?: boolean;
  /** Bind a marked turn to the exact prior execution, not merely its prompt. */
  authorizeRecoveryTurn?: (evidence: QuotaResumeEvidence) => boolean | Promise<boolean>;
}

/** A local quota terminal exists, but its required host validation could not
 * be read. Keep this distinct from a verified non-candidate without exposing
 * provider error text, conversation content or credentials. */
export class QuotaResumeEvidenceUnavailableError extends Error {
  constructor() { super("quota-resume-evidence-unavailable"); this.name = "QuotaResumeEvidenceUnavailableError"; }
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 16 * 1024 * 1024;
const PARSE_SLICE_BYTES = 256 * 1024;
const PARSE_SLICE_MS = 4;
const RECOVERY_PREFIX = /^\[QuotaPie quota recovery:([a-zA-Z0-9_-]{1,128})\]\r?\n/;
function stamp(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function credentialStamp(root: string): string {
  const stat = lstatSync(join(root, "auth.json"));
  if (!stat.isFile()) throw new Error("quota-resume-identity-unverified");
  return stamp(stat);
}
function writerAbsent(root: string, threadId: string): boolean {
  try { lstatSync(join(root, "thread-writer-locks", threadId + ".lock")); return false; }
  catch (error: any) { return error?.code === "ENOENT"; }
}
function userText(entry: any): string | undefined {
  const p = entry?.payload;
  if (entry?.type === "event_msg" && p?.type === "user_message")
    return typeof p.message === "string" ? p.message : "";
  if (entry?.type !== "response_item" || p?.role !== "user") return undefined;
  if (typeof p.content === "string") return p.content;
  if (!Array.isArray(p.content)) return "";
  const first = p.content.find((part: any) => part?.type === "input_text" || part?.type === "text");
  return typeof first?.text === "string" ? first.text : "";
}

/** This file is a quiescent snapshot, not ownership of the native writer lock.
 * task_complete can carry an error; its name alone never proves successful work. */
async function readLocal(config: AppConfig, account: string, threadId: string, nowMs: number, allowNativeWriter = false): Promise<QuotaResumeEvidence | null> {
  const profile = config.accounts.codex.find(p => p.enabled && p.id === account);
  if (!profile || !UUID.test(threadId) || !Number.isFinite(nowMs) || !codexUsesFileCredentials(profile)) return null;
  const root = realpathSync(codexProfileRoot(profile));
  if (!allowNativeWriter && !writerAbsent(root, threadId)) return null;
  const path = metadataPath(root, threadId);
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0) return null;
    const size = Math.min(before.size, TAIL_BYTES), start = before.size - size;
    const bytes = Buffer.alloc(size);
    if ((await file.read(bytes, 0, size, start)).bytesRead !== size || bytes.at(-1) !== 10) return null;
    // Do not decode/split the entire 16 MiB tail. Keep only one bounded record
    // alive at a time and give quota HTTP requests/provider responses time to
    // run while scanning ordinary conversations that have no failed terminal.
    let lineStart = start ? bytes.indexOf(10) + 1 : 0;
    let sliceBytes = 0, sliceLines = 0;
    let sliceStarted = performance.now();
    let model: string | null = null, started: { id: string; atMs: number } | null = null;
    let terminal: { turnId: string; failedAtMs: number } | null = null;
    let sawUser = false, turnOpen = false;
    let currentRecovery: string | null | undefined, pendingRecovery: string | null | undefined;
    const pendingInput = new Set<string>();
    for (let lineEnd; (lineEnd = bytes.indexOf(10, lineStart)) >= 0;) {
      const line = bytes.subarray(lineStart, lineEnd).toString("utf8");
      sliceBytes += lineEnd - lineStart + 1; sliceLines++;
      lineStart = lineEnd + 1;
      // One JSON record is bounded by TAIL_BYTES. Yield on a small time budget
      // without imposing a timer hop for every fast/short record.
      if (sliceBytes >= PARSE_SLICE_BYTES || sliceLines >= 128) {
        if (performance.now() - sliceStarted >= PARSE_SLICE_MS) {
          await yieldToEventLoop(); sliceStarted = performance.now();
        }
        sliceBytes = 0; sliceLines = 0;
      }
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { return null; }
      if (!entry || typeof entry !== "object" || !entry.payload || typeof entry.payload !== "object") return null;
      const p = entry.payload;
      // Native hosts may flush a command completion after task_complete. It
      // is evidence about the already failed turn, not new work. Preserve only
      // this observed, explicitly owned terminal record; unknown records and
      // new input still invalidate the failure. The provider must independently
      // confirm the same failed turn below before discovery can proceed.
      const trailingCommand = terminal && entry.type === "event_msg" && p.type === "item_completed" &&
        p.thread_id === threadId && p.turn_id === terminal.turnId && p.item?.type === "CommandExecution" &&
        ["completed", "failed"].includes(p.item.status) &&
        Number.isFinite(p.started_at_ms) && p.started_at_ms >= (started?.atMs ?? Infinity) &&
        p.started_at_ms <= terminal.failedAtMs && Number.isFinite(p.completed_at_ms) &&
        p.completed_at_ms >= terminal.failedAtMs && p.completed_at_ms <= nowMs &&
        Date.parse(entry.timestamp) === p.completed_at_ms;
      if (!trailingCommand) terminal = null;
      const text = userText(entry);
      if (text !== undefined) {
        sawUser = true;
        // The host can append environment/context as another role=user record.
        // Once marked, the entire turn remains automatic until its terminal.
        const marker = RECOVERY_PREFIX.exec(text)?.[1];
        if (marker) {
          const prior = turnOpen ? currentRecovery : pendingRecovery;
          const value = prior !== undefined && prior !== marker ? null : marker;
          if (turnOpen) currentRecovery = value;
          else pendingRecovery = value;
        }
      }
      if (entry.type === "turn_context") {
        if (typeof p.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(p.model)) return null;
        model = p.model;
      }
      if (entry.type === "response_item" && p.type === "function_call" &&
          /(?:^|\.|__)request_user_input(?:_async)?$/.test(String(p.name)))
        pendingInput.add(typeof p.call_id === "string" ? p.call_id : "unknown-input");
      if (entry.type === "response_item" && p.type === "function_call_output" && typeof p.call_id === "string")
        pendingInput.delete(p.call_id);
      if (entry.type !== "event_msg") continue;
      if (["request_user_input", "user_input_requested"].includes(p.type)) pendingInput.add("unknown-input");
      if (!["task_started", "task_complete", "turn_aborted", "turn_failed"].includes(p.type)) continue;
      const atMs = Date.parse(entry.timestamp);
      if (!Number.isFinite(atMs) || atMs > nowMs || !UUID.test(p.turn_id ?? "")) return null;
      if (p.type === "task_started") {
        started = { id: p.turn_id, atMs }; pendingInput.clear();
        turnOpen = true; currentRecovery = pendingRecovery; pendingRecovery = undefined;
        continue;
      }
      if (!started || started.id !== p.turn_id || atMs < started.atMs) return null;
      turnOpen = false;
      if (p.type === "task_complete" && p.error?.codex_error_info === "usage_limit_exceeded" && !pendingInput.size)
        terminal = { turnId: p.turn_id, failedAtMs: atMs };
    }
    if (!terminal || !model || !sawUser || currentRecovery === null) return null;
    const after = await file.stat();
    // Finish asynchronous descriptor cleanup before the final path/ownership
    // fences, so closing a file cannot introduce a new unchecked await.
    await file.close(); file = undefined;
    if (stamp(before) !== stamp(after) || stamp(statSync(path)) !== stamp(after) || (!allowNativeWriter && !writerAbsent(root, threadId)) ||
        metadataPath(root, threadId) !== path) return null;
    const database = readdirSync(root).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0]!;
    const db = new Database(join(root, database), { readonly: true, strict: true });
    try {
      const row = db.query<{ cwd: string; rollout_path: string }, [string]>("SELECT cwd,rollout_path FROM threads WHERE id=?").get(threadId);
      if (!row || !isAbsolute(row.cwd) || realpathSync(row.rollout_path) !== path) return null;
      const cwd = realpathSync(row.cwd);
      if (!statSync(cwd).isDirectory()) return null;
      return { threadId, ...terminal, stamp: `${path}:${stamp(after)}`, cwd, model,
        ...(currentRecovery !== undefined ? { recoveryIncidentId: currentRecovery } : {}) };
    } finally { db.close(); }
  } finally { if (file) await file.close(); }
}

/** Detection works while quota is exhausted. Permission to run is a separate
 * gate; this function establishes only an unchanged, account-bound failure. */
export async function readQuotaResumeEvidence(config: AppConfig, account: string, threadId: string,
  options: QuotaResumeEvidenceOptions = {}): Promise<QuotaResumeEvidence | null> {
  let client: CodexAppServerClient | undefined;
  try {
    const profile = config.accounts.codex.find(p => p.enabled && p.id === account);
    if (!profile) return null;
    const root = realpathSync(codexProfileRoot(profile)), credentials = credentialStamp(root);
    const before = await readLocal(config, account, threadId, (options.now ?? Date.now)(), options.allowNativeWriter);
    if (!before) return null;
    if (before.recoveryIncidentId !== undefined && !options.authorizeRecoveryTurn) return null;
    const read = options.readLatestTurn ?? ((id: string) => {
      client ??= new CodexAppServerClient(config.collection.codexCommand, account, 8_000, root);
      return client.readLatestTurn(id);
    });
    let turn: CodexThreadTurnSummary | null;
    try { turn = await read(threadId); }
    catch { throw new QuotaResumeEvidenceUnavailableError(); }
    if (!turn) throw new QuotaResumeEvidenceUnavailableError();
    if (turn.threadId !== threadId || turn.turnId !== before.turnId || turn.status !== "failed" ||
        turn.errorCode !== "usageLimitExceeded" || turn.completedAtMs !== Math.floor(before.failedAtMs / 1000) * 1000) return null;
    if (before.recoveryIncidentId !== undefined && await options.authorizeRecoveryTurn?.(before) !== true) return null;
    const after = await readLocal(config, account, threadId, (options.now ?? Date.now)(), options.allowNativeWriter);
    // The profile list and native credential-store mode may change while the
    // local read yields. Re-resolve the enabled profile instead of trusting the
    // object captured before the first await.
    const currentProfile = config.accounts.codex.find(p => p.enabled && p.id === account);
    if (!after || !currentProfile || !codexUsesFileCredentials(currentProfile) ||
        realpathSync(codexProfileRoot(currentProfile)) !== root ||
        JSON.stringify(before) !== JSON.stringify(after) || credentials !== credentialStamp(root)) return null;
    return after;
  } catch (error) {
    if (error instanceof QuotaResumeEvidenceUnavailableError) throw error;
    return null;
  }
  finally { await client?.close(); }
}
