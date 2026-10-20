import { Database } from "bun:sqlite";
import { readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { type AppConfig } from "./config";
import { creditConsent, savePoolPolicy, poolAccounts, readPoolPolicy, type PoolAccount } from "./account-pool";
import { manualTargets, setManualTarget, type ManualTargetStatus } from "./manual-account-routing";
import { codexSessionLocation } from "./session-location";
import type { RoutingSummary } from "./request-routing";

export class RequestAccountError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
interface ThreadMetadata {
  threadId: string; sourceAccount: string; title: string; model: string | null;
  /** Verified local host for future requests, never evidence of a past billing account. */
  hostAccount?: string;
}

/** Names and model metadata only. Never read the transcript or first message. */
export function requestAccountThreads(config: AppConfig): ThreadMetadata[] {
  const result: ThreadMetadata[] = [], roots = new Set<string>();
  for (const profile of config.accounts.codex.filter(p => p.enabled)) {
    let db: Database | undefined;
    try {
      const location = codexSessionLocation(config, profile.id);
      if (!location) continue;
      const root = realpathSync(location.sessionRoot);
      if (roots.has(root)) continue;
      roots.add(root);
      const name = readdirSync(root).filter(n => /^state_\d+\.sqlite$/.test(n))
        .sort((a,b) => Number(b.slice(6,-7)) - Number(a.slice(6,-7)))[0];
      if (!name) continue;
      const path = realpathSync(join(root, name));
      if (dirname(path) !== root) continue;
      db = new Database(path, { readonly: true, strict: true });
      const columns = new Set(db.query<{name:string}, []>("PRAGMA table_info(threads)").all().map(c => c.name));
      const display = columns.has("name") ? "COALESCE(NULLIF(name,''),title)" : "title";
      const model = columns.has("model") ? "model" : "NULL";
      const provider = columns.has("model_provider") ? "model_provider" : "NULL";
      const updated = columns.has("updated_at_ms") ? "updated_at_ms" : "updated_at";
      const rows = db.query<{id:string;title:string;model:string|null;provider:string|null}, []>(
        `SELECT id,${display} AS title,${model} AS model,${provider} AS provider FROM threads WHERE archived=0 ORDER BY ${updated} DESC LIMIT 1000`).all();
      for (const row of rows) if (uuid.test(row.id)) result.push({ threadId: row.id, sourceAccount: profile.id,
        ...(row.provider === "openai" ? { hostAccount: location.ownerAccount } : {}),
        title: typeof row.title === "string" ? row.title.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,200) : "",
        model: typeof row.model === "string" && /^[a-z0-9_.-]{1,80}$/i.test(row.model) ? row.model : null });
    } catch { /* An unreadable store is unavailable, never another account. */ }
    finally { db?.close(); }
  }
  return result;
}

export class RequestAccountAPI {
  constructor(private config: AppConfig, private options: {
    databasePath?: string; policyPath?: string;
    accounts?: () => PoolAccount[]; threads?: () => ThreadMetadata[];
    targets?: () => ManualTargetStatus[];
    setTarget?: typeof setManualTarget;
  } = {}) {}

  private candidates(routing: RoutingSummary) {
    const targets = this.options.targets?.() ?? manualTargets(this.options.databasePath);
    const observed = [...routing.active, ...routing.recent];
    const history = routing.history ?? [];
    const threads = this.options.threads?.() ?? requestAccountThreads(this.config);
    // The relay identifies the credential source. A consolidated physical store
    // supplies display metadata only; its owner is not the request account.
    const grouped = new Map<string, Set<string>>();
    for (const row of [...observed, ...history]) if (row.threadId && row.sourceAccount) {
      const sources = grouped.get(row.threadId) ?? new Set<string>();
      sources.add(row.sourceAccount); grouped.set(row.threadId, sources);
    }
    // A quiet conversation must remain selectable after its request ages out of
    // the telemetry ring. Persisted choices and verified native host metadata
    // identify future routing; they never invent a current processing account.
    for (const thread of threads) if (!grouped.has(thread.threadId)) {
      const saved = targets.filter(t => t.threadId === thread.threadId);
      const sources = new Set(saved.map(t => t.sourceAccount));
      if (!saved.length && thread.hostAccount) sources.add(thread.hostAccount);
      if (sources.size) grouped.set(thread.threadId, sources);
    }
    return [...grouped].filter(([,sources]) => sources.size === 1).flatMap(([threadId,sources]) => {
      const sourceAccount = [...sources][0]!;
      const metadata = threads.find(t => t.threadId === threadId);
      if (!metadata) return [];
      const route = observed.find(r => r.threadId === threadId && r.sourceAccount === sourceAccount && r.kind === "response");
      // A pending or locally blocked request must not erase the last provider-confirmed account.
      // Keep execution/continuation decisions on the latest route, independently of display history.
      const confirmed = [...observed, ...history].filter(r => r.threadId === threadId && r.sourceAccount === sourceAccount &&
        r.kind === "response" && r.upstreamResponseObserved && r.account && r.attribution !== "unknown")
        .sort((a, b) => b.observedAtMs - a.observedAtMs)[0];
      const target = targets.find(t => t.threadId === threadId && t.sourceAccount === sourceAccount);
      return [{ threadId, sourceAccount, title: metadata.title, model: route?.model || metadata.model || target?.model,
        pendingTurnId: route?.upstreamResponseObserved && route.account === sourceAccount &&
          route.attribution !== "unknown" ? route.turnId : null,
        currentAccount: confirmed?.account ?? null,
        targetAccount: target?.account ?? null,
        active: !!confirmed && routing.active.includes(confirmed) && route === confirmed }];
    }).sort((a,b) => Number(b.active)-Number(a.active));
  }

