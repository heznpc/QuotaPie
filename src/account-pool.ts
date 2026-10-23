import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexProfileRoot, codexUsesFileCredentials, dataDirectory, loadConfig, type AppConfig } from "./config";
import type { CodexForkParentResult } from "./account-pool-lineage";
import { codexRequestIdentity } from "./codex-request-identity";
import { defaultWorkBoundaryPath, profileReference } from "./work-boundary";
import { nativeExecutionHistory, portableReplay, filterForeignReasoning } from "./account-replay";

export interface PoolPolicy { enabled: boolean; accounts: string[]; reservePercent?: Record<string, number>;
  creditConsent?: Record<string, { identity: string; allow: boolean }> }
/** Consent follows the verified login, never just a reusable profile name. */
export function creditConsent(policy: PoolPolicy, account: Pick<PoolAccount, "id" | "identity">): boolean | undefined {
  const choice = policy.creditConsent?.[account.id];
  return choice?.identity === account.identity ? choice.allow : undefined;
}
export interface PoolAccount {
  id: string; label: string; identity: string; accessToken: string; upstreamAccount: string;
  tokenExpiresAt: number; models: string[]; remaining: number | null; validUntil: number; observedAtMs?: number;
  modelQuota?: Record<string, { remaining: number | null; validUntil: number; observedAtMs?: number }>;
}
export interface PoolRoute { sourceAccount: string; account: string; accountLabel: string; reason: "new" | "pinned" | "existing" | "source_fallback" | "recovered" | "reserve" | "manual"; previousAccountLabel?: string }
const POOL_ERROR_BRAND = Symbol.for("quotapie.pool-error.v1");
export class PoolError extends Error {
  readonly [POOL_ERROR_BRAND] = true;
  // A live pool can outlast the handler bundle that constructed its errors.
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && (value as any)[POOL_ERROR_BRAND] === true &&
      typeof (value as any).code === "string" && /^pool_[a-z0-9_]{1,100}$/.test((value as any).code) &&
      Number.isInteger((value as any).status) && (value as any).status >= 400 && (value as any).status <= 599;
  }
  constructor(readonly code: string, readonly status = 503, readonly retryAfterSeconds?: number) { super(code); }
}
export const poolPolicyPath = () => join(dataDirectory(), "account-pool.json");
export const poolDatabasePath = () => join(dataDirectory(), "account-pool.sqlite3");
const SHARED_QUOTA_MODELS = new Set(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
export function isCodexQuotaWindowForModel(window: any, model?: string): boolean {
  return typeof window?.bucket === "string" && (window.bucket.startsWith("codex:") || model != null &&
    (window.bucket.startsWith(model + ":") || window.metadata?.normalModelSlug === model));
}
export function hasUnknownCodexModelScope(windows: any[]): boolean {
  return windows.some(w => typeof w?.bucket === "string" && !w.bucket.startsWith("codex:") &&
    !(typeof w.metadata?.normalModelSlug === "string" && w.metadata.normalModelSlug.length > 0) &&
    ![...SHARED_QUOTA_MODELS].some(model => w.bucket.startsWith(model + ":")));
}
const quotaPermission = (windows: any[]): "allowed" | "denied" | "unknown" =>
  windows.some(w => w.metadata?.ordinaryUsageAllowed === false || w.metadata?.spendControlReached === true) ? "denied" :
  windows.some(w => w.metadata && (Object.hasOwn(w.metadata, "ordinaryUsageAllowed") && w.metadata.ordinaryUsageAllowed !== true ||
    Object.hasOwn(w.metadata, "spendControlReached") && w.metadata.spendControlReached !== false)) ? "unknown" : "allowed";
const credentialDigest = (token: string) => createHash("sha256").update(token).digest("hex");
export function readPoolPolicy(path = poolPolicyPath()): PoolPolicy {
  if (!existsSync(path)) return { enabled: false, accounts: [] };
  return validatePoolPolicy(JSON.parse(readFileSync(path, "utf8")));
}
export function validatePoolPolicy(value: any): PoolPolicy {
  if (!value || typeof value !== "object") throw new PoolError("pool_invalid_policy");
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.accounts) ||
      value.accounts.length > 32 || value.accounts.some((id: unknown) => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)) ||
      new Set(value.accounts).size !== value.accounts.length) throw new PoolError("pool_invalid_policy");
  const reserves = value.reservePercent;
  if (reserves != null && (typeof reserves !== "object" || Array.isArray(reserves) ||
      Object.entries(reserves).some(([id, percent]) => !value.accounts.includes(id) ||
        !Number.isInteger(percent) || (percent as number) < 0 || (percent as number) > 100)))
    throw new PoolError("pool_invalid_reserve", 400);
  const consent = value.creditConsent;
  if (consent != null && (typeof consent !== "object" || Array.isArray(consent) ||
      Object.entries(consent).some(([id, item]: [string, any]) => !value.accounts.includes(id) || !item ||
        Object.keys(item).sort().join(",") !== "allow,identity" || typeof item.allow !== "boolean" ||
        typeof item.identity !== "string" || !/^[a-f0-9]{64}$/.test(item.identity))))
    throw new PoolError("pool_invalid_credit_consent", 400);
  return { enabled: value.enabled, accounts: value.accounts,
    ...(consent != null ? { creditConsent: structuredClone(consent) } : {}),
    ...(reserves != null ? { reservePercent: { ...reserves } } : {}) };
}
export function savePoolPolicy(policy: PoolPolicy, path = poolPolicyPath()): void {
  const valid = validatePoolPolicy(policy);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID();
  writeFileSync(temporary, JSON.stringify(valid) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

/** One small patch per action, so editing one account preserves the others. */
export function configurePoolPolicy(input: any, path = poolPolicyPath()): PoolPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => !["enabled", "account", "reservePercent"].includes(k))) throw new PoolError("pool_invalid_policy", 400);
  const policy = readPoolPolicy(path);
  if (Object.hasOwn(input, "enabled")) {
    if (Object.keys(input).length !== 1 || typeof input.enabled !== "boolean" ||
        input.enabled && policy.accounts.length < 2) throw new PoolError("pool_invalid_policy", 400);
    policy.enabled = input.enabled;
  } else {
    if (Object.keys(input).length !== 2 || !policy.accounts.includes(input.account) ||
        !Number.isInteger(input.reservePercent) || input.reservePercent < 0 || input.reservePercent > 100)
      throw new PoolError("pool_invalid_reserve", 400);
    policy.reservePercent = { ...policy.reservePercent, [input.account]: input.reservePercent };
  }
  savePoolPolicy(policy, path);
  return policy;
}

