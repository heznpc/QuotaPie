import type { AccountState, QuotaObservation } from "./types";
import type { QuotaDatabase } from "./db";

const HOUR = 3_600_000;
const balance = (row: QuotaObservation | undefined) => row?.quality === "authoritative" &&
  typeof row.creditBalance === "number" && Number.isFinite(row.creditBalance) && row.creditBalance >= 0
  ? row.creditBalance : null;

export interface CreditUsage {
  unit: "credits"; balance: number | null; observedAtMs: number | null;
  freshness: "fresh" | "stale" | "unknown"; subscriptionExhausted: boolean; spendingObserved: boolean;
  lastHour: { fromMs: number; toMs: number; observedDecrease: number | null; observedIncrease: number | null;
    coveredMs: number; sampleCount: number; gapCount: number; identityBreakCount: number;
    coverage: "complete" | "partial" | "unknown" };
  attribution: "account-balance-only"; billingVerified: false;
}

/** A credit balance is carried once per account reading. Prefer the canonical
 * Codex lane, and never sum overlapping quota buckets or conflicting balances. */
function canonical(rows: QuotaObservation[]): QuotaObservation | undefined {
  const primary = rows.filter(row => row.metadata?.limitId === "codex" && row.metadata?.lane === "primary");
  const candidates = primary.length ? primary : rows.filter(row => row.creditBalance != null);
  if (!candidates.length) return rows[0] ? { ...rows[0], creditBalance: null } : undefined;
  const first = candidates[0]!;
  return candidates.every(row => balance(row) === balance(first) && row.source === first.source)
    ? first : { ...first, creditBalance: null };
}

function continuity(row: Pick<QuotaObservation, "metadata" | "source" | "quality">): string | null {
  const m = row.metadata;
  // These random collector markers establish continuity without exposing login
  // identifiers. Anonymous legacy readings cannot establish an account delta.
  if (![m?.collectorEpoch, m?.accountContext, m?.contextSession].every(value => typeof value === "string" && value.length > 0)) return null;
  return JSON.stringify([m!.collectorEpoch, m!.accountContext, m!.contextSession, m?.planType ?? null, row.source, row.quality]);
}

export function projectCreditUsage(account: AccountState, observations: QuotaObservation[], nowMs: number,
  staleAfterMs: number, maximumGapMs: number): CreditUsage {
  const fromMs = nowMs - HOUR;
  const grouped = new Map<number, QuotaObservation[]>();
  for (const row of observations) if (row.provider === "codex" && row.account === account.account && row.observedAtMs <= nowMs) {
    const group = grouped.get(row.observedAtMs) ?? []; group.push(row); grouped.set(row.observedAtMs, group);
  }
  const readings = [...grouped].sort(([a], [b]) => a - b).flatMap(([, rows]) => canonical(rows) ?? []);
  const latest = readings.at(-1);
  const newestWindowAtMs = Math.max(...account.windows.map(window => window.observedAtMs));
  const currentWindow = account.windows.find(window => window.observedAtMs === newestWindowAtMs && continuity(window) !== null);
  const identityUnavailable = ["account-mismatch", "auth-required", "auth-expired", "isolation-unsafe"].includes(account.collection.errorCategory ?? "") ||
    !!currentWindow && !!latest && continuity(currentWindow) !== continuity(latest);
  const currentBalance = identityUnavailable || !account.enabled ? null : balance(latest);
  const fresh = !!latest && nowMs - latest.observedAtMs <= staleAfterMs && account.collection.health === "recent-success";
  const freshness = currentBalance === null ? "unknown" : fresh ? "fresh" : "stale";
  let decrease = 0, increase = 0, coveredMs = 0, pairs = 0, gapCount = 0, identityBreakCount = 0;
  let firstComparableAtMs: number | null = null, lastComparableAtMs: number | null = null;
  const samples = readings.filter(row => row.observedAtMs >= fromMs);
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]!, next = samples[index]!;
    const before = balance(previous), after = balance(next), context = continuity(previous);
    if (context === null || context !== continuity(next)) {
      identityBreakCount++;
      // Only the latest verified login context contributes to the displayed
      // amount; the same configured profile may have signed into another login.
      decrease = increase = coveredMs = pairs = 0; firstComparableAtMs = lastComparableAtMs = null;
      continue;
    }
    const elapsed = next.observedAtMs - previous.observedAtMs;
    if (before === null || after === null || elapsed > maximumGapMs) { gapCount++; continue; }
    coveredMs += elapsed; pairs++;
    firstComparableAtMs ??= previous.observedAtMs; lastComparableAtMs = next.observedAtMs;
    const delta = before - after;
    if (delta > 0.000_001) decrease += delta;
    else if (delta < -0.000_001) increase -= delta;
  }
  const subscriptionExhausted = account.windows.some(window => window.freshness === "fresh" &&
    (window.metadata?.limitId === "codex" || /^codex:(primary|secondary):/.test(window.bucket)) && window.remainingPercent === 0);
  return { unit: "credits", balance: currentBalance, observedAtMs: latest?.observedAtMs ?? null, freshness,
    subscriptionExhausted, spendingObserved: freshness === "fresh" && subscriptionExhausted && pairs > 0 && decrease > 0,
    lastHour: { fromMs, toMs: nowMs, observedDecrease: pairs && !identityUnavailable ? decrease : null, observedIncrease: pairs && !identityUnavailable ? increase : null,
      coveredMs, sampleCount: samples.filter(row => balance(row) !== null).length, gapCount, identityBreakCount,
      coverage: !pairs || identityUnavailable ? "unknown" : !gapCount && !identityBreakCount && freshness === "fresh" &&
        firstComparableAtMs! - fromMs <= maximumGapMs && nowMs - lastComparableAtMs! <= maximumGapMs ? "complete" : "partial" },
    attribution: "account-balance-only", billingVerified: false };
}

/** No network reads, no collection triggers, and no writes on the quota path. */
export class CreditUsageReader {
  private cached = new Map<string, { checkedAtMs: number; revision: string; readings: QuotaObservation[] }>();
  constructor(private db: QuotaDatabase) {}
  accounts(accounts: AccountState[], nowMs: number, staleAfterMs: number, maximumGapMs: number) {
    let latest: QuotaObservation[] | undefined;
    return accounts.map(account => {
      if (account.provider !== "codex") return account;
      // A collection/login change invalidates immediately, including two
      // different identity contexts observed at the same timestamp. These
      // opaque markers remain inside the reader and never enter the payload.
      const revision = JSON.stringify([account.updatedAtMs, account.collection.lastSuccessAtMs, account.collection.activeSource,
        account.windows.map(window => [window.bucket, window.observedAtMs, window.source, window.quality,
          window.metadata?.collectorEpoch, window.metadata?.accountContext, window.metadata?.contextSession, window.metadata?.planType])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
      let entry = this.cached.get(account.account);
      if (!entry || entry.revision !== revision || nowMs < entry.checkedAtMs || nowMs - entry.checkedAtMs >= 5_000) {
        latest ??= this.db.latestAll();
        entry = { checkedAtMs: nowMs, revision, readings: [...this.db.creditHistory(account.account, nowMs - HOUR),
          ...latest.filter(row => row.provider === "codex" && row.account === account.account)] };
        this.cached.set(account.account, entry);
      }
      return { ...account, credits: projectCreditUsage(account, entry.readings, nowMs, staleAfterMs, maximumGapMs) };
    });
  }
}
