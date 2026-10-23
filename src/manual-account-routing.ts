import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { codexProfileRoot, dataDirectory, type AppConfig } from "./config";
import { readCodexForkParent } from "./account-pool-lineage";
import { poolAccounts, readPoolPolicy, PoolError, type PoolAccount, type PoolPolicy } from "./account-pool";
import { nativeExecutionHistory } from "./account-replay";

export interface ManualTargetStatus {
  sourceAccount: string; threadId: string; account: string; model: string; selectedAtMs: number; revision: string;
}
interface ManualTargetChoice extends ManualTargetStatus {
  sourceIdentity: string; targetIdentity: string; pendingTurnId: string | null; appliedAtMs: number | null; nativeProofRequired: boolean;
}
export interface ManualRequestTarget { choice: ManualTargetChoice; account: PoolAccount; sourceContinuation?: true }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const accountId = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const modelId = /^[a-z0-9_.-]{1,80}$/i;
const hash = /^[a-f0-9]{64}$/;
function fail(reason: string): never { throw new PoolError("pool_manual_" + reason, 409); }
export const manualRoutingDatabasePath = () => join(dataDirectory(), "manual-account-routing.sqlite3");
const status = (row: ManualTargetChoice): ManualTargetStatus => ({ sourceAccount: row.sourceAccount, threadId: row.threadId,
  account: row.account, model: row.model, selectedAtMs: row.selectedAtMs, revision: row.revision });

function parse(value: string): ManualTargetChoice {
  try {
    const row = JSON.parse(value);
    if (!row || ![row.sourceAccount, row.account].every(v => typeof v === "string" && accountId.test(v)) ||
        !uuid.test(row.threadId) || !uuid.test(row.revision) || !modelId.test(row.model) ||
        !hash.test(row.sourceIdentity) || !hash.test(row.targetIdentity) || !Number.isSafeInteger(row.selectedAtMs) || row.selectedAtMs < 0 ||
        row.pendingTurnId != null && !uuid.test(row.pendingTurnId) || row.appliedAtMs != null && (!Number.isSafeInteger(row.appliedAtMs) || row.appliedAtMs < 0)) fail("registry_unavailable");
    return { sourceAccount: row.sourceAccount, threadId: row.threadId, account: row.account, model: row.model,
      sourceIdentity: row.sourceIdentity, targetIdentity: row.targetIdentity, selectedAtMs: row.selectedAtMs, revision: row.revision,
      pendingTurnId: row.pendingTurnId ?? null, appliedAtMs: row.appliedAtMs ?? null,
      // Earlier registry rows have no pending-turn proof and must fail closed.
      nativeProofRequired: row.nativeProofRequired !== false };
  } catch { return fail("registry_unavailable"); }
}
function choices(path: string): ManualTargetChoice[] {
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return db.query<{ payload: string }, []>("SELECT payload FROM manual_targets ORDER BY selected_ms DESC").all().map(row => parse(row.payload));
  } catch { return fail("registry_unavailable"); }
  finally { db?.close(); }
}
export function manualTargets(databasePath = manualRoutingDatabasePath()): ManualTargetStatus[] {
  return choices(databasePath).map(status);
}

function validate(choice: ManualTargetChoice, accounts: PoolAccount[], policy: PoolPolicy, now: number): PoolAccount {
  if (!policy.enabled || !policy.accounts.includes(choice.sourceAccount) || !policy.accounts.includes(choice.account)) fail("policy_changed");
  const source = accounts.find(a => a.id === choice.sourceAccount), target = accounts.find(a => a.id === choice.account);
  if (!source || source.identity !== choice.sourceIdentity) fail("source_identity_changed");
  if (!target || target.identity !== choice.targetIdentity) fail("target_identity_changed");
  if (source.tokenExpiresAt <= now + 30_000 || target.tokenExpiresAt <= now + 30_000) fail("authentication_unavailable");
  if (!target.models.includes(choice.model)) fail("model_unavailable");
  const quota = target.modelQuota?.[choice.model] ?? target;
  if (quota.remaining === null || !Number.isFinite(quota.remaining) || quota.validUntil <= now) fail("quota_unavailable");
  if (quota.remaining <= (policy.reservePercent?.[target.id] ?? 0)) fail("quota_exhausted");
  return target;
}

/** Called only by the authenticated local action endpoint. The registry stores
 * frozen identity digests, never credentials, prompts or native message bytes. */
