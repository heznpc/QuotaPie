import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
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
}
export interface QuotaResumeEvidenceOptions {
  /** Must retain the provider client's account/credential identity fence. */
  readLatestTurn?: (threadId: string) => Promise<CodexThreadTurnSummary | null>;
  now?: () => number;
  /** Discovery may display an idle host-owned failure. Execution stays strict. */
  allowNativeWriter?: boolean;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 16 * 1024 * 1024;
const RECOVERY_PREFIX = /^\[QuotaPie quota recovery:[a-zA-Z0-9_-]{1,128}\]\r?\n/;
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
function readLocal(config: AppConfig, account: string, threadId: string, nowMs: number, allowNativeWriter = false): QuotaResumeEvidence | null {
  const profile = config.accounts.codex.find(p => p.enabled && p.id === account);
  if (!profile || !UUID.test(threadId) || !Number.isFinite(nowMs) || !codexUsesFileCredentials(profile)) return null;
  const root = realpathSync(codexProfileRoot(profile));
  if (!allowNativeWriter && !writerAbsent(root, threadId)) return null;
  const path = metadataPath(root, threadId);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0) return null;
    const size = Math.min(before.size, TAIL_BYTES), start = before.size - size;
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, start) !== size || bytes.at(-1) !== 10) return null;
    const lines = bytes.toString("utf8").split("\n");
    if (start) lines.shift(); // Never treat a partial JSON record as evidence.
    let model: string | null = null, started: { id: string; atMs: number } | null = null;
    let terminal: { turnId: string; failedAtMs: number } | null = null;
    let sawUser = false, turnOpen = false, currentTurnIsRecovery = false, pendingRecovery = false;
    const pendingInput = new Set<string>();
    for (const line of lines) {
      if (!line) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { return null; }
      if (!entry || typeof entry !== "object" || !entry.payload || typeof entry.payload !== "object") return null;
      const p = entry.payload;
      // Even a new user input with no started turn invalidates the old terminal.
      terminal = null;
      const text = userText(entry);
      if (text !== undefined) {
        sawUser = true;
        // The host can append environment/context as another role=user record.
        // Once marked, the entire turn remains automatic until its terminal.
        if (RECOVERY_PREFIX.test(text)) {
          if (turnOpen) currentTurnIsRecovery = true;
          else pendingRecovery = true;
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
        turnOpen = true; currentTurnIsRecovery = pendingRecovery; pendingRecovery = false;
        continue;
      }
      if (!started || started.id !== p.turn_id || atMs < started.atMs) return null;
      turnOpen = false;
      if (p.type === "task_complete" && p.error?.codex_error_info === "usage_limit_exceeded" && !pendingInput.size)
        terminal = { turnId: p.turn_id, failedAtMs: atMs };
    }
    if (!terminal || !model || !sawUser || currentTurnIsRecovery) return null;
    const after = fstatSync(fd);
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
      return { threadId, ...terminal, stamp: `${path}:${stamp(after)}`, cwd, model };
    } finally { db.close(); }
  } finally { if (fd !== undefined) closeSync(fd); }
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
    const before = readLocal(config, account, threadId, (options.now ?? Date.now)(), options.allowNativeWriter);
    if (!before) return null;
    const read = options.readLatestTurn ?? ((id: string) => {
      client ??= new CodexAppServerClient(config.collection.codexCommand, account, 8_000, root);
      return client.readLatestTurn(id);
    });
    const turn = await read(threadId);
    if (!turn || turn.threadId !== threadId || turn.turnId !== before.turnId || turn.status !== "failed" ||
        turn.errorCode !== "usageLimitExceeded" || turn.completedAtMs !== Math.floor(before.failedAtMs / 1000) * 1000) return null;
    const after = readLocal(config, account, threadId, (options.now ?? Date.now)(), options.allowNativeWriter);
    if (!after || JSON.stringify(before) !== JSON.stringify(after) || credentials !== credentialStamp(root) ||
        realpathSync(codexProfileRoot(profile)) !== root) return null;
    return after;
  } catch { return null; }
  finally { await client?.close(); }
}