  read(routing: RoutingSummary, labels: Map<string,string>, now = Date.now()) {
    const accounts = this.options.accounts?.() ?? poolAccounts(this.config);
    const policy = readPoolPolicy(this.options.policyPath);
    return { conversations: this.candidates(routing).map(({model: _model,pendingTurnId: _turn,...row}) => row),
      accounts: this.config.accounts.codex.filter(p => p.enabled).map(profile => {
        const account = accounts.find(a => a.id === profile.id);
        const enrolled = policy.accounts.includes(profile.id);
        const authenticated = !!account && account.tokenExpiresAt > now + 30_000;
        const allowed = account ? creditConsent(policy, account) : undefined;
        const reason = !enrolled ? "pool_manual_policy_changed" : !authenticated ? "pool_manual_authentication_unavailable" :
          allowed === true ? null : !account || account.validUntil <= now || account.remaining == null ? "pool_manual_quota_unavailable" :
          account.remaining <= 0 ? "pool_manual_quota_exhausted" : null;
        return { account: profile.id, label: labels.get(profile.id) ?? profile.label, available: reason === null,
          reason, creditAllowed: allowed === true, creditPolicy: allowed === undefined ? "provider" : allowed ? "allow" : "block",
          canAllowCredits: enrolled && authenticated, autoSwitchEnabled: policy.enabled,
          remaining: account?.remaining ?? null };

      }) };
  }

  configureCredits(input: unknown) {
    const value = input as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "account,allow" || typeof value.account !== "string" || typeof value.allow !== "boolean")
      throw new RequestAccountError("request_account_invalid_request", 400);
    const policy = readPoolPolicy(this.options.policyPath);
    const account = (this.options.accounts?.() ?? poolAccounts(this.config)).find(a => a.id === value.account);
    if (!this.config.accounts.codex.some(p => p.enabled && p.id === value.account) || !policy.accounts.includes(value.account))
      throw new RequestAccountError("pool_manual_policy_changed", 409);
    if (!account || account.tokenExpiresAt <= Date.now() + 30_000)
      throw new RequestAccountError("pool_manual_authentication_unavailable", 409);
    policy.creditConsent = { ...policy.creditConsent, [account.id]: { identity: account.identity, allow: value.allow } };
    savePoolPolicy(policy, this.options.policyPath);
    return { account: account.id, creditAllowed: value.allow };
  }

  async choose(input: unknown, routing: RoutingSummary, supportedSources: string[], labels: Map<string,string>) {
    const value = input as Record<string,unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "account,threadId" ||
        typeof value.threadId !== "string" || !uuid.test(value.threadId) || typeof value.account !== "string")
      throw new RequestAccountError("request_account_invalid_request",400);
    const thread = this.candidates(routing).find(t => t.threadId === value.threadId);
    if (!thread || !thread.model) throw new RequestAccountError("request_account_unknown_thread",409);
    if (routing.freshness !== "fresh" || !supportedSources.includes(thread.sourceAccount))
      throw new RequestAccountError("request_account_observer_unavailable",409);
    const target = await (this.options.setTarget ?? setManualTarget)({sourceAccount:thread.sourceAccount,
      threadId:thread.threadId, account:value.account,model:thread.model},
      {config:this.config,databasePath:this.options.databasePath,accounts:this.options.accounts,
        policy:()=>readPoolPolicy(this.options.policyPath),pendingTurnId:thread.pendingTurnId});
    return { threadId:target.threadId, account:target.account, label:labels.get(target.account) ?? target.account };
  }
}
