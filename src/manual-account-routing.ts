import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { codexProfileRoot, dataDirectory, type AppConfig } from "./config";
import { readCodexForkParent } from "./account-pool-lineage";
import { creditConsent, isFreshTextTurn, poolAccounts, poolDatabasePath, readPoolPolicy, PoolError, type PoolAccount, type PoolPolicy } from "./account-pool";
import { nativeHistoryFailure } from "./account-replay";
import { codexRequestIdentity } from "./codex-request-identity";
import { NativeTurnStore } from "./native-turn-store";

export interface ManualTargetStatus {
  sourceAccount: string; threadId: string; account: string; model: string; selectedAtMs: number; revision: string;
  appliedAtMs?: number | null;
}
interface ManualTargetChoice extends ManualTargetStatus {
  sourceIdentity: string; targetIdentity: string; pendingTurnId: string | null; appliedAtMs: number | null; nativeProofRequired: boolean;
}
export interface ManualRequestTarget { choice: ManualTargetChoice; account: PoolAccount; sourceContinuation?: true; inheritedFromThreadId?: string }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const accountId = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const modelId = /^[a-z0-9_.-]{1,80}$/i;
const hash = /^[a-f0-9]{64}$/;
function fail(reason: string): never { throw new PoolError("pool_manual_" + reason, 409); }
export const manualRoutingDatabasePath = () => join(dataDirectory(), "manual-account-routing.sqlite3");
const status = (row: ManualTargetChoice): ManualTargetStatus => ({ sourceAccount: row.sourceAccount, threadId: row.threadId,
  account: row.account, model: row.model, selectedAtMs: row.selectedAtMs, revision: row.revision, appliedAtMs: row.appliedAtMs });

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
    db.run("PRAGMA busy_timeout=100");
    return db.query<{ payload: string }, []>("SELECT payload FROM manual_targets ORDER BY selected_ms DESC").all().map(row => parse(row.payload));
  } catch { return fail("registry_unavailable"); }
  finally { db?.close(); }
}
export function manualTargets(databasePath = manualRoutingDatabasePath()): ManualTargetStatus[] {
  return choices(databasePath).map(status);
}

function validate(choice: ManualTargetChoice, accounts: PoolAccount[], policy: PoolPolicy, now: number, deferQuota = false): PoolAccount {
  if (!policy.accounts.includes(choice.sourceAccount) || !policy.accounts.includes(choice.account)) fail("policy_changed");
  const source = accounts.find(a => a.id === choice.sourceAccount), target = accounts.find(a => a.id === choice.account);
  if (!source || source.identity !== choice.sourceIdentity) fail("source_identity_changed");
  if (!target || target.identity !== choice.targetIdentity) fail("target_identity_changed");
  if (source.tokenExpiresAt <= now + 30_000 || target.tokenExpiresAt <= now + 30_000) fail("authentication_unavailable");
  if (!target.models.includes(choice.model)) fail("model_unavailable");
  // Complete Responses requests can use the enabled pool when this preferred
  // account is spent. Admission and fallback are decided together by AccountPool.
  if (deferQuota && policy.enabled) return target;
  if (creditConsent(policy, target) === true) return target;
  const quota = target.modelQuota?.[choice.model] ?? target;
  if (quota.remaining === null || !Number.isFinite(quota.remaining) || quota.validUntil <= now) fail("quota_unavailable");
  if (quota.remaining <= 0) fail("quota_exhausted");
  return target;
}

/** Called by the authenticated action endpoint or a verified first request
 * applying the user's saved preference. The registry stores
 * frozen identity digests, never credentials, prompts or native message bytes. */