export async function setManualTarget(input: { sourceAccount: string; threadId: string; account: string; model: string }, options: {
  config: AppConfig; databasePath?: string; accounts?: () => PoolAccount[]; policy?: () => PoolPolicy;
  verifyThread?: (sourceAccount: string, threadId: string) => Promise<boolean>; now?: () => number; pendingTurnId?: string | null;
}): Promise<ManualTargetStatus> {
  if (!input || ![input.sourceAccount, input.account].every(value => typeof value === "string" && accountId.test(value)) ||
      typeof input.threadId !== "string" || !uuid.test(input.threadId) || typeof input.model !== "string" || !modelId.test(input.model) ||
      options.pendingTurnId != null && !uuid.test(options.pendingTurnId)) fail("invalid_selection");
  const sourceProfile = options.config.accounts.codex.find(p => p.enabled && p.id === input.sourceAccount);
  if (!sourceProfile || !options.config.accounts.codex.some(p => p.enabled && p.id === input.account)) fail("account_unavailable");
  const verified = options.verifyThread ? await options.verifyThread(input.sourceAccount, input.threadId) :
    (await readCodexForkParent(codexProfileRoot(sourceProfile), input.threadId)).status === "known";
  if (!verified) fail("thread_unverified");
  const now = options.now?.() ?? Date.now(), accounts = (options.accounts ?? (() => poolAccounts(options.config)))();
  const source = accounts.find(a => a.id === input.sourceAccount), target = accounts.find(a => a.id === input.account);
  if (!source || !target || !hash.test(source.identity) || !hash.test(target.identity)) fail("account_unavailable");
  const choice: ManualTargetChoice = { ...input, threadId: input.threadId.toLowerCase(), selectedAtMs: now, revision: randomUUID(),
    sourceIdentity: source.identity, targetIdentity: target.identity, pendingTurnId: options.pendingTurnId?.toLowerCase() ?? null,
    appliedAtMs: null, nativeProofRequired: false };
  validate(choice, accounts, (options.policy ?? readPoolPolicy)(), now);
  const path = options.databasePath ?? manualRoutingDatabasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let db: Database | undefined;
  try {
    db = new Database(path, { create: true, strict: true });
    db.run("PRAGMA busy_timeout=0");
    db.run("CREATE TABLE IF NOT EXISTS manual_targets (source TEXT NOT NULL,thread TEXT NOT NULL,payload TEXT NOT NULL,selected_ms INTEGER NOT NULL,PRIMARY KEY(source,thread))");
    db.transaction(() => {
      const previous = db!.query<{ payload: string }, [string, string]>("SELECT payload FROM manual_targets WHERE source=? AND thread=?").get(choice.sourceAccount, choice.threadId);
      if (previous) choice.nativeProofRequired = parse(previous.payload).nativeProofRequired;
      db!.query("INSERT INTO manual_targets VALUES(?,?,?,?) ON CONFLICT(source,thread) DO UPDATE SET payload=excluded.payload,selected_ms=excluded.selected_ms")
        .run(choice.sourceAccount, choice.threadId, JSON.stringify(choice), now);
    }).immediate();
    chmodSync(path, 0o600);
  } catch { return fail("registry_unavailable"); }
  finally { db?.close(); }
  return status(choice);
}

export interface ManualRoutingMemory {
  bindings: Map<string, { target: ManualRequestTarget; requestId: string; completed: boolean }>;
}
export const manualRoutingMemory = (): ManualRoutingMemory => ({ bindings: new Map() });