// No credentials are copied, refreshed or persisted here. The existing Codex
// collector owns refresh; expired/replaced credentials fail closed until observed.
export function poolAccounts(config: AppConfig, boundaryPath = defaultWorkBoundaryPath(), now = Date.now()): PoolAccount[] {
  let boundary: any = null;
  try { boundary = JSON.parse(readFileSync(boundaryPath, "utf8")); } catch { /* no fresh quota */ }
  return config.accounts.codex.filter(p => p.enabled && codexUsesFileCredentials(p)).flatMap(profile => {
    try {
      const root = realpathSync(codexProfileRoot(profile)), path = join(root, "auth.json");
      const stamp = statSync(path);
      if (stamp.size > 262144) return [];
      const auth = JSON.parse(readFileSync(path, "utf8")), token = auth.tokens?.access_token;
      const upstreamAccount = auth.tokens?.account_id;
      if (typeof token !== "string" || typeof upstreamAccount !== "string" || !upstreamAccount || /[\r\n]/.test(token + upstreamAccount)) return [];
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
      if (typeof claims.sub !== "string" || !Number.isFinite(claims.exp)) return [];
      const identity = createHash("sha256").update(JSON.stringify([root, upstreamAccount, claims.sub])).digest("hex");
      let models: string[] = [];
      try { models = JSON.parse(readFileSync(join(root, "models_cache.json"), "utf8")).models.map((m: any) => m.slug).filter((m: unknown) => typeof m === "string"); } catch { /* no model capability evidence */ }
      const row = boundary?.schemaVersion === 1 && boundary.generatedAtMs <= now + 5000 && boundary.expiresAtMs > now
        ? boundary.accounts?.find((a: any) => a.provider === "codex" && a.account === profile.id && a.profileKey === profileReference(root)) : null;
      const windows = row?.windows?.filter((w: any) => typeof w.bucket === "string" && w.bucket.startsWith("codex:")) ?? [];
      const fresh = row?.collectionState === "recent-success" && windows.length > 0 && windows.every((w: any) =>
        w.quality === "authoritative" && w.freshness === "fresh" && Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100 &&
        Number.isFinite(w.observedAtMs) && w.observedAtMs >= stamp.mtimeMs && w.observedAtMs <= now + 5000 &&
        Number.isFinite(w.validUntilMs) && w.validUntilMs > now && (w.resetsAtMs == null || w.resetsAtMs > now));
      const permission = quotaPermission(windows);
      const remaining = fresh && permission !== "unknown" ? permission === "denied" ? 0 : Math.min(...windows.map((w: any) => w.remainingPercent)) : null;
      // Remember the newest exhausted window; recovery needs positive evidence
      // strictly newer for every window so old relay snapshots cannot reset it.
      const observedAtMs = fresh ? remaining === 0
        ? Math.max(...windows.filter((w: any) => w.remainingPercent === 0 || w.metadata?.ordinaryUsageAllowed === false || w.metadata?.spendControlReached === true).map((w: any) => w.observedAtMs))
        : Math.min(...windows.map((w: any) => w.observedAtMs)) : undefined;
      const modelQuota: NonNullable<PoolAccount["modelQuota"]> = {};
      const unknownModelScope = hasUnknownCodexModelScope(row?.windows ?? []);
      for (const model of models) {
        const named = row?.windows?.filter((w: any) => !w.bucket?.startsWith("codex:") && isCodexQuotaWindowForModel(w, model)) ?? [];
        if (!named.length && !unknownModelScope) continue;
        const valid = fresh && !unknownModelScope && named.every((w: any) => w.quality === "authoritative" && w.freshness === "fresh" &&
          Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100 &&
          Number.isFinite(w.observedAtMs) && w.observedAtMs >= stamp.mtimeMs && w.observedAtMs <= now + 5000 &&
          Number.isFinite(w.validUntilMs) && w.validUntilMs > now && (w.resetsAtMs == null || w.resetsAtMs > now));
        const modelPermission = quotaPermission(windows.concat(named));
        modelQuota[model] = { remaining: valid && remaining != null && modelPermission !== "unknown" ? modelPermission === "denied" ? 0 : Math.min(remaining, ...named.map((w: any) => w.remainingPercent)) : null,
          validUntil: valid ? Math.min(...windows.concat(named).map((w: any) => w.validUntilMs)) : 0,
          observedAtMs: valid ? Math.min(...windows.concat(named).map((w: any) => w.observedAtMs)) : undefined };
        if (valid && modelQuota[model]!.remaining === 0) {
          modelQuota[model]!.observedAtMs = Math.max(...windows.concat(named).filter((w: any) =>
            w.remainingPercent === 0 || w.metadata?.ordinaryUsageAllowed === false || w.metadata?.spendControlReached === true)
            .map((w: any) => w.observedAtMs));
        }
      }
      return [{ id: profile.id, label: profile.label, identity, accessToken: token, upstreamAccount, modelQuota,
        tokenExpiresAt: claims.exp * 1000, models, remaining,
        validUntil: fresh ? Math.min(...windows.map((w: any) => w.validUntilMs)) : 0, observedAtMs }];
    } catch { return []; }
  });
}

// Only a first text turn can be assigned away from its login account. Imported
// histories, tool results, server references, attachments and opaque compaction
// state retain the caller's account until cross-account continuation is verified.
export function isFreshTextTurn(body: any): boolean {
  if (!body || body.previous_response_id || body.conversation || !Array.isArray(body.input)) return false;
  let users = 0;
  for (const item of body.input) {
    if (item?.type === "additional_tools" && item.role === "developer") continue;
    if (!item || (item.type != null && item.type !== "message") || !["system", "developer", "user"].includes(item.role)) return false;
    if (item.role === "user") users++;
    if (typeof item.content !== "string" && (!Array.isArray(item.content) || item.content.some((c: any) => c?.type !== "input_text" || typeof c.text !== "string"))) return false;
  }
  return users >= 1;
}

function hasUnverifiedAttachments(body: any): boolean {
  // Inline image bytes travel with the request and do not refer to a file
  // uploaded under the login account. A later screenshot must not strand an
  // already-bound text conversation. Keep the binding and body unchanged.
  const unverified = (part: any): boolean => {
    if (part?.type === "input_file") return true;
    if (part?.type !== "input_image") return false;
    return part.file_id != null || typeof part.image_url !== "string" ||
      !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url);
  };
  return Array.isArray(body?.input) && body.input.some((item: any) =>
    [item?.content, item?.output].some(parts => Array.isArray(parts) && parts.some(unverified)));
}

type Binding = { account: string; identity: string; source_identity: string; label: string; foreignReasoning?: string[]; confirmed?: boolean };
type PoolSelectInput = { threadId: string | null; requestId: string; body: unknown; model: string; headers: Headers;
  /** Internal proof from the source guard; never read from request content. */
  verifiedSource?: { identity: string; credentialDigest: string };
  fixedTarget?: { account: string; identity: string; preserveNativeHistory?: true; manual?: true } };
