import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexProfileRoot, codexUsesFileCredentials, dataDirectory, loadConfig, type AppConfig } from "./config";
import { defaultWorkBoundaryPath, profileReference } from "./work-boundary";

export interface PoolPolicy { enabled: boolean; accounts: string[] }
export interface PoolAccount {
  id: string; label: string; identity: string; accessToken: string; upstreamAccount: string;
  tokenExpiresAt: number; models: string[]; remaining: number | null; validUntil: number;
}
export interface PoolRoute { sourceAccount: string; account: string; accountLabel: string; reason: "new" | "pinned" | "existing" }
export class PoolError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
export const poolPolicyPath = () => join(dataDirectory(), "account-pool.json");
export const poolDatabasePath = () => join(dataDirectory(), "account-pool.sqlite3");
const SHARED_QUOTA_MODELS = new Set(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
export function readPoolPolicy(path = poolPolicyPath()): PoolPolicy {
  if (!existsSync(path)) return { enabled: false, accounts: [] };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.accounts) ||
      value.accounts.length > 32 || value.accounts.some((id: unknown) => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)) ||
      new Set(value.accounts).size !== value.accounts.length) throw new PoolError("pool_invalid_policy");
  return { enabled: value.enabled, accounts: value.accounts };
}
export function savePoolPolicy(policy: PoolPolicy, path = poolPolicyPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID();
  writeFileSync(temporary, JSON.stringify(policy) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
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
      return [{ id: profile.id, label: profile.label, identity, accessToken: token, upstreamAccount,
        tokenExpiresAt: claims.exp * 1000, models, remaining: fresh ? Math.min(...windows.map((w: any) => w.remainingPercent)) : null,
        validUntil: fresh ? Math.min(...windows.map((w: any) => w.validUntilMs)) : 0 }];
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

function hasAttachments(body: any): boolean {
  return Array.isArray(body?.input) && body.input.some((item: any) =>
    Array.isArray(item?.content) && item.content.some((c: any) => ["input_image", "input_file"].includes(c?.type)));
}

type Binding = { account: string; identity: string; source_identity: string; label: string };
export class AccountPool {
  private db: Database;
  constructor(private options: {
    path?: string; sourceAccount: string; accounts: () => PoolAccount[]; policy: () => PoolPolicy; now?: () => number;
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
    this.db.run(`CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread TEXT NOT NULL,
      account TEXT NOT NULL, label TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL)`);
    this.db.run("CREATE TABLE IF NOT EXISTS errors (source TEXT PRIMARY KEY, code TEXT NOT NULL, at_ms INTEGER NOT NULL)");
    if (path !== ":memory:") for (const p of [path, path + "-wal", path + "-shm"]) if (existsSync(p)) chmodSync(p, 0o600);
  }
  close() { this.db.close(); }
  private now() { return this.options.now?.() ?? Date.now(); }
  select(input: { threadId: string | null; requestId: string; body: unknown; model: string; headers: Headers }): { route: PoolRoute; headers: Headers; identity: string } | null {
    const policy = this.options.policy(), sourceID = this.options.sourceAccount, thread = input.threadId;
    if (!thread) { if (policy.enabled && policy.accounts.includes(sourceID)) throw new PoolError("pool_thread_identity_required", 409); return null; }
    const execute = this.db.transaction(() => {
      const saved = this.db.query<Binding, [string,string]>("SELECT * FROM bindings WHERE source=? AND thread=?").get(sourceID, thread);
      if (!saved && (!policy.enabled || !policy.accounts.includes(sourceID))) return null;
      const now = this.now(), accounts = this.options.accounts(), source = accounts.find(a => a.id === sourceID);
      if (!source || source.tokenExpiresAt <= now + 30_000) throw new PoolError("pool_source_auth_unavailable", 401);
      // A profile endpoint cannot be used with an unrelated caller identity.
      if (input.headers.get("chatgpt-account-id") !== source.upstreamAccount || input.headers.get("authorization") !== `Bearer ${source.accessToken}`)
        throw new PoolError("pool_source_identity_mismatch", 401);
      const cooling = (a: PoolAccount) => (this.db.query<{until_ms:number}, [string]>("SELECT until_ms FROM cooldowns WHERE identity=?").get(a.identity)?.until_ms ?? 0) > now;
      let selected: PoolAccount | undefined, reason: PoolRoute["reason"];
      if (saved) {
        selected = accounts.find(a => a.id === saved.account);
        if (source.identity !== saved.source_identity || !selected || selected.identity !== saved.identity) throw new PoolError("pool_bound_identity_changed", 409);
        if (selected.id !== sourceID && !policy.accounts.includes(selected.id)) throw new PoolError("pool_bound_account_removed", 409);
        reason = "pinned";
      } else if (!isFreshTextTurn(input.body) || !SHARED_QUOTA_MODELS.has(input.model)) { selected = source; reason = "existing"; }
      else {
        selected = accounts.filter(a => policy.accounts.includes(a.id) && a.tokenExpiresAt > now + 30_000 &&
          a.models.includes(input.model) && a.remaining != null && a.remaining > 0 && a.validUntil > now && !cooling(a))
          .sort((a,b) => b.remaining! - a.remaining! || a.id.localeCompare(b.id))[0];
        reason = "new";
      }
      if (!selected) throw new PoolError("pool_no_eligible_account", 429);
      if (selected.tokenExpiresAt <= now + 30_000) throw new PoolError("pool_target_auth_unavailable", 401);
      if (cooling(selected) || selected.remaining === 0 && selected.validUntil > now) throw new PoolError("pool_bound_account_exhausted", 429);
      if (selected.id !== sourceID && !selected.models.includes(input.model)) throw new PoolError("pool_model_unavailable", 409);
      if (selected.id !== sourceID && !SHARED_QUOTA_MODELS.has(input.model)) throw new PoolError("pool_quota_scope_unsupported", 409);
      if (selected.id !== sourceID && hasAttachments(input.body)) throw new PoolError("pool_attachment_account_unverified", 409);
      this.db.query(`INSERT INTO bindings VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,thread) DO UPDATE SET updated_ms=excluded.updated_ms`)
        .run(sourceID, thread, selected.id, selected.identity, source.identity, selected.label, now);
      this.db.query("INSERT INTO requests(id,source,thread,account,label,reason,state,at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(input.requestId, sourceID, thread, selected.id, selected.label, reason, "started", now);
      // Keep durable bindings; only old request telemetry is pruned.
      this.db.query("DELETE FROM requests WHERE at_ms < ?").run(now - 30 * 86400_000);
      this.db.query("DELETE FROM errors WHERE source=?").run(sourceID);
      const headers = new Headers(input.headers);
      headers.set("authorization", `Bearer ${selected.accessToken}`);
      headers.set("chatgpt-account-id", selected.upstreamAccount);
      return { route: { sourceAccount: sourceID, account: selected.id, accountLabel: selected.label, reason }, headers, identity: selected.identity };
    });
    return execute.immediate();
  }
  response(requestId: string, identity: string, status: number, retryAfter: string | null) {
    this.db.query("UPDATE requests SET status=? WHERE id=?").run(status, requestId);
    if ([401,403,429].includes(status)) {
      const seconds = Number(retryAfter);
      const until = status === 429 && retryAfter != null
        ? Number.isFinite(seconds) ? this.now() + Math.max(1, Math.min(seconds, 86400)) * 1000 : Date.parse(retryAfter)
        : NaN;
      this.db.query("INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(identity) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)")
        .run(identity, Number.isFinite(until) && until > this.now() ? Math.min(until, this.now()+86400_000) : this.now() + 60_000);
    }
  }
  finish(requestId: string, state: string) { this.db.query("UPDATE requests SET state=? WHERE id=?").run(state,requestId); }
  reject(code: string) { this.db.query("INSERT INTO errors VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET code=excluded.code,at_ms=excluded.at_ms")
    .run(this.options.sourceAccount, code, this.now()); }
}

export function poolStatus(path = poolDatabasePath(), policyPath = poolPolicyPath()) {
  const policy = readPoolPolicy(policyPath);
  if (!existsSync(path)) return { ...policy, recent: [] };
  const db = new Database(path, { readonly: true });
  try {
    const recent = db.query("SELECT source AS sourceAccount, account, label AS accountLabel, reason, state, status, at_ms AS atMs FROM requests ORDER BY at_ms DESC LIMIT 5").all();
    const error = db.query<{code:string}, []>("SELECT code FROM errors ORDER BY at_ms DESC LIMIT 1").get()?.code ?? null;
    return { ...policy, recent, error };
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
    savePoolPolicy({ enabled: true, accounts: ids });
  } else if (action === "disable") savePoolPolicy({ ...readPoolPolicy(), enabled: false });
  else if (action !== "status") throw new PoolError("pool_invalid_command");
  console.log(JSON.stringify(poolStatus(), null, 2));
  return 0;
}
