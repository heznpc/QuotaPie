import type { QuotaDatabase } from "../db";
import type { AccountState, QuotaEvent, QuotaObservation } from "../types";
import type { ResetSignal } from "./classify";

// Product display bounds, not calibrated probabilities or causal attribution.
export const RECOVERY_LOOKBACK_MS = 24 * 3_600_000;
export const RESET_MATCH_WINDOW_MS = 6 * 3_600_000;
export const MAX_RECOVERY_OBSERVATION_GAP_MS = 30 * 60_000;
const numeric = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export function comparisonReason(previous: QuotaObservation | undefined, next: QuotaObservation | undefined) {
  if (!previous || !next || previous.usedPercent == null || next.usedPercent == null
    || previous.observedAtMs >= next.observedAtMs) return "insufficient-evidence";
  if (previous.quality !== "authoritative" || next.quality !== "authoritative") return "insufficient-evidence";
  if (previous.source !== next.source) return "source-changed";
  if (previous.windowSeconds !== next.windowSeconds) return "window-changed";
  if (next.observedAtMs - previous.observedAtMs > MAX_RECOVERY_OBSERVATION_GAP_MS) return "observation-gap";
  return null;
}

export function recoveryEvidence(event: QuotaEvent, signals: ResetSignal[], nowMs: number) {
  const d = event.details;
  const start = numeric(d.previousObservedAtMs);
  const before = numeric(d.usedPercentBefore);
  const after = numeric(d.usedPercentAfter);
  let reason = "no-public-match";
  if (start == null || start >= event.occurredAtMs || before == null || after == null || before <= after
    || d.previousQuality !== "authoritative" || d.nextQuality !== "authoritative") reason = "insufficient-evidence";
  else if (d.previousSource !== d.nextSource) reason = "source-changed";
  else if (d.previousWindowSeconds !== d.nextWindowSeconds) reason = "window-changed";
  else if (event.occurredAtMs - start > MAX_RECOVERY_OBSERVATION_GAP_MS) reason = "observation-gap";
  else if (d.resetCreditDecreased === true) reason = "reset-credit-decreased";
  else if (event.kind === "scheduled_reset") reason = "scheduled";
  const candidates = reason === "no-public-match" && event.provider === "codex" ? signals.filter(signal => {
    // Account plan eligibility is not collected. Only an explicit universal
    // completion can be suggested; plan-specific and unknown scope stay news.
    const text = `${signal.text}\n${signal.contextText ?? ""}`;
    if (signal.state !== "reported" || signal.resetKind !== "direct"
      || !/\ball\s+(?:users|accounts|plans|subscriptions)\b|\beveryone\b/i.test(text)
      || /\b(?:paid|Plus|Pro|Business|Enterprise|Team|Free)\b/i.test(text)) return false;
    const duration = numeric(d.nextWindowSeconds);
    const weekly = /\bweekly\b/i.test(text), short = /\b(?:5|five)[ -]hour\b/i.test(text);
    if ((weekly && duration !== 604800) || (short && duration !== 18000)) return false;
    if (signal.publishedAtMs > nowMs || signal.publishedAtMs < start! - RESET_MATCH_WINDOW_MS
      || signal.publishedAtMs > event.occurredAtMs + RESET_MATCH_WINDOW_MS) return false;
    if (signal.targetAtMs != null && (signal.targetAtMs > event.occurredAtMs
      || signal.targetAtMs < start! - RESET_MATCH_WINDOW_MS)) return false;
    return !signals.some(other => other.groupId === signal.groupId && other.publishedAtMs >= signal.publishedAtMs
      && other.publishedAtMs <= nowMs && (other.state === "withdrawn" || other.state === "updated"));
  }).map(signal => ({ signalId: signal.id, author: signal.author, sourceUrl: signal.sourceUrl,
    publishedAtMs: signal.publishedAtMs, observedVia: signal.observedVia })) : [];
  if (candidates.length) reason = "time-proximity-only";
  return { eventId: event.id, observedAfterMs: start, observedByMs: event.occurredAtMs,
    remainingBefore: before == null ? null : 100 - before, remainingAfter: after == null ? null : 100 - after,
    previousResetsAtMs: numeric(d.previousResetsAtMs), nextResetsAtMs: numeric(d.nextResetsAtMs),
    reason, candidates };
}

export function buildResetTracking(db: QuotaDatabase, accounts: AccountState[], signals: ResetSignal[], nowMs: number, staleAfterMs: number) {
  return { lookbackMs: RECOVERY_LOOKBACK_MS, accounts: accounts.map(account => ({
    provider: account.provider, account: account.account,
    windows: account.windows.map(window => {
      const history = db.history(account.provider, account.account, window.bucket, 0, 2);
      const next = history.at(-1), previous = history.at(-2);
      // The collector health uses its adapter ID; historical Codex snapshots
      // use the wire-source name. These are the same source, not a fallback.
      const healthSource = next?.source === "codex-app-server" ? "codex-appserver" : next?.source;
      const reason = !next || next.observedAtMs > nowMs || nowMs - next.observedAtMs > staleAfterMs
        || !account.collection.sources.some(source => source.source === healthSource && source.health === "recent-success")
        ? "collection-unavailable" : comparisonReason(previous, next);
      const event = db.latestRecovery(account.provider, account.account, window.bucket, nowMs - RECOVERY_LOOKBACK_MS, nowMs);
      const recovery = event ? recoveryEvidence(event, signals, nowMs) : null;
      const uncertainRecovery = recovery && ["insufficient-evidence", "source-changed", "window-changed", "observation-gap"].includes(recovery.reason);
      // Historical evidence remains visible when collection fails; current
      // observation coverage and the recovery are independent dimensions.
      return { bucket: window.bucket, label: window.label,
        state: reason || uncertainRecovery ? "unavailable" : recovery ? "recovery-observed" : "no-recovery-observed",
        reason, comparedAfterMs: previous?.observedAtMs ?? null, comparedByMs: next?.observedAtMs ?? null, recovery };
    }),
  })) };
}