export type SourceHistoryPolicy = "strict" | "authenticated-source";
export type SourceContinuationInput = {
  threadId: string | null; body: unknown; headers: Headers;
  /** Internal caller policy, never accepted from request headers or body. */
  historyPolicy?: SourceHistoryPolicy;
};
type SourceOnlyReplay = { sourceReplay: NonNullable<ReturnType<typeof portableReplay>> };
export class AccountPool {
  // Bump when imported routing/validation behavior changes: hot reload retains
  // pool instances, so their methods otherwise keep the previous module code.
  static readonly RUNTIME_API_VERSION = 6;
  readonly runtimeApiVersion = AccountPool.RUNTIME_API_VERSION;
  readonly sourceContinuationRevision = 2;
  private db: Database;
  private closed = false;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly pendingSelections = new Map<string, { source: string; thread: string; account: string; identity: string;
    previous: (Binding & { updated_ms: number }) | null; proof: Binding | null; replay: string | null }>();
  constructor(private options: {
    path?: string; sourceAccount: string; accounts: () => PoolAccount[]; policy: () => PoolPolicy; now?: () => number; contentionWaitMs?: number; forkParent?: (threadId: string) => CodexForkParentResult; forkParentAsync?: (threadId: string) => Promise<CodexForkParentResult>;
  }) {
    const path = options.path ?? poolDatabasePath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA busy_timeout=3000");
    // Multiple profile relays can start together. Do not have each connection
    // race to change journal mode; busy_timeout cannot resolve that promotion.
    this.db.run(`CREATE TABLE IF NOT EXISTS bindings (source TEXT NOT NULL, thread TEXT NOT NULL, account TEXT NOT NULL,
      identity TEXT NOT NULL, source_identity TEXT NOT NULL, label TEXT NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY(source,thread))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS cooldowns (identity TEXT PRIMARY KEY, until_ms INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS replay_filters (source TEXT NOT NULL, thread TEXT NOT NULL,
      fingerprints TEXT NOT NULL, PRIMARY KEY(source,thread))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS auth_cooldowns (identity TEXT NOT NULL, digest TEXT NOT NULL,
      status INTEGER NOT NULL, until_ms INTEGER NOT NULL, PRIMARY KEY(identity,digest))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread TEXT NOT NULL,
      account TEXT NOT NULL, label TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS requests_at_ms ON requests(at_ms)");
    this.db.run("CREATE INDEX IF NOT EXISTS requests_thread_at_ms ON requests(source,thread,at_ms)");
    this.db.run("CREATE INDEX IF NOT EXISTS requests_rejected_at_ms ON requests(at_ms) WHERE state='rejected'");
    this.db.run("CREATE INDEX IF NOT EXISTS requests_failures_at_ms ON requests(at_ms) WHERE state IN ('rejected','failed','unverified')");
    this.db.run("CREATE TABLE IF NOT EXISTS errors (source TEXT PRIMARY KEY, code TEXT NOT NULL, at_ms INTEGER NOT NULL)");
    this.db.run(`CREATE TABLE IF NOT EXISTS binding_proofs (source TEXT NOT NULL,thread TEXT NOT NULL,account TEXT NOT NULL,
      identity TEXT NOT NULL,source_identity TEXT NOT NULL,PRIMARY KEY(source,thread))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS request_identities (id TEXT PRIMARY KEY,identity TEXT NOT NULL,source_identity TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS quota_observations (identity TEXT PRIMARY KEY, observed_ms INTEGER NOT NULL, exhausted INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS source_credentials (source TEXT NOT NULL, identity TEXT NOT NULL,
      digest TEXT NOT NULL, expires_ms INTEGER NOT NULL, PRIMARY KEY(source,identity,digest))`);
    const initialAccounts = this.options.accounts();
    this.rememberSource(initialAccounts.find(a => a.id === this.options.sourceAccount), initialAccounts);
    if (path !== ":memory:") for (const p of [path, path + "-wal", path + "-shm"]) if (existsSync(p)) chmodSync(p, 0o600);
  }
  close() {
    if (this.closed) return;
    // Shutdown does not wait for best-effort telemetry. Pending async operations
    // reject on their next attempt, without accessing a closed connection.
    this.closed = true;
    this.db.close();
  }
  // SQLite's native busy timeout blocks Bun's entire event loop, including
  // unrelated response streams. Retry only transactions that never dispatched
  // inference, restoring the connection setting before yielding to other work.
  private async withContentionRetry<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    const deadline = performance.now() + (this.options.contentionWaitMs ?? 3000);
    let delay = 5;
    while (true) {
      signal?.throwIfAborted();
      if (this.closed) throw new PoolError("pool_closed");
      const timeout = this.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()!.timeout;
      try {
        this.db.run("PRAGMA busy_timeout=0");
        return operation();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!code?.startsWith("SQLITE_BUSY") && !code?.startsWith("SQLITE_LOCKED")) throw error;
        if (performance.now() >= deadline) throw new PoolError("pool_storage_busy", 503, 1);
      } finally {
        this.db.run(`PRAGMA busy_timeout=${timeout}`);
      }
      const pause = Math.min(delay, Math.max(0, deadline - performance.now()));
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, pause);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      delay = Math.min(delay * 2, 50);
    }
  }
  // Status and terminal writes for one request retain their order without
  // making the response stream wait for telemetry or unrelated requests.
  private enqueueWrite(requestId: string, operation: () => void): Promise<void> {
    const pending = (this.pendingWrites.get(requestId) ?? Promise.resolve())
      .catch(() => {}).then(() => this.withContentionRetry(operation));
    this.pendingWrites.set(requestId, pending);
    void pending.finally(() => {
      if (this.pendingWrites.get(requestId) === pending) this.pendingWrites.delete(requestId);
    }).catch(() => {});
    return pending;
  }
  // Resolve disk/compressed metadata before entering synchronous SQLite transactions.
  // Each request owns its snapshot; concurrent requests never share temporary ancestry.
  private async forkSnapshot(input: SourceContinuationInput, signal?: AbortSignal) {
    if (!this.options.forkParentAsync) return this.options.forkParent;
    const records = new Map<string, CodexForkParentResult>();
    const claim = codexRequestIdentity(input.headers);
    let thread = input.threadId;
    for (let depth = 0; thread && depth < 33 && !records.has(thread); depth++) {
      signal?.throwIfAborted();
      const result = await this.options.forkParentAsync(thread);
      records.set(thread, result);
      if (result.status === "known") thread = result.parentId;
      else if (depth === 0 && claim.fork.status === "claimed" &&
          (result.status === "missing" || input.historyPolicy === "authenticated-source")) thread = claim.fork.parentId;
      else break;
    }
    signal?.throwIfAborted();
    return (id: string): CodexForkParentResult => records.get(id) ?? { status: "unknown" };
  }
  async selectAsync(input: PoolSelectInput, signal?: AbortSignal): Promise<ReturnType<AccountPool["select"]>> {
    const lineage = await this.forkSnapshot(input, signal);
    return this.withContentionRetry(() => this.select(input, lineage), signal);
  }
  async canSelectInteractiveAsync(input: PoolSelectInput, signal?: AbortSignal): Promise<boolean> {
    const policy = this.options.policy();
    if (!policy.enabled || !policy.accounts.includes(this.options.sourceAccount) || !input.threadId || !SHARED_QUOTA_MODELS.has(input.model)) return false;
    const portable = portableReplay(input.body) !== null;
    const lineage = await this.forkSnapshot(input, signal);
    return this.withContentionRetry(() => {
      let thread: string | null = input.threadId;
      const seen = new Set<string>();
      while (thread && !seen.has(thread) && seen.size < 32) {
        seen.add(thread);
        const binding = this.db.query<{account: string}, [string,string]>("SELECT account FROM bindings WHERE source=? AND thread=?").get(this.options.sourceAccount, thread);
        // A known foreign target can keep its own opaque continuation. This
        // lookup grants no admission: select() rechecks ancestry and identities.
        if (binding?.account !== undefined) return binding.account !== this.options.sourceAccount || portable;
        const parent = lineage?.(thread);
        if (parent?.status !== "known") return false;
        if (!parent.parentId) return portable;
        thread = parent.parentId;
      }
      return false;
    }, signal);
  }
  async assertSourceContinuationAsync(input: SourceContinuationInput, signal?: AbortSignal): Promise<void> {
    const lineage = await this.forkSnapshot(input, signal);
    this.assertSourceContinuation(input, lineage);
  }
  assertTargetContinuationAsync(input: {threadId: string; account: string; identity: string; sourceIdentity: string}, signal?: AbortSignal): Promise<void> {
    return this.withContentionRetry(() => {
      const source = this.options.sourceAccount;
      const binding = this.db.query<Binding, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(source, input.threadId);
      if (!binding || binding.account !== input.account || binding.identity !== input.identity || binding.source_identity !== input.sourceIdentity ||
          !this.hasCompletedBinding(source, input.threadId, binding)) throw new PoolError("pool_execution_target_history_unverified", 409);
    }, signal);
  }
  canRecoverAsync(account: string, model: string, body: unknown, signal?: AbortSignal): Promise<boolean> {
    return this.withContentionRetry(() => this.canRecover(account, model, body), signal);
  }
  responseAsync(requestId: string, identity: string, status: number, retryAfter: string | null, digest?: string): Promise<void> {
    return this.enqueueWrite(requestId, () => this.response(requestId, identity, status, retryAfter, digest));
  }
  finishAsync(requestId: string, state: string): Promise<void> {
    return this.enqueueWrite(requestId, () => this.finish(requestId, state));
  }
  rejectAsync(code: string, context?: { requestId: string; threadId: string | null; status: number }): Promise<void> {
    return this.enqueueWrite(context?.requestId ?? "rejection", () => this.reject(code, context));
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** Validate the original login without routing, rewriting history or changing
   * durable bindings. Subscription-only relays must not bypass older pool
   * provenance just because new account selection is disabled. */
  assertSourceContinuation(input: SourceContinuationInput, forkParent = this.options.forkParent): void {
    if (this.closed) throw new PoolError("pool_closed");
    if (this.options.forkParentAsync && !forkParent) throw new PoolError("pool_lineage_unavailable", 409);
    const sourceID = this.options.sourceAccount, source = this.options.accounts().find(a => a.id === sourceID);
    if (!source || source.tokenExpiresAt <= this.now() + 30_000) throw new PoolError("pool_source_auth_unavailable", 401);
    const bearer = input.headers.get("authorization");
    if (bearer !== `Bearer ${source.accessToken}` || input.headers.get("chatgpt-account-id") !== source.upstreamAccount)
      throw new PoolError("pool_source_identity_mismatch", 401);
    const claim = codexRequestIdentity(input.headers);
    if (claim.fork.status === "invalid") throw new PoolError("pool_lineage_invalid", 409);
    // Interactive requests stay on the authenticated source, with their history
    // unchanged. Missing local metadata (including ephemeral helpers) is not
    // evidence of another account. The provider resolves its opaque handles.
    // Known foreign bindings/replay and conflicting ancestry still veto below.
    // Managed work retains the stricter default; this never authorizes routing.
    const authenticatedSource = input.historyPolicy === "authenticated-source";
    // A portable body carries its complete text/tool history without handles
    // that might have been issued under another account. Never silently strip
    // encrypted reasoning, item IDs or compaction data in this assertion.
    const portable = () => {
      const replay = portableReplay(input.body);
      return replay != null && replay.fingerprints.length === 0 &&
        (input.body as { input: any[] }).input.every(item => item.id == null);
    };
    if (!input.threadId) {
      if (claim.threadId || !authenticatedSource && !portable()) throw new PoolError("pool_source_history_unverified", 409);
      return;
    }
    if (claim.threadId !== input.threadId) throw new PoolError("pool_thread_identity_required", 409);
    const seen = new Set<string>();
    let sourceBound = false;
    let thread = input.threadId;
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(thread)) throw new PoolError("pool_lineage_invalid", 409);
      seen.add(thread);
      const saved = this.db.query<Binding, [string, string]>(
        "SELECT * FROM bindings WHERE source=? AND thread=?").get(sourceID, thread);
      if (saved) {
        if (saved.account !== sourceID || saved.source_identity !== source.identity || saved.identity !== source.identity)
          throw new PoolError("pool_source_continuation_mismatch", 409);
        sourceBound = true;
      }
      // Even an empty replay filter records a prior cross-account recovery.
      // Subscription-only mode never repairs or replays that history itself.
      if (this.foreignReasoning(sourceID, thread) !== undefined)
        throw new PoolError("pool_source_history_unverified", 409);
      const lineage = forkParent?.(thread);
      if (depth === 0 && claim.fork.status === "claimed") {
        if (lineage?.status === "known" && lineage.parentId !== claim.fork.parentId)
          throw new PoolError("pool_lineage_conflict", 409);
        if (lineage?.status !== "known") {
          // Always inspect a claimed parent's binding, including an ephemeral
          // child. Strict managed work additionally requires native metadata.
          if (!authenticatedSource && (lineage?.status !== "missing" || forkParent?.(claim.fork.parentId).status !== "known"))
            throw new PoolError("pool_lineage_unavailable", 409);
          thread = claim.fork.parentId;
          continue;
        }
      }
      if (lineage?.status !== "known") {
        if (authenticatedSource) return;
        if (depth > 0) throw new PoolError("pool_lineage_unavailable", 409);
        if (sourceBound) return;
        break;
      }
      // The full native lineage was verified inside the source profile and no
      // ancestor carries another account's binding or replay state. Its opaque
      // reasoning/response handles may stay on the original login unchanged.
      if (!lineage.parentId) return;
      thread = lineage.parentId;
      if (depth === 31) throw new PoolError("pool_lineage_invalid", 409);
    }
    if (!portable()) throw new PoolError("pool_source_history_unverified", 409);
  }
  private reserve(account: PoolAccount): number {
    const policy = this.options.policy();
    return policy.enabled && policy.reservePercent && Object.hasOwn(policy.reservePercent, account.id)
      ? policy.reservePercent[account.id]! : 0;
  }
  private quota(account: PoolAccount, model?: string) {
    return model && account.modelQuota?.[model] || account;
  }
  private reserveBlock(account: PoolAccount, model?: string): string | null {
    const quota = this.quota(account, model);
    const reserve = this.reserve(account);
    if (reserve <= 0) return null;
    if (quota.remaining == null || quota.validUntil <= this.now()) return "pool_reserve_quota_unavailable";
    return quota.remaining <= reserve ? "pool_reserve_reached" : null;
  }
  private hasCompletedBinding(source: string, thread: string, binding: Binding): boolean {
    return !!this.db.query("SELECT 1 FROM binding_proofs WHERE source=? AND thread=? AND account=? AND identity=? AND source_identity=?")
      .get(source, thread, binding.account, binding.identity, binding.source_identity);
  }
  private foreignReasoning(source: string, thread: string): string[] | undefined {
    const row = this.db.query<{fingerprints:string}, [string,string]>("SELECT fingerprints FROM replay_filters WHERE source=? AND thread=?").get(source, thread);
    return row ? JSON.parse(row.fingerprints) : undefined;
  }
  private eligible(accounts: PoolAccount[], model: string, exclude?: string): PoolAccount[] {
    const now = this.now(), policy = this.options.policy();
    return accounts.filter(a => a.id !== exclude && policy.accounts.includes(a.id) && a.tokenExpiresAt > now + 30_000 &&
      a.models.includes(model) && this.quota(a, model).remaining != null && this.quota(a, model).remaining! > this.reserve(a) && this.quota(a, model).validUntil > now &&
      // Leave a small margin before entering a protected account, avoiding
      // repeated transfers when quota observations hover around its threshold.
      (this.reserve(a) === 0 || this.quota(a, model).remaining! >= Math.min(100, this.reserve(a) + 5)) &&
      !this.db.query("SELECT 1 FROM quota_observations WHERE identity IN (?,?) AND exhausted=1").get(a.identity, a.identity + ":" + model) &&
      !this.db.query("SELECT 1 FROM cooldowns WHERE identity=? AND until_ms>?").get(a.identity, now) &&
      !this.db.query("SELECT 1 FROM auth_cooldowns WHERE identity=? AND digest=? AND until_ms>?").get(a.identity, credentialDigest(a.accessToken), now))
      .sort((a,b) => Number(b.id === this.options.sourceAccount) - Number(a.id === this.options.sourceAccount) || this.quota(b, model).remaining! - this.quota(a, model).remaining! || a.id.localeCompare(b.id));
  }
  canRecover(account: string, model: string, body: unknown): boolean {
    if (!this.options.policy().enabled || !SHARED_QUOTA_MODELS.has(model) || !portableReplay(body)) return false;
    const accounts = this.options.accounts();
    this.rememberSource(accounts.find(a => a.id === this.options.sourceAccount), accounts);
    return this.eligible(accounts, model, account).length > 0;
  }
  private rememberSource(source: PoolAccount | undefined, accounts: PoolAccount[]) {
    const now = this.now();
    this.db.transaction(() => {
      this.db.query("DELETE FROM source_credentials WHERE expires_ms <= ?").run(now + 30_000);
      // Losing fresh telemetry is not evidence that spent quota recovered.
      // Identity survives token refresh; a new login has its own protection.
      for (const account of accounts) if (account.validUntil > now && account.remaining != null) {
        const observedAt = account.observedAtMs ?? now;
        // Conflicting observations with the same timestamp retain exhaustion.
        // Only a strictly newer positive observation can permit spending again.
        if (account.remaining >= 0)
          this.db.query(`INSERT INTO quota_observations VALUES (?,?,?) ON CONFLICT(identity)
            DO UPDATE SET observed_ms=excluded.observed_ms,exhausted=excluded.exhausted
            WHERE excluded.observed_ms>observed_ms OR (excluded.observed_ms=observed_ms AND excluded.exhausted>exhausted)`)
            .run(account.identity, observedAt, Number(account.remaining === 0));
      }
      for (const account of accounts) for (const [model, quota] of Object.entries(account.modelQuota ?? {})) {
        if (quota.remaining == null || quota.validUntil <= now || quota.observedAtMs == null) continue;
        this.db.query(`INSERT INTO quota_observations VALUES (?,?,?) ON CONFLICT(identity)
          DO UPDATE SET observed_ms=excluded.observed_ms,exhausted=excluded.exhausted
          WHERE excluded.observed_ms>observed_ms OR (excluded.observed_ms=observed_ms AND excluded.exhausted>exhausted)`)
          .run(account.identity + ":" + model, quota.observedAtMs, Number(quota.remaining === 0));
      }
      if (source && source.tokenExpiresAt > now + 30_000)
        this.db.query("INSERT OR REPLACE INTO source_credentials VALUES (?,?,?,?)")
          .run(source.id, source.identity, credentialDigest(source.accessToken), source.tokenExpiresAt);
    }).immediate();
  }
  private inheritedBinding(source: string, thread: string, body: unknown, headers: Headers, sourceAccount: PoolAccount | undefined, forkParent = this.options.forkParent): Binding | SourceOnlyReplay | null {
    if (!forkParent) return null;
    const claim = codexRequestIdentity(headers);
    if (claim.fork.status === "invalid" || claim.fork.status === "claimed" && claim.threadId !== thread)
      throw new PoolError("pool_lineage_invalid", 409);
    const seen = new Set([thread]);
    for (let depth = 0; depth < 32; depth++) {
      const lineage = forkParent(thread);
      if (depth === 0 && claim.fork.status === "claimed") {
        if (lineage.status === "known" && lineage.parentId !== claim.fork.parentId)
          throw new PoolError("pool_lineage_conflict", 409);
        if (lineage.status === "unknown") throw new PoolError("pool_lineage_unavailable", 409);
        if (lineage.status === "missing") {
          // In-memory forks have no rollout. Corroborate the protocol claim
          // with a real parent in this profile AND an existing source binding.
          // A header alone must never create ancestry or select another login.
          const parent = claim.fork.parentId;
          if (forkParent(parent).status !== "known")
            throw new PoolError("pool_lineage_parent_unavailable", 409);
          const binding = this.db.query<Binding, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(source, parent);
          if (!binding) throw new PoolError("pool_lineage_binding_unavailable", 409);
          if (!sourceAccount || binding.account !== source || binding.identity !== sourceAccount.identity ||
              binding.source_identity !== sourceAccount.identity)
            throw new PoolError("pool_lineage_account_mismatch", 409);
          // select() still authenticates the caller and enforces quota,
          // reserves and cooldowns before committing this child's binding.
          return { ...binding, confirmed: this.hasCompletedBinding(source, parent, binding), foreignReasoning: this.foreignReasoning(source, parent) };
        }
      }
      if (lineage.status !== "known") {
        // Ephemeral Codex helpers do not persist rollout metadata and can carry
        // complete message/tool history. A verified portable request can run on
        // its authenticated source after removing account-bound replay caches.
        // Missing ancestry never permits choosing a different account, and a
        // known fork with a missing ancestor must still retain that ancestry.
        const replay = depth === 0 ? portableReplay(body) : null;
        if (replay) return { sourceReplay: replay };
        throw new PoolError("pool_lineage_unavailable", 409);
      }
      if (!lineage.parentId) return null;
      thread = lineage.parentId;
      if (seen.has(thread)) throw new PoolError("pool_lineage_invalid", 409);
      seen.add(thread);
      const binding = this.db.query<Binding, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(source, thread);
      if (binding) return { ...binding, confirmed: this.hasCompletedBinding(source, thread, binding), foreignReasoning: this.foreignReasoning(source, thread) };
    }
    throw new PoolError("pool_lineage_invalid", 409);
  }
  select(input: PoolSelectInput, forkParent = this.options.forkParent): { route: PoolRoute; headers: Headers; identity: string; credentialDigest: string; body: unknown } | null {
    if (this.options.forkParentAsync && !forkParent) throw new PoolError("pool_lineage_unavailable", 409);
    const policy = this.options.policy(), sourceID = this.options.sourceAccount, thread = input.threadId;
    if (!thread) { if (policy.enabled && policy.accounts.includes(sourceID)) throw new PoolError("pool_thread_identity_required", 409); return null; }
    const now = this.now(), accounts = this.options.accounts(), source = accounts.find(a => a.id === sourceID);
    // File observations must survive a later routing rejection. Caller-supplied
    // credentials are never added to this trusted history.
    this.rememberSource(source, accounts);
    const execute = this.db.transaction(() => {
      const previous = this.db.query<Binding & {updated_ms:number}, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(sourceID, thread);
      const proof = this.db.query<Binding, [string,string]>("SELECT * FROM binding_proofs WHERE source=? AND thread=?").get(sourceID, thread);
      const replay = this.db.query<{fingerprints:string}, [string,string]>("SELECT fingerprints FROM replay_filters WHERE source=? AND thread=?").get(sourceID, thread)?.fingerprints ?? null;
      let saved: Binding | null = previous;
      let sourceReplay: SourceOnlyReplay["sourceReplay"] | undefined;
      // Resolve forks even with new assignment disabled: inherited remote state
      // must remain on the account that created it.
      if (!saved && forkParent && (policy.accounts.includes(sourceID) ||
          this.db.query("SELECT 1 FROM bindings WHERE source=? LIMIT 1").get(sourceID))) {
        const inherited = this.inheritedBinding(sourceID, thread, input.body, input.headers, source, forkParent);
        if (inherited && "sourceReplay" in inherited) sourceReplay = inherited.sourceReplay;
        else saved = inherited;
      }
      // A source-only replay has already removed foreign account caches. Keep
      // that validated body and authenticate its source even when new pool
      // assignment is disabled; returning null would forward the original body.
      if (!saved && !sourceReplay && !input.fixedTarget?.manual && (!policy.enabled || !policy.accounts.includes(sourceID))) return null;
      if (!source || source.tokenExpiresAt <= now + 30_000) throw new PoolError("pool_source_auth_unavailable", 401);
      // Accept only current or previously observed file credentials for this
      // exact login identity. Do not trust unsigned JWT identity claims from a
      // caller. Hashes survive relay restart; expired credentials are pruned.
      const bearer = input.headers.get("authorization");
      const digest = bearer?.startsWith("Bearer ") ? credentialDigest(bearer.slice(7)) : "";
      const known = this.db.query("SELECT 1 FROM source_credentials WHERE source=? AND identity=? AND digest=? AND expires_ms>?")
        .get(sourceID, source.identity, digest, now + 30_000);
      const verifiedBySourceGuard = input.verifiedSource?.identity === source.identity && input.verifiedSource.credentialDigest === digest;
      if (input.headers.get("chatgpt-account-id") !== source.upstreamAccount || !known && !verifiedBySourceGuard)
        throw new PoolError("pool_source_identity_mismatch", 401);
      const isExhausted = (a: PoolAccount) => !!this.db.query("SELECT 1 FROM quota_observations WHERE identity IN (?,?) AND exhausted=1").get(a.identity, a.identity + ":" + input.model);
      const cooldownUntil = (a: PoolAccount) => this.db.query<{until_ms:number}, [string]>("SELECT until_ms FROM cooldowns WHERE identity=?").get(a.identity)?.until_ms ?? 0;
      const authCooldown = (a: PoolAccount) => this.db.query<{status:number;until_ms:number}, [string,string,number]>(
        "SELECT status,until_ms FROM auth_cooldowns WHERE identity=? AND digest=? AND until_ms>?")
        .get(a.identity, credentialDigest(a.accessToken), now);
      let selected: PoolAccount | undefined, reason: PoolRoute["reason"];
      const preserveNative = input.fixedTarget?.preserveNativeHistory === true;
      if (preserveNative && !nativeExecutionHistory(input.body)) throw new PoolError("pool_execution_target_native_history_unverified", 409);
      let foreignReasoning = sourceReplay?.fingerprints ?? saved?.foreignReasoning ?? this.foreignReasoning(sourceID, thread);
      let replayBody = preserveNative ? input.body : sourceReplay?.body ?? filterForeignReasoning(input.body, foreignReasoning);
      let previousAccountLabel: string | undefined;
      if (input.fixedTarget) {
        // A source-only replay is the fallback for unverified local ancestry,
        // not a prohibition on a separately verified exact native-turn lease.
        // That lease, or an independently verified local manual choice, may
        // use its chosen account while retaining every original
        // byte; ordinary pool requests still cannot infer cross-account rights.
        if ((!policy.enabled && !input.fixedTarget.manual) || !policy.accounts.includes(sourceID) || !policy.accounts.includes(input.fixedTarget.account) || sourceReplay && !preserveNative)
          throw new PoolError("pool_execution_target_unavailable", 409);
        selected = accounts.find(account => account.id === input.fixedTarget!.account && account.identity === input.fixedTarget!.identity);
        if (!selected || selected.id === sourceID && !preserveNative) throw new PoolError("pool_execution_target_unavailable", 409);
        const sameBinding = saved?.account === selected.id && saved.identity === selected.identity && saved.source_identity === source.identity;
        reason = input.fixedTarget.manual ? "manual" : sameBinding ? "pinned" : "recovered";
        if (!sameBinding) {
          const replay = preserveNative ? null : portableReplay(input.body);
          if (!preserveNative && !replay) throw new PoolError("pool_recovery_requires_full_history", 409);
          previousAccountLabel = saved?.label ?? source.label;
          if (replay) {
            replayBody = replay.body;
            foreignReasoning = [...new Set([...(foreignReasoning ?? []), ...replay.fingerprints])];
          }
        }
      } else if (saved && source.identity !== saved.source_identity) {
        // A login changed in the trusted local credential store. Honor that
        // explicit login instead of trapping it behind the previous binding.
        const replay = portableReplay(input.body);
        if (!replay) throw new PoolError("pool_recovery_requires_full_history", 409);
        selected = source; reason = "recovered"; previousAccountLabel = saved.label;
        replayBody = replay.body;
        foreignReasoning = [...new Set([...(foreignReasoning ?? []), ...replay.fingerprints])];
      } else if (saved) {
        selected = accounts.find(a => a.id === saved.account);
        if (source.identity !== saved.source_identity || !selected || selected.identity !== saved.identity) throw new PoolError("pool_bound_identity_changed", 409);
        if (selected.id !== sourceID && !policy.accounts.includes(selected.id)) throw new PoolError("pool_bound_account_removed", 409);
        reason = "pinned";
        // Only a new, complete HTTP request can move. Partial streamed responses
        // are never replayed. Keep all messages/tool outputs; remove only foreign
        // encrypted reasoning cache, and persist its fingerprints for later turns.
        const restoredSource = policy.enabled && selected.id !== sourceID && SHARED_QUOTA_MODELS.has(input.model)
          ? this.eligible(accounts, input.model, selected.id).find(a => a.id === sourceID) : undefined;
        if (restoredSource) {
          const replay = portableReplay(replayBody);
          if (replay && !hasUnverifiedAttachments(replay.body)) {
            previousAccountLabel = selected.label;
            selected = restoredSource; reason = "recovered"; replayBody = replay.body;
            foreignReasoning = [...new Set([...(foreignReasoning ?? []), ...replay.fingerprints])];
          }
        }
        if (reason === "pinned" && policy.enabled && SHARED_QUOTA_MODELS.has(input.model) &&
            (cooldownUntil(selected) > now || isExhausted(selected) || this.reserveBlock(selected, input.model))) {
          const replacement = this.eligible(accounts, input.model, selected.id)[0];
          if (replacement) {
            const replay = portableReplay(replayBody);
            if (replay) {
              previousAccountLabel = selected.label;
              reason = this.reserveBlock(selected, input.model) && cooldownUntil(selected) <= now ? "reserve" : "recovered";
              selected = replacement; replayBody = replay.body;
              foreignReasoning = [...new Set([...(foreignReasoning ?? []), ...replay.fingerprints])];
            } else if (cooldownUntil(selected) > now || isExhausted(selected) || this.reserveBlock(selected, input.model)) {
              throw new PoolError("pool_recovery_requires_full_history", 409);
            }
          }
        }
      } else if (sourceReplay || !SHARED_QUOTA_MODELS.has(input.model) || (!isFreshTextTurn(input.body) && !portableReplay(input.body))) { selected = source; reason = "existing"; }
      else {
        // Unknown source quota is not permission to silently change the login.
        selected = !isExhausted(source) && !this.reserveBlock(source, input.model) && (this.quota(source, input.model).remaining == null || this.quota(source, input.model).remaining! > 0) && cooldownUntil(source) <= now && !authCooldown(source)
          ? source : this.eligible(accounts, input.model)[0];
        // Never-observed quota retains the caller's login. Confirmed exhaustion
        // remains protected, and a different account needs fresh positive quota.
        reason = selected ? (this.reserveBlock(source, input.model) && selected.id !== source.id ? "reserve" : "new") : "source_fallback";
        selected ??= source;
        if (selected.id !== sourceID && !isFreshTextTurn(input.body)) {
          const replay = portableReplay(input.body)!;
          reason = "recovered"; previousAccountLabel = source.label;
          replayBody = replay.body; foreignReasoning = replay.fingerprints;
        }
      }
      if (selected.tokenExpiresAt <= now + 30_000) throw new PoolError("pool_target_auth_unavailable", 401);
      // A confirmed exhausted identity must not silently spend paid credits when
      // this request cannot be moved to a registered account with quota.
      if ((policy.enabled || input.fixedTarget?.manual || creditConsent(policy, selected) === false) && isExhausted(selected) && creditConsent(policy, selected) !== true)
        throw new PoolError(selected.id === sourceID ? "pool_source_quota_exhausted" : "pool_target_quota_exhausted", 409);
      const reserveBlock = input.fixedTarget?.manual || creditConsent(policy, selected) === true ? null : this.reserveBlock(selected, input.model);
      if (reserveBlock) throw new PoolError(reserveBlock, 409);
      const until = cooldownUntil(selected);
      if (until > now) throw new PoolError("pool_account_cooldown", 429, Math.ceil((until - now) / 1000));
      const auth = authCooldown(selected);
      if (auth) throw new PoolError("pool_auth_cooldown", auth.status, Math.ceil((auth.until_ms - now) / 1000));
      if (selected.id !== sourceID && !selected.models.includes(input.model)) throw new PoolError("pool_model_unavailable", 409);
      if (selected.id !== sourceID && !SHARED_QUOTA_MODELS.has(input.model)) throw new PoolError("pool_quota_scope_unsupported", 409);
      if (selected.id !== sourceID && hasUnverifiedAttachments(input.body)) throw new PoolError("pool_attachment_account_unverified", 409);
      if (selected.id !== sourceID && !preserveNative && !portableReplay(input.body) &&
          !(saved?.confirmed || saved && this.hasCompletedBinding(sourceID, thread, saved)))
        throw new PoolError("pool_recovery_requires_full_history", 409);
      if (!previous || previous.account !== selected.id || previous.identity !== selected.identity || previous.source_identity !== source.identity)
        this.db.query("DELETE FROM binding_proofs WHERE source=? AND thread=?").run(sourceID, thread);
      this.db.query(`INSERT INTO bindings VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,thread) DO UPDATE SET
        account=excluded.account,identity=excluded.identity,source_identity=excluded.source_identity,label=excluded.label,updated_ms=excluded.updated_ms`)
        .run(sourceID, thread, selected.id, selected.identity, source.identity, selected.label, now);
      if (preserveNative) this.db.query("DELETE FROM replay_filters WHERE source=? AND thread=?").run(sourceID, thread);
      else if (foreignReasoning) this.db.query("INSERT OR REPLACE INTO replay_filters VALUES (?,?,?)")
        .run(sourceID, thread, JSON.stringify(foreignReasoning));
      this.db.query("INSERT INTO requests(id,source,thread,account,label,reason,state,at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(input.requestId, sourceID, thread, selected.id, selected.label, reason, "started", now);
      this.db.query("INSERT INTO request_identities VALUES (?,?,?)").run(input.requestId, selected.identity, source.identity);
      // Keep durable bindings; only old request telemetry is pruned.
      this.db.query("DELETE FROM requests WHERE at_ms < ?").run(now - 30 * 86400_000);
      this.db.query("DELETE FROM request_identities WHERE id NOT IN (SELECT id FROM requests)").run();
      const headers = new Headers(input.headers);
      headers.set("authorization", `Bearer ${selected.accessToken}`);
      headers.set("chatgpt-account-id", selected.upstreamAccount);
      this.pendingSelections.set(input.requestId, { source: sourceID, thread, account: selected.id, identity: selected.identity, previous, proof, replay });
      return { route: { sourceAccount: sourceID, account: selected.id, accountLabel: selected.label, reason,
        ...(previousAccountLabel ? { previousAccountLabel } : {}) }, headers, body: replayBody,
        identity: selected.identity, credentialDigest: credentialDigest(selected.accessToken) };
    });
    return execute.immediate();
  }
  /** Undo only a request proven not to have reached fetch, and only while no
   * later selection has inherited its binding. Never use after a network attempt. */
  rollbackUnsentAsync(requestId: string): Promise<void> {
    return this.withContentionRetry(() => {
      const pending = this.pendingSelections.get(requestId);
      if (!pending) return;
      this.db.transaction(() => {
        const latest = this.db.query<{id:string;state:string;status:number}, [string,string]>(
          "SELECT id,state,status FROM requests WHERE source=? AND thread=? ORDER BY at_ms DESC,rowid DESC LIMIT 1").get(pending.source, pending.thread);
        const binding = this.db.query<Binding, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(pending.source, pending.thread);
        if (latest?.id !== requestId || latest.state !== "started" || latest.status !== 0 ||
            binding?.account !== pending.account || binding.identity !== pending.identity) return;
        if (pending.previous) this.db.query("INSERT OR REPLACE INTO bindings VALUES (?,?,?,?,?,?,?)").run(
          pending.source, pending.thread, pending.previous.account, pending.previous.identity,
          pending.previous.source_identity, pending.previous.label, pending.previous.updated_ms);
        else this.db.query("DELETE FROM bindings WHERE source=? AND thread=?").run(pending.source, pending.thread);
        if (pending.replay !== null) this.db.query("INSERT OR REPLACE INTO replay_filters VALUES (?,?,?)").run(pending.source, pending.thread, pending.replay);
        else this.db.query("DELETE FROM replay_filters WHERE source=? AND thread=?").run(pending.source, pending.thread);
        if (pending.proof) this.db.query("INSERT OR REPLACE INTO binding_proofs VALUES (?,?,?,?,?)").run(
          pending.source, pending.thread, pending.proof.account, pending.proof.identity, pending.proof.source_identity);
        else this.db.query("DELETE FROM binding_proofs WHERE source=? AND thread=?").run(pending.source, pending.thread);
        this.db.query("DELETE FROM requests WHERE id=?").run(requestId);
        this.db.query("DELETE FROM request_identities WHERE id=?").run(requestId);
      }).immediate();
      this.pendingSelections.delete(requestId);
    });
  }
  response(requestId: string, identity: string, status: number, retryAfter: string | null, digest?: string) {
    this.pendingSelections.delete(requestId);
    this.db.transaction(() => {
      this.db.query("UPDATE requests SET status=? WHERE id=?").run(status, requestId);
      if ([401,403].includes(status) && digest) {
        this.db.query(`INSERT INTO auth_cooldowns VALUES (?,?,?,?) ON CONFLICT(identity,digest)
          DO UPDATE SET status=excluded.status,until_ms=MAX(until_ms,excluded.until_ms)`)
          .run(identity, digest, status, this.now() + 60_000);
      } else if ([401,403,429].includes(status)) {
        // Missing digests retain legacy behavior for older callers. New relays
        // quarantine authentication failures by token so refresh can recover.
        const seconds = Number(retryAfter);
        const until = status === 429 && retryAfter != null
          ? Number.isFinite(seconds) ? this.now() + Math.max(1, Math.min(seconds, 86400)) * 1000 : Date.parse(retryAfter)
          : NaN;
        this.db.query("INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)")
          .run(identity, Number.isFinite(until) && until > this.now() ? Math.min(until, this.now()+86400_000) : this.now() + 60_000);
      }
    }).immediate();
  }
  finish(requestId: string, state: string) {
    this.pendingSelections.delete(requestId);
    this.db.transaction(() => {
      this.db.query("UPDATE requests SET state=? WHERE id=?").run(state,requestId);
      if (state === "completed") {
        this.db.query(`INSERT OR REPLACE INTO binding_proofs(source,thread,account,identity,source_identity)
          SELECT b.source,b.thread,b.account,b.identity,b.source_identity FROM bindings b
          JOIN requests r ON r.source=b.source AND r.thread=b.thread AND r.account=b.account
          JOIN request_identities i ON i.id=r.id AND i.identity=b.identity AND i.source_identity=b.source_identity
          WHERE r.id=? AND r.status>=200 AND r.status<300`).run(requestId);
        // Legacy errors have no task identity. Clear only errors already present
        // when this successful request started, never a newer concurrent failure.
        this.db.query(`DELETE FROM errors WHERE EXISTS (SELECT 1 FROM requests r
          WHERE r.id=? AND r.source=errors.source AND r.status>=200 AND r.status<300
            AND errors.at_ms<=r.at_ms)`).run(requestId);
      }
    }).immediate();
  }
  reject(code: string, context?: { requestId: string; threadId: string | null; status: number }) {
    const source = this.options.sourceAccount, now = this.now();
    this.db.transaction(() => {
      if (context) {
        // No serving account was selected; do not attribute this to the source.
        this.db.query(`INSERT INTO requests(id,source,thread,account,label,reason,state,status,at_ms)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(context.requestId, source, context.threadId ?? "", "", "", code, "rejected", context.status, now);
        this.db.query("DELETE FROM errors WHERE source=?").run(source);
        this.db.query("DELETE FROM requests WHERE at_ms < ?").run(now - 30 * 86400_000);
      } else {
        this.db.query("INSERT INTO errors VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET code=excluded.code,at_ms=excluded.at_ms")
          .run(source, code, now);
      }
    }).immediate();
  }
}

