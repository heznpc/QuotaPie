import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexProfileRoot, codexUsesFileCredentials, dataDirectory, loadConfig, type AppConfig } from "./config";
import type { CodexForkParentResult } from "./account-pool-lineage";
import { defaultWorkBoundaryPath, profileReference } from "./work-boundary";
import { portableReplay, filterForeignReasoning } from "./account-replay";

export interface PoolPolicy { enabled: boolean; accounts: string[]; reservePercent?: Record<string, number> }
export interface PoolAccount {
  id: string; label: string; identity: string; accessToken: string; upstreamAccount: string;
  tokenExpiresAt: number; models: string[]; remaining: number | null; validUntil: number; observedAtMs?: number;
}
export interface PoolRoute { sourceAccount: string; account: string; accountLabel: string; reason: "new" | "pinned" | "existing" | "source_fallback" | "recovered" | "reserve"; previousAccountLabel?: string }
export class PoolError extends Error {
  constructor(readonly code: string, readonly status = 503, readonly retryAfterSeconds?: number) { super(code); }
}
export const poolPolicyPath = () => join(dataDirectory(), "account-pool.json");
export const poolDatabasePath = () => join(dataDirectory(), "account-pool.sqlite3");
const SHARED_QUOTA_MODELS = new Set(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
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
  return { enabled: value.enabled, accounts: value.accounts,
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
        w.freshness === "fresh" && Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100 &&
        Number.isFinite(w.observedAtMs) && w.observedAtMs >= stamp.mtimeMs && w.observedAtMs <= now + 5000 &&
        Number.isFinite(w.validUntilMs) && w.validUntilMs > now && (w.resetsAtMs == null || w.resetsAtMs > now));
      const remaining = fresh ? Math.min(...windows.map((w: any) => w.remainingPercent)) : null;
      // Remember the newest exhausted window; recovery needs positive evidence
      // strictly newer for every window so old relay snapshots cannot reset it.
      const observedAtMs = fresh ? remaining === 0
        ? Math.max(...windows.filter((w: any) => w.remainingPercent === 0).map((w: any) => w.observedAtMs))
        : Math.min(...windows.map((w: any) => w.observedAtMs)) : undefined;
      return [{ id: profile.id, label: profile.label, identity, accessToken: token, upstreamAccount,
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

type Binding = { account: string; identity: string; source_identity: string; label: string; foreignReasoning?: string[] };
type PoolSelectInput = { threadId: string | null; requestId: string; body: unknown; model: string; headers: Headers };
type SourceOnlyReplay = { sourceReplay: NonNullable<ReturnType<typeof portableReplay>> };
export class AccountPool {
  private db: Database;
  private closed = false;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  constructor(private options: {
    path?: string; sourceAccount: string; accounts: () => PoolAccount[]; policy: () => PoolPolicy; now?: () => number; contentionWaitMs?: number; forkParent?: (threadId: string) => CodexForkParentResult;
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
  selectAsync(input: PoolSelectInput, signal?: AbortSignal): Promise<ReturnType<AccountPool["select"]>> {
    return this.withContentionRetry(() => this.select(input), signal);
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
  private reserve(account: PoolAccount): number {
    const policy = this.options.policy();
    return policy.enabled && policy.reservePercent && Object.hasOwn(policy.reservePercent, account.id)
      ? policy.reservePercent[account.id]! : 0;
  }
  private reserveBlock(account: PoolAccount): string | null {
    const reserve = this.reserve(account);
    if (reserve <= 0) return null;
    if (account.remaining == null || account.validUntil <= this.now()) return "pool_reserve_quota_unavailable";
    return account.remaining <= reserve ? "pool_reserve_reached" : null;
  }
  private foreignReasoning(source: string, thread: string): string[] | undefined {
    const row = this.db.query<{fingerprints:string}, [string,string]>("SELECT fingerprints FROM replay_filters WHERE source=? AND thread=?").get(source, thread);
    return row ? JSON.parse(row.fingerprints) : undefined;
  }
  private eligible(accounts: PoolAccount[], model: string, exclude?: string): PoolAccount[] {
    const now = this.now(), policy = this.options.policy();
    return accounts.filter(a => a.id !== exclude && policy.accounts.includes(a.id) && a.tokenExpiresAt > now + 30_000 &&
      a.models.includes(model) && a.remaining != null && a.remaining > this.reserve(a) && a.validUntil > now &&
      // Leave a small margin before entering a protected account, avoiding
      // repeated transfers when quota observations hover around its threshold.
      (this.reserve(a) === 0 || a.remaining >= Math.min(100, this.reserve(a) + 5)) &&
      !this.db.query("SELECT 1 FROM quota_observations WHERE identity=? AND exhausted=1").get(a.identity) &&
      !this.db.query("SELECT 1 FROM cooldowns WHERE identity=? AND until_ms>?").get(a.identity, now) &&
      !this.db.query("SELECT 1 FROM auth_cooldowns WHERE identity=? AND digest=? AND until_ms>?").get(a.identity, credentialDigest(a.accessToken), now))
      .sort((a,b) => Number(b.id === this.options.sourceAccount) - Number(a.id === this.options.sourceAccount) || b.remaining! - a.remaining! || a.id.localeCompare(b.id));
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
      if (source && source.tokenExpiresAt > now + 30_000)
        this.db.query("INSERT OR REPLACE INTO source_credentials VALUES (?,?,?,?)")
          .run(source.id, source.identity, credentialDigest(source.accessToken), source.tokenExpiresAt);
    }).immediate();
  }
  private inheritedBinding(source: string, thread: string, body: unknown): Binding | SourceOnlyReplay | null {
    if (!this.options.forkParent) return null;
    const seen = new Set([thread]);
    for (let depth = 0; depth < 32; depth++) {
      const lineage = this.options.forkParent(thread);
      if (lineage.status === "unknown") {
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
      if (binding) return { ...binding, foreignReasoning: this.foreignReasoning(source, thread) };
    }
    throw new PoolError("pool_lineage_invalid", 409);
  }
  select(input: PoolSelectInput): { route: PoolRoute; headers: Headers; identity: string; credentialDigest: string; body: unknown } | null {
    const policy = this.options.policy(), sourceID = this.options.sourceAccount, thread = input.threadId;
    if (!thread) { if (policy.enabled && policy.accounts.includes(sourceID)) throw new PoolError("pool_thread_identity_required", 409); return null; }
    const now = this.now(), accounts = this.options.accounts(), source = accounts.find(a => a.id === sourceID);
    // File observations must survive a later routing rejection. Caller-supplied
    // credentials are never added to this trusted history.
    this.rememberSource(source, accounts);
    const execute = this.db.transaction(() => {
      let saved = this.db.query<Binding, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(sourceID, thread);
      let sourceReplay: SourceOnlyReplay["sourceReplay"] | undefined;
      // Resolve forks even with new assignment disabled: inherited remote state
      // must remain on the account that created it.
      if (!saved && this.options.forkParent && (policy.accounts.includes(sourceID) ||
          this.db.query("SELECT 1 FROM bindings WHERE source=? LIMIT 1").get(sourceID))) {
        const inherited = this.inheritedBinding(sourceID, thread, input.body);
        if (inherited && "sourceReplay" in inherited) sourceReplay = inherited.sourceReplay;
        else saved = inherited;
      }
      // A source-only replay has already removed foreign account caches. Keep
      // that validated body and authenticate its source even when new pool
      // assignment is disabled; returning null would forward the original body.
      if (!saved && !sourceReplay && (!policy.enabled || !policy.accounts.includes(sourceID))) return null;
      if (!source || source.tokenExpiresAt <= now + 30_000) throw new PoolError("pool_source_auth_unavailable", 401);
      // Accept only current or previously observed file credentials for this
      // exact login identity. Do not trust unsigned JWT identity claims from a
      // caller. Hashes survive relay restart; expired credentials are pruned.
      const bearer = input.headers.get("authorization");
      const digest = bearer?.startsWith("Bearer ") ? credentialDigest(bearer.slice(7)) : "";
      const known = this.db.query("SELECT 1 FROM source_credentials WHERE source=? AND identity=? AND digest=? AND expires_ms>?")
        .get(sourceID, source.identity, digest, now + 30_000);
      if (input.headers.get("chatgpt-account-id") !== source.upstreamAccount || !known)
        throw new PoolError("pool_source_identity_mismatch", 401);
      const isExhausted = (a: PoolAccount) => !!this.db.query("SELECT 1 FROM quota_observations WHERE identity=? AND exhausted=1").get(a.identity);
      const cooldownUntil = (a: PoolAccount) => this.db.query<{until_ms:number}, [string]>("SELECT until_ms FROM cooldowns WHERE identity=?").get(a.identity)?.until_ms ?? 0;
      const authCooldown = (a: PoolAccount) => this.db.query<{status:number;until_ms:number}, [string,string,number]>(
        "SELECT status,until_ms FROM auth_cooldowns WHERE identity=? AND digest=? AND until_ms>?")
        .get(a.identity, credentialDigest(a.accessToken), now);
      let selected: PoolAccount | undefined, reason: PoolRoute["reason"];
      let foreignReasoning = sourceReplay?.fingerprints ?? saved?.foreignReasoning ?? this.foreignReasoning(sourceID, thread);
      let replayBody = sourceReplay?.body ?? filterForeignReasoning(input.body, foreignReasoning);
      let previousAccountLabel: string | undefined;
      if (saved && source.identity !== saved.source_identity) {
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
            (cooldownUntil(selected) > now || isExhausted(selected) || this.reserveBlock(selected))) {
          const replacement = this.eligible(accounts, input.model, selected.id)[0];
          if (replacement) {
            const replay = portableReplay(replayBody);
            if (replay) {
              previousAccountLabel = selected.label;
              reason = this.reserveBlock(selected) && cooldownUntil(selected) <= now ? "reserve" : "recovered";
              selected = replacement; replayBody = replay.body;
              foreignReasoning = [...new Set([...(foreignReasoning ?? []), ...replay.fingerprints])];
            } else if (cooldownUntil(selected) > now || isExhausted(selected) || this.reserveBlock(selected)) {
              throw new PoolError("pool_recovery_requires_full_history", 409);
            }
          }
        }
      } else if (sourceReplay || !isFreshTextTurn(input.body) || !SHARED_QUOTA_MODELS.has(input.model)) { selected = source; reason = "existing"; }
      else {
        // Unknown source quota is not permission to silently change the login.
        selected = !isExhausted(source) && !this.reserveBlock(source) && (source.remaining == null || source.remaining > 0) && cooldownUntil(source) <= now && !authCooldown(source)
          ? source : this.eligible(accounts, input.model)[0];
        // Never-observed quota retains the caller's login. Confirmed exhaustion
        // remains protected, and a different account needs fresh positive quota.
        reason = selected ? (this.reserveBlock(source) && selected.id !== source.id ? "reserve" : "new") : "source_fallback";
        selected ??= source;
      }
      if (selected.tokenExpiresAt <= now + 30_000) throw new PoolError("pool_target_auth_unavailable", 401);
      // A confirmed exhausted identity must not silently spend paid credits when
      // this request cannot be moved to a registered account with quota.
      if (policy.enabled && isExhausted(selected))
        throw new PoolError(selected.id === sourceID ? "pool_source_quota_exhausted" : "pool_target_quota_exhausted", 409);
      const reserveBlock = this.reserveBlock(selected);
      if (reserveBlock) throw new PoolError(reserveBlock, 409);
      const until = cooldownUntil(selected);
      if (until > now) throw new PoolError("pool_account_cooldown", 429, Math.ceil((until - now) / 1000));
      const auth = authCooldown(selected);
      if (auth) throw new PoolError("pool_auth_cooldown", auth.status, Math.ceil((auth.until_ms - now) / 1000));
      if (selected.id !== sourceID && !selected.models.includes(input.model)) throw new PoolError("pool_model_unavailable", 409);
      if (selected.id !== sourceID && !SHARED_QUOTA_MODELS.has(input.model)) throw new PoolError("pool_quota_scope_unsupported", 409);
      if (selected.id !== sourceID && hasUnverifiedAttachments(input.body)) throw new PoolError("pool_attachment_account_unverified", 409);
      this.db.query(`INSERT INTO bindings VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,thread) DO UPDATE SET
        account=excluded.account,identity=excluded.identity,source_identity=excluded.source_identity,label=excluded.label,updated_ms=excluded.updated_ms`)
        .run(sourceID, thread, selected.id, selected.identity, source.identity, selected.label, now);
      if (foreignReasoning) this.db.query("INSERT OR REPLACE INTO replay_filters VALUES (?,?,?)")
        .run(sourceID, thread, JSON.stringify(foreignReasoning));
      this.db.query("INSERT INTO requests(id,source,thread,account,label,reason,state,at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(input.requestId, sourceID, thread, selected.id, selected.label, reason, "started", now);
      // Keep durable bindings; only old request telemetry is pruned.
      this.db.query("DELETE FROM requests WHERE at_ms < ?").run(now - 30 * 86400_000);
      const headers = new Headers(input.headers);
      headers.set("authorization", `Bearer ${selected.accessToken}`);
      headers.set("chatgpt-account-id", selected.upstreamAccount);
      return { route: { sourceAccount: sourceID, account: selected.id, accountLabel: selected.label, reason,
        ...(previousAccountLabel ? { previousAccountLabel } : {}) }, headers, body: replayBody,
        identity: selected.identity, credentialDigest: credentialDigest(selected.accessToken) };
    });
    return execute.immediate();
  }
  response(requestId: string, identity: string, status: number, retryAfter: string | null, digest?: string) {
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
    this.db.transaction(() => {
      this.db.query("UPDATE requests SET state=? WHERE id=?").run(state,requestId);
      if (state === "completed") {
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
