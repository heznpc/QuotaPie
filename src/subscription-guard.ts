import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPoolPolicy, type PoolPolicy } from "./account-pool";
import { codexProfileRoot, codexUsesFileCredentials, type AppConfig } from "./config";
import { evaluateResumeGate, type ResumeGate } from "./resume-gate";
import { defaultWorkBoundaryPath, profileReference } from "./work-boundary";
import type { AccountState, WindowAnalysis } from "./types";
import { explicitAccountReserve } from "./subscription-policy";

export interface SubscriptionGuardState {
  version: 1;
  account: string | null;
  profileKey: string | null;
  ready: boolean;
  reason: string;
  checkedAtMs: number;
  windows: ResumeGate["windows"];
}
export interface SubscriptionGuard {
  intervalMs: number;
  checkIdentity(request?: { headers?: Headers }): SubscriptionGuardState;
  check(request?: { headers?: Headers; model?: string }): SubscriptionGuardState;
  observeResponse?(status: number): void;
}

/** In-memory identity and quota holds survive a handler update; never persisted. */
export interface SubscriptionGuardMemory {
  boundIdentity: string | null;
  boundAuthAtMs: number | null;
  knownCredentials: Map<string, number>;
  deniedAtMs: number | null;
}
export function subscriptionGuardMemory(): SubscriptionGuardMemory {
  return { boundIdentity: null, boundAuthAtMs: null, knownCredentials: new Map(), deniedAtMs: null };
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
// Only explicitly supported subscription models are admitted. The desktop's
// discovery cache may be absent, incomplete or replaced during refresh; it is
// neither an allowance authority nor a reason to interrupt a known model.
// Catalog entries also cannot expand this set to internal/credit-only models.
const SUBSCRIPTION_MODELS = new Set(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
function readJSON(path: string, maxBytes: number): any {
  if (statSync(path).size > maxBytes) throw new Error("guard-input-too-large");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Subscription protection is independent of account-pool routing. An unknown
 * observation is a stop, never permission to use credits or another login.
 * The cutoff follows observed quota; provider-side accounting may arrive later. */
export function createSubscriptionGuard(options: {
  codexHome: string;
  memory?: SubscriptionGuardMemory;
  sourceAccount?: string;
  config: () => AppConfig;
  boundaryPath?: string;
  poolPolicy?: () => PoolPolicy;
  now?: () => number;
  intervalMs?: number;
  minimumReserveByBucket?: Record<string, number>;
  baselineResetsAtByBucket?: Record<string, number>;
}): SubscriptionGuard {
  const now = options.now ?? Date.now;
  const hasBudget = options.minimumReserveByBucket !== undefined || options.baselineResetsAtByBucket !== undefined;
  // A one-turn budget is frozen to the reviewed windows, including their reset
  // periods. A new period/bucket has no comparable consumption baseline.
  // This remains an observed cutoff: accounting delay can overshoot the budget.
  const minimumReserves = { ...options.minimumReserveByBucket };
  const baselineResets = { ...options.baselineResetsAtByBucket };
  const budgetKeys = Object.keys(minimumReserves);
  const validBudget = !hasBudget || options.minimumReserveByBucket != null && options.baselineResetsAtByBucket != null &&
    !Array.isArray(options.minimumReserveByBucket) && !Array.isArray(options.baselineResetsAtByBucket) &&
    budgetKeys.length > 0 && budgetKeys.length === Object.keys(baselineResets).length &&
    budgetKeys.every(key => /^[a-zA-Z0-9:_-]{1,160}$/.test(key) &&
      Object.hasOwn(baselineResets, key) && Number.isFinite(minimumReserves[key]) && minimumReserves[key]! >= 0 && minimumReserves[key]! <= 100 &&
      Number.isFinite(baselineResets[key]) && baselineResets[key]! > 0);
  let root: string | null = null;
  try { root = realpathSync(options.codexHome); } catch { /* Fail closed below. */ }
  const profileKey = root ? profileReference(root) : null;
  // A login replacement requires a new relay generation. Token refresh for
  // the same subject and workspace does not change this identity.
  const memory = options.memory ?? subscriptionGuardMemory();
  const knownCredentials = memory.knownCredentials;
  function checkState(request: { headers?: Headers; model?: string } = {}, identityOnly = false): SubscriptionGuardState {
    const at = now();
    const state: SubscriptionGuardState = { version: 1, account: options.sourceAccount ?? null,
      profileKey, ready: false, reason: "account-unavailable", checkedAtMs: at, windows: [] };
    const hold = (reason: string) => ({ ...state, ready: false, reason });
    if (!identityOnly && !validBudget) return hold("budget-baseline-invalid");
    if (!root || !profileKey || !options.sourceAccount) return state;
    try {
      const config = options.config();
      const profile = config.accounts.codex.find(p => p.enabled && p.id === options.sourceAccount);
      if (!profile || realpathSync(codexProfileRoot(profile)) !== root || !codexUsesFileCredentials(profile)) return state;
      const authPath = join(root, "auth.json"), stamp = statSync(authPath);
      const auth = readJSON(authPath, 262144);
      const token = auth.tokens?.access_token, upstreamAccount = auth.tokens?.account_id;
      if (auth.OPENAI_API_KEY || auth.auth_mode && auth.auth_mode !== "chatgpt" ||
          typeof token !== "string" || typeof upstreamAccount !== "string" || !upstreamAccount || /[\r\n]/.test(token + upstreamAccount))
        return hold("subscription-auth-required");
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) ||
          !identityOnly && claims.exp * 1000 <= at + 30000)
        return hold("subscription-auth-unavailable");
      const identity = digest(JSON.stringify([root, upstreamAccount, claims.sub])).toString("hex");
      if (memory.boundIdentity && memory.boundIdentity !== identity) return hold("account-identity-changed");
      memory.boundIdentity ??= identity;
      memory.boundAuthAtMs ??= stamp.mtimeMs;
      // Accept an earlier still-valid token only if this relay actually read
      // it from the same local login. Self-asserted JWT claims are not proof.
      for (const [key, expires] of knownCredentials) if (expires <= at) knownCredentials.delete(key);
      knownCredentials.set(digest(`Bearer ${token}`).toString("hex"), claims.exp * 1000);
      while (knownCredentials.size > 8) knownCredentials.delete(knownCredentials.keys().next().value!);
      if (request.headers) {
        const authorization = request.headers.get("authorization") ?? "";
        const remembered = knownCredentials.get(digest(authorization).toString("hex"));
        if ((!equal(authorization, `Bearer ${token}`) && !(remembered != null && remembered > at)) ||
            request.headers.get("chatgpt-account-id") !== upstreamAccount) return hold("request-identity-mismatch");
      }
      // Metadata is needed to initialize the collector that refreshes quota.
      // Keep its source identity fixed, but let the provider handle token expiry
      // so an expired/stale allowance cannot block its own recovery path.
      if (identityOnly) return { ...state, ready: true, reason: "ready" };
      if (request.model !== undefined && !SUBSCRIPTION_MODELS.has(request.model))
        return hold("model-unverified");
      const boundary = readJSON(options.boundaryPath ?? defaultWorkBoundaryPath(), 16 * 1024 * 1024);
      if (boundary?.schemaVersion !== 1 || !Number.isFinite(boundary.generatedAtMs) || boundary.generatedAtMs > at ||
          !Number.isFinite(boundary.expiresAtMs) || boundary.expiresAtMs <= at || !Array.isArray(boundary.accounts))
        return hold("quota-stale");
      const rows = boundary.accounts.filter((a: any) => a?.provider === "codex" && a.account === options.sourceAccount);
      if (rows.length !== 1 || rows[0].profileKey !== profileKey) return hold("profile-mismatch");
      const row = rows[0];
      if (!Array.isArray(row.windows) || !row.windows.length) return hold("quota-unknown");
      if (row.collectionState !== "recent-success" && !(row.collectionState === "attempted-then-failed" &&
          ["network", "provider-error"].includes(row.collectionErrorCategory))) return hold("collection-unavailable");
      // General limits apply to every subscription model. A named model limit
      // applies only to that model, never to unrelated models or features.
      const relevant = row.windows.filter((w: any) => typeof w.bucket === "string" &&
        (w.bucket.startsWith("codex:") || request.model != null && w.bucket.startsWith(request.model + ":")));
      if (hasBudget && (relevant.length !== budgetKeys.length || relevant.some((w: any) =>
          !Object.hasOwn(baselineResets, w.bucket) || w.resetsAtMs !== baselineResets[w.bucket])))
        return hold("budget-baseline-changed");
      const poolReserve = explicitAccountReserve(options.sourceAccount, (options.poolPolicy ?? readPoolPolicy)());
      const windows: WindowAnalysis[] = relevant.map((w: any): WindowAnalysis => {
        return { provider: "codex", account: options.sourceAccount!, bucket: w.bucket,
          quality: w.quality, freshness: w.freshness, observedAtMs: w.observedAtMs,
          remainingPercent: w.remainingPercent, resetsAtMs: w.resetsAtMs,
          reservePercent: Math.max(poolReserve,
            Object.hasOwn(minimumReserves, w.bucket) ? minimumReserves[w.bucket]! : 0) } as WindowAnalysis;
      });
      // A failed refresh is not evidence that a still-valid successful quota
      // observation was revoked. The gate below checks every timestamp/value.
      const account = { provider: "codex", account: options.sourceAccount, enabled: true,
        collection: { health: "recent-success", errorCategory: null }, windows } as AccountState;
      const maxAge = config.collection.staleAfterSeconds * 1000;
      let gate = evaluateResumeGate(account, "codex", options.sourceAccount, at, maxAge);
      state.windows = windows.map(w => ({ bucket: w.bucket, remainingPercent: w.remainingPercent,
        reservePercent: w.reservePercent, observedAtMs: w.observedAtMs, resetsAtMs: w.resetsAtMs }));
      if (!gate.ready) return hold(gate.reason === "reserve-reached" &&
        windows.some(w => w.remainingPercent === 0) ? "quota-exhausted" : gate.reason);
      // Apply a named limit only when it belongs to this request's model.
      for (const w of windows.filter(w => !w.bucket.startsWith("codex:"))) {
        gate = evaluateResumeGate(account, "codex", options.sourceAccount, at, maxAge, w.bucket);
        if (!gate.ready) return hold(gate.reason === "reserve-reached" &&
          w.remainingPercent === 0 ? "quota-exhausted" : gate.reason);
      }
      if (new Set(windows.map(w => w.bucket)).size !== windows.length) return hold("quota-unknown");
      if (relevant.some((w: any) => !Number.isFinite(w.validUntilMs) || w.validUntilMs <= at ||
          !Number.isFinite(w.observedAtMs) || w.observedAtMs < memory.boundAuthAtMs!)) return hold("quota-stale");
      if (memory.deniedAtMs != null && windows.some(w => w.observedAtMs <= memory.deniedAtMs!)) return hold("upstream-quota-hold");
      return { ...state, ready: true, reason: "ready" };
    } catch { return hold("guard-unavailable"); }
  }
  const guard: SubscriptionGuard = {
    intervalMs: Math.min(1000, Math.max(10, options.intervalMs ?? 500)),
    observeResponse(status) { if (status === 429 || status === 402) memory.deniedAtMs = now(); },
    checkIdentity(request = {}) { return checkState(request, true); },
    check(request = {}) { return checkState(request); },
  };
  // Bind before the first request, not to credentials supplied by that request.
  guard.check();
  return guard;
}