export function poolStatus(path = poolDatabasePath(), policyPath = poolPolicyPath()) {
  const policy = readPoolPolicy(policyPath);
  if (!existsSync(path)) return { ...policy, recent: [], rejected: [], unresolvedRejections: null, error: null };
  const db = new Database(path, { readonly: true });
  try {
    const recent = db.query("SELECT source AS sourceAccount, account, label AS accountLabel, reason, state, status, at_ms AS atMs FROM requests WHERE account<>'' ORDER BY at_ms DESC,rowid DESC LIMIT 5").all();
    const laterSuccess = (sameThread: boolean) => `EXISTS (SELECT 1 FROM requests done
      WHERE done.source=r.source ${sameThread ? "AND done.thread=r.thread" : ""}
        AND done.state='completed' AND done.status>=200 AND done.status<300
        AND (done.at_ms>r.at_ms OR (done.at_ms=r.at_ms AND done.rowid>r.rowid)))`;
    const recovered = `(CASE WHEN r.thread='' THEN ${laterSuccess(false)} ELSE ${laterSuccess(true)} END)`;
    const rejected = db.query<{requestId:string;sourceAccount:string;threadId:string;code:string;status:number;atMs:number;recovered:number}, []>(
      `SELECT id AS requestId,source AS sourceAccount,thread AS threadId,reason AS code,status,at_ms AS atMs,
        ${recovered} AS recovered FROM requests r WHERE state='rejected' ORDER BY at_ms DESC,rowid DESC LIMIT 5`)
      .all().map(row => ({ ...row, recovered: Boolean(row.recovered) }));
    // A rejection belongs to one request, not the whole pool's current health.
    // Keep unresolved history explicitly: neither elapsed time nor a different
    // task succeeding is evidence that the rejected task recovered.
    const unresolvedRejections = db.query<{count:number;latestCode:string;latestAtMs:number}, []>(
      `SELECT COUNT(*) OVER () AS count,reason AS latestCode,at_ms AS latestAtMs
        FROM requests r WHERE state='rejected' AND NOT ${recovered}
        ORDER BY at_ms DESC,rowid DESC LIMIT 1`).get() ?? null;
    const failed = db.query<{code:string}, []>(`SELECT CASE
        WHEN status IN (401,403) THEN 'pool_auth_cooldown'
        WHEN status=429 THEN 'pool_account_cooldown'
        WHEN state='unverified' THEN 'pool_response_unverified'
        ELSE 'pool_request_failed' END AS code
      FROM requests r WHERE state IN ('failed','unverified') AND NOT ${recovered}
      ORDER BY at_ms DESC,rowid DESC LIMIT 1`).get();
    const error = failed?.code ?? db.query<{code:string}, []>("SELECT code FROM errors ORDER BY at_ms DESC LIMIT 1").get()?.code ?? null;
    return { ...policy, recent, rejected, unresolvedRejections, error };
  } finally { db.close(); }
}