export function createManualAccountRouting(options: {
  sourceAccount: string; config: () => AppConfig; databasePath?: string; memory?: ManualRoutingMemory;
  accounts?: () => PoolAccount[]; policy?: () => PoolPolicy; now?: () => number;
}) {
  const memory = options.memory ?? manualRoutingMemory(), now = options.now ?? Date.now;
  const current = () => (options.accounts ?? (() => poolAccounts(options.config())))();
  const policy = options.policy ?? readPoolPolicy;
  const sourceContinuation = (choice: ManualTargetChoice): ManualRequestTarget => {
    const source = current().find(account => account.id === options.sourceAccount);
    if (!source || source.identity !== choice.sourceIdentity) fail("source_identity_changed");
    if (source.tokenExpiresAt <= now() + 30_000) fail("authentication_unavailable");
    return { choice: { ...choice, account: source.id, targetIdentity: source.identity }, account: source, sourceContinuation: true };
  };
  const remember = (target: ManualRequestTarget, requestId: string, turnId: string | null) => {
    if (!turnId) return;
    memory.bindings.set(target.choice.threadId + ":" + turnId, { target, requestId, completed: false });
    while (memory.bindings.size > 512) memory.bindings.delete(memory.bindings.keys().next().value!);
  };
  const lookup = (threadId: string | null, conflict = false) => {
    const all = choices(options.databasePath ?? manualRoutingDatabasePath()).filter(row => row.sourceAccount === options.sourceAccount);
    if (all.length && conflict) fail("identity_unverified");
    if (!threadId) { if (all.length) fail("identity_required"); return null; }
    return all.find(row => row.threadId === threadId.toLowerCase()) ?? null;
  };
  return {
    version: 1 as const,
    assertCompatible(input: { threadId: string | null; target?: { account: string; identity: string }; sourceRecoveryOnly?: boolean }) {
      const choice = lookup(input.threadId);
      if (choice && (input.sourceRecoveryOnly || input.target &&
          (input.target.account !== choice.account || input.target.identity !== choice.targetIdentity))) fail("execution_conflict");
    },
    response(input: { threadId: string | null; turnId: string | null; model: string; body: unknown; identityConflict?: boolean }): ManualRequestTarget | null {
      const saved = lookup(input.threadId, input.identityConflict);
      if (!saved) return null;
      if (!modelId.test(input.model)) fail("model_unavailable");
      // The user chose an account, not a model lock. Each complete request,
      // including native compaction, must independently fit that account.
      const choice = { ...saved, model: input.model };
      if (!nativeExecutionHistory(input.body)) fail("history_unverified");
      return { choice, account: validate(choice, current(), policy(), now()) };
    },
    native(input: { threadId: string | null; turnId: string | null; identityConflict?: boolean }): ManualRequestTarget | null {
      const choice = lookup(input.threadId, input.identityConflict);
      if (!choice) return null;
      if (!input.turnId) fail("identity_required");
      const bound = memory.bindings.get(input.threadId + ":" + input.turnId);
      if (bound?.target.sourceContinuation) return sourceContinuation(bound.target.choice);
      if (!bound?.completed) {
        // A hot reload cannot invent the old handler's target. The API may
        // preserve only the exact already-observed source turn while pending.
        if (!bound && !choice.nativeProofRequired && choice.appliedAtMs === null && choice.pendingTurnId === input.turnId)
          return sourceContinuation(choice);
        fail("target_unbound");
      }
      // A new UI selection affects the next complete Responses request. Native
      // tools retain the target that actually produced their current turn.
      return { choice: bound.target.choice, account: validate(bound.target.choice, current(), policy(), now()) };
    },
    begin(target: ManualRequestTarget, requestId: string, turnId: string | null) {
      // Commit activation before any network attempt. A failed write never
      // authorizes source fallback. A concurrently newer choice stays pending,
      // but inherits the fact that this conversation now needs target proof.
      let db: Database | undefined;
      try {
        db = new Database(options.databasePath ?? manualRoutingDatabasePath(), { readwrite: true });
        db.run("PRAGMA busy_timeout=0");
        db.transaction(() => {
          const row = db!.query<{ payload: string }, [string, string]>("SELECT payload FROM manual_targets WHERE source=? AND thread=?")
            .get(options.sourceAccount, target.choice.threadId);
          if (!row) fail("registry_unavailable");
          const latest = parse(row.payload);
          if (latest.sourceIdentity !== target.choice.sourceIdentity) fail("source_identity_changed");
          latest.nativeProofRequired = true;
          if (latest.revision === target.choice.revision) latest.appliedAtMs ??= now();
          db!.query("UPDATE manual_targets SET payload=? WHERE source=? AND thread=?")
            .run(JSON.stringify(latest), options.sourceAccount, target.choice.threadId);
        }).immediate();
      } catch (error) { if (error instanceof PoolError) throw error; fail("registry_unavailable"); }
      finally { db?.close(); }
      remember(target, requestId, turnId);
    },
    observe(input: { threadId: string | null; turnId: string | null; requestId: string; model: string;
      sourceIdentity: string; target?: { account: string; identity: string }; sourceContinuation: boolean }) {
      if (!input.threadId || !input.turnId) return;
      const accounts = current(), source = accounts.find(account => account.id === options.sourceAccount);
      const account = accounts.find(account => account.id === (input.target?.account ?? options.sourceAccount));
      if (!source || source.identity !== input.sourceIdentity || !account || input.target && account.identity !== input.target.identity) return;
      remember({ account, ...(input.sourceContinuation ? { sourceContinuation: true as const } : {}), choice: {
        sourceAccount: options.sourceAccount, threadId: input.threadId, account: account.id, model: input.model,
        sourceIdentity: source.identity, targetIdentity: account.identity, selectedAtMs: now(), revision: randomUUID(),
        pendingTurnId: null, appliedAtMs: now(), nativeProofRequired: true,
      } }, input.requestId, input.turnId);
    },
    finish(threadId: string | null, requestId: string, turnId: string | null, phase: string, status: number) {
      const bound = memory.bindings.get(threadId + ":" + turnId);
      if (bound?.requestId === requestId) bound.completed = phase === "completed" && status >= 200 && status < 300;
    },
  };
}
export type ManualAccountRouting = ReturnType<typeof createManualAccountRouting>;

/** Native tool payloads have no portable Responses history. Accept their exact
 * JSON only when it contains no account-owned remote handles or URLs. */
export function manualNativeToolPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const safe = (item: any): boolean => {
    if (!item || typeof item !== "object") return true;
    if (Array.isArray(item)) return item.every(safe);
    if (["item_reference", "input_file", "input_audio", "input_video", "file_search", "code_interpreter"].includes(item.type)) return false;
    return Object.entries(item).every(([key, child]) => {
      if (["file_id", "file_ids", "file_url", "audio_url", "video_url", "previous_response_id", "conversation", "vector_store_ids", "container", "container_id"].includes(key) && child != null) return false;
      if (key === "image_url" && (typeof child !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(child))) return false;
      return safe(child);
    });
  };
  return safe(value);
}