export async function setManualTarget(input: { sourceAccount: string; threadId: string; account: string; model: string }, options: {
  config: AppConfig; databasePath?: string; accounts?: () => PoolAccount[]; policy?: () => PoolPolicy;
  verifyThread?: (sourceAccount: string, threadId: string) => Promise<boolean>; now?: () => number; pendingTurnId?: string | null;
  onlyIfAbsent?: boolean; expectedTargetIdentity?: string;
  /** Internal first-request preference activation; AccountPool performs admission. */
  deferQuotaToPool?: boolean;
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
  if (options.expectedTargetIdentity && target.identity !== options.expectedTargetIdentity) fail("target_identity_changed");
  const choice: ManualTargetChoice = { ...input, threadId: input.threadId.toLowerCase(), selectedAtMs: now, revision: randomUUID(),
    sourceIdentity: source.identity, targetIdentity: target.identity, pendingTurnId: options.pendingTurnId?.toLowerCase() ?? null,
    appliedAtMs: null, nativeProofRequired: false };
  validate(choice, accounts, (options.policy ?? readPoolPolicy)(), now, options.deferQuotaToPool === true);
  const path = options.databasePath ?? manualRoutingDatabasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let db: Database | undefined;
  try {
    db = new Database(path, { create: true, strict: true });
    db.run("PRAGMA busy_timeout=100");
    db.run("CREATE TABLE IF NOT EXISTS manual_targets (source TEXT NOT NULL,thread TEXT NOT NULL,payload TEXT NOT NULL,selected_ms INTEGER NOT NULL,PRIMARY KEY(source,thread))");
    db.transaction(() => {
      const previous = db!.query<{ payload: string }, [string, string]>("SELECT payload FROM manual_targets WHERE source=? AND thread=?").get(choice.sourceAccount, choice.threadId);
      if (previous && options.onlyIfAbsent) { Object.assign(choice, parse(previous.payload)); return; }
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
  const turns = new NativeTurnStore(options.databasePath ?? manualRoutingDatabasePath(), options.sourceAccount);
  const sourceContinuation = (choice: ManualTargetChoice): ManualRequestTarget => {
    const source = current().find(account => account.id === options.sourceAccount);
    if (!source || source.identity !== choice.sourceIdentity) fail("source_identity_changed");
    if (source.tokenExpiresAt <= now() + 30_000) fail("authentication_unavailable");
    return { choice: { ...choice, account: source.id, targetIdentity: source.identity }, account: source, sourceContinuation: true };
  };
  const remember = (target: ManualRequestTarget, requestId: string, turnId: string | null) => {
    if (!turnId) return;
    try {
      turns.begin(target.choice.threadId, turnId, { choice: JSON.stringify(target.choice), requestId,
        sourceContinuation: target.sourceContinuation === true, inheritedFromThreadId: target.inheritedFromThreadId ?? null });
    } catch { fail("registry_unavailable"); }
    memory.bindings.set(target.choice.threadId + ":" + turnId, { target, requestId, completed: false });
    while (memory.bindings.size > 512) memory.bindings.delete(memory.bindings.keys().next().value!);
  };
  const lookup = (threadId: string | null, conflict = false) => {
    const all = choices(options.databasePath ?? manualRoutingDatabasePath()).filter(row => row.sourceAccount === options.sourceAccount);
    if (all.length && conflict) fail("identity_unverified");
    if (!threadId) { if (all.length) fail("identity_required"); return null; }
    return all.find(row => row.threadId === threadId.toLowerCase()) ?? null;
  };
  // Fork routing is execution history, not a new user preference. Keep the
  // child's target in turn memory; never write an inferred manual selection.
  const inherited = async (threadId: string | null, headers?: Headers): Promise<ManualRequestTarget | null> => {
    if (!threadId) return null;
    const all = choices(options.databasePath ?? manualRoutingDatabasePath()).filter(row => row.sourceAccount === options.sourceAccount);
    if (!all.length) return null;
    const profile = options.config().accounts.codex.find(p => p.enabled && p.id === options.sourceAccount);
    if (!profile) return null;
    const claim = codexRequestIdentity(headers ?? new Headers());
    if (claim.conflict || claim.fork.status === "invalid" || claim.threadId && claim.threadId !== threadId) fail("identity_unverified");
    let db: Database | undefined;
    try {
      if (!existsSync(poolDatabasePath())) return null;
      db = new Database(poolDatabasePath(), { readonly: true, strict: true });
      db.run("PRAGMA busy_timeout=0");
      const confirmed = (id: string) => db!.query<{ account: string; identity: string; source_identity: string }, [string, string]>(
        `SELECT b.account,b.identity,b.source_identity FROM bindings b JOIN binding_proofs p
          ON p.source=b.source AND p.thread=b.thread AND p.account=b.account
          AND p.identity=b.identity AND p.source_identity=b.source_identity WHERE b.source=? AND b.thread=?`)
        .get(options.sourceAccount, id);
      let binding = confirmed(threadId), id = threadId;
      const seen = new Set<string>();
      for (let depth = 0; depth < 32; depth++) {
        if (seen.has(id)) fail("identity_unverified");
        seen.add(id);
        const lineage = await readCodexForkParent(codexProfileRoot(profile), id);
        let parent: string | null;
        if (depth === 0 && claim.fork.status === "claimed") {
          if (lineage.status === "known" && lineage.parentId !== claim.fork.parentId) fail("identity_unverified");
          if (lineage.status === "unknown") return null;
          parent = claim.fork.parentId;
          // Ephemeral helpers have no rollout. Corroborate their claim with
          // local parent metadata and a completed account binding below.
          if ((await readCodexForkParent(codexProfileRoot(profile), parent)).status !== "known") return null;
        } else {
          if (lineage.status !== "known") return null;
          parent = lineage.parentId;
        }
        if (!parent) return null;
        binding ??= confirmed(parent);
        const ancestor = all.find(row => row.threadId === parent);
        if (ancestor && binding) {
          const choice = { ...ancestor, threadId, account: binding.account, targetIdentity: binding.identity,
            sourceIdentity: binding.source_identity, pendingTurnId: null, nativeProofRequired: true };
          if (ancestor.sourceIdentity !== binding.source_identity) fail("source_identity_changed");
          const account = current().find(a => a.id === binding!.account && a.identity === binding!.identity);
          if (!account) fail("target_identity_changed");
          return { choice, account, inheritedFromThreadId: ancestor.threadId };
        }
        id = parent;
      }
      return null;
    } catch (error) { if (error instanceof PoolError) throw error; fail("registry_unavailable"); }
    finally { db?.close(); }
  };
  return {
    version: 1 as const,
    assertCompatible(input: { threadId: string | null; target?: { account: string; identity: string }; sourceRecoveryOnly?: boolean }) {
      const choice = lookup(input.threadId);
      if (choice && (input.sourceRecoveryOnly || input.target &&
          (input.target.account !== choice.account || input.target.identity !== choice.targetIdentity))) fail("execution_conflict");
    },
    async response(input: { threadId: string | null; turnId: string | null; model: string; body: unknown; headers?: Headers; identityConflict?: boolean }): Promise<ManualRequestTarget | null> {
      let saved = lookup(input.threadId, input.identityConflict);
      const parent = saved ? null : await inherited(input.threadId, input.headers);
      const initial = policy().newConversationTarget;
      if (!saved && !parent && initial && input.threadId && isFreshTextTurn(input.body)) {
        if (input.identityConflict) fail("identity_unverified");
        const claim = codexRequestIdentity(input.headers ?? new Headers());
        if (claim.conflict || claim.fork.status === "invalid" || claim.threadId && claim.threadId !== input.threadId)
          fail("identity_unverified");
        const profile = options.config().accounts.codex.find(p => p.enabled && p.id === options.sourceAccount);
        const lineage = profile ? await readCodexForkParent(codexProfileRoot(profile), input.threadId) : null;
        if (claim.fork.status !== "claimed" && lineage?.status !== "known") fail("thread_unverified");
        // A first prompt has local thread metadata by the time it reaches the
        // relay. Forks and previously routed conversations keep their own choice.
        if (lineage?.status === "known" && !lineage.parentId && claim.fork.status !== "claimed") {
          let db: Database | undefined;
          let existing = false;
          try {
            if (existsSync(poolDatabasePath())) {
              db = new Database(poolDatabasePath(), { readonly: true });
              existing = !!db.query("SELECT 1 FROM bindings WHERE source=? AND thread=?").get(options.sourceAccount, input.threadId);
            }
          } catch { fail("registry_unavailable"); } finally { db?.close(); }
          if (!existing) {
            const target = current().find(a => a.id === initial.account);
            if (!target || target.identity !== initial.identity) fail("target_identity_changed");
            await setManualTarget({ sourceAccount: options.sourceAccount, threadId: input.threadId,
              account: initial.account, model: input.model }, { config: options.config(), databasePath: options.databasePath,
              accounts: current, policy, now, onlyIfAbsent: true, expectedTargetIdentity: initial.identity, deferQuotaToPool: true });
            saved = lookup(input.threadId);
          }
        }
      }
      if (!saved && !parent) return null;
      if (!modelId.test(input.model)) fail("model_unavailable");
      // The user chose an account, not a model lock. Each complete request,
      // including native compaction, must independently fit that account.
      const choice = { ...(saved ?? parent!.choice), model: input.model };
      const historyFailure = nativeHistoryFailure(input.body);
      if (historyFailure) throw new PoolError("pool_manual_history_unverified", 409, undefined, historyFailure);
      return { choice, account: validate(choice, current(), policy(), now(), true),
        ...(parent ? { inheritedFromThreadId: parent.inheritedFromThreadId } : {}) };
    },
    routed(target: ManualRequestTarget, selected: { account: string; identity: string }): ManualRequestTarget {
      if (target.account.id === selected.account && target.account.identity === selected.identity) return target;
      const rules = policy();
      if (!rules.enabled || !rules.accounts.includes(selected.account)) fail("target_changed");
      const account = current().find(a => a.id === selected.account && a.identity === selected.identity);
      if (!account) fail("target_identity_changed");
      // Keep the user's preference in the registry. Native tools for this turn
      // must follow the account that actually handled its Responses request.
      return { ...target, account, choice: { ...target.choice, account: account.id, targetIdentity: account.identity } };
    },
    native(input: { threadId: string | null; turnId: string | null; identityConflict?: boolean }): ManualRequestTarget | null {
      const choice = lookup(input.threadId, input.identityConflict);
      let bound = memory.bindings.get(input.threadId + ":" + input.turnId);
      if (input.threadId && input.turnId) {
        try {
          const stored = turns.read(input.threadId, input.turnId);
          if (stored) {
            const recorded = parse(stored.choice);
            if (recorded.sourceAccount !== options.sourceAccount || recorded.threadId !== input.threadId ||
                !uuid.test(stored.requestId) || stored.inheritedFromThreadId != null && !uuid.test(stored.inheritedFromThreadId)) fail("registry_unavailable");
            const account = current().find(a => a.id === recorded.account && a.identity === recorded.targetIdentity);
            if (!account) fail("target_identity_changed");
            bound = { requestId: stored.requestId, completed: stored.completed, target: { choice: recorded, account,
              ...(stored.sourceContinuation ? { sourceContinuation: true as const } : {}),
              ...(stored.inheritedFromThreadId ? { inheritedFromThreadId: stored.inheritedFromThreadId } : {}) } };
          }
        } catch (error) { if (error instanceof PoolError) throw error; fail("registry_unavailable"); }
      }
      if (!choice && !bound?.target.inheritedFromThreadId && (!bound || bound.target.account.id === options.sourceAccount)) return null;
      if (input.identityConflict) fail("identity_unverified");
      if (!input.turnId) fail("identity_required");
      if (bound?.target.sourceContinuation) return sourceContinuation(bound.target.choice);
      if (!bound?.completed) {
        // A hot reload cannot invent the old handler's target. The API may
        // preserve only the exact already-observed source turn while pending.
        if (!bound && choice && !choice.nativeProofRequired && choice.appliedAtMs === null && choice.pendingTurnId === input.turnId)
          return sourceContinuation(choice);
        fail("target_unbound");
      }
      // A new UI selection affects the next complete Responses request. Native
      // tools retain the target that actually produced their current turn.
      return { ...bound.target, account: validate(bound.target.choice, current(), policy(), now()) };
    },
    begin(target: ManualRequestTarget, requestId: string, turnId: string | null) {
      // Commit activation before any network attempt. A failed write never
      // authorizes source fallback. A concurrently newer choice stays pending,
      // but inherits the fact that this conversation now needs target proof.
      let db: Database | undefined;
      try {
        db = new Database(options.databasePath ?? manualRoutingDatabasePath(), { readwrite: true });
        db.run("PRAGMA busy_timeout=100");
        db.transaction(() => {
          const row = db!.query<{ payload: string }, [string, string]>("SELECT payload FROM manual_targets WHERE source=? AND thread=?")
            .get(options.sourceAccount, target.inheritedFromThreadId ?? target.choice.threadId);
          if (!row) fail("registry_unavailable");
          const latest = parse(row.payload);
          if (latest.sourceIdentity !== target.choice.sourceIdentity) fail("source_identity_changed");
          latest.nativeProofRequired = true;
          if (!target.inheritedFromThreadId && latest.revision === target.choice.revision) latest.appliedAtMs ??= now();
          db!.query("UPDATE manual_targets SET payload=? WHERE source=? AND thread=?")
            .run(JSON.stringify(latest), options.sourceAccount, target.inheritedFromThreadId ?? target.choice.threadId);
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
      if (threadId && turnId) {
        // A disk failure must not corrupt an already-delivered provider stream.
        // Its persisted pending row stays unconfirmed, so restart cannot invent ownership.
        try { turns.finish(threadId, turnId, requestId, phase === "completed" && status >= 200 && status < 300); } catch { /* Pending proof remains closed. */ }
      }
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