export function runPoolCommand(args: string[]): number {
  const action = args[0] ?? "status";
  if (action === "enable") {
    const index = args.indexOf("--accounts");
    const ids = index >= 0 ? args[index+1]?.split(",") ?? [] : [];
    const config = loadConfig(), known = poolAccounts(config);
    if (ids.length < 2 || new Set(ids).size !== ids.length || ids.some(id => !known.some(a => a.id === id)))
      throw new PoolError("pool_requires_two_registered_file_accounts");
    if (new Set(ids.map(id => known.find(a => a.id === id)!.upstreamAccount)).size !== ids.length)
      throw new PoolError("pool_duplicate_login");
    const previous = readPoolPolicy();
    savePoolPolicy({ enabled: true, accounts: ids, ...(previous.reservePercent ? {
      reservePercent: Object.fromEntries(Object.entries(previous.reservePercent).filter(([id]) => ids.includes(id))) } : {}) });
  } else if (action === "disable") savePoolPolicy({ ...readPoolPolicy(), enabled: false });
  else if (action === "reserve") {
    if (args.length !== 3 || !/^\d{1,3}$/.test(args[2]!)) throw new PoolError("pool_invalid_reserve", 400);
    configurePoolPolicy({ account: args[1], reservePercent: Number(args[2]) });
  }
  else if (action !== "status") throw new PoolError("pool_invalid_command");
  console.log(JSON.stringify(poolStatus(), null, 2));
  return 0;
}
