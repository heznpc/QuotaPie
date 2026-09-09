import type { QuotaEvent } from "../types";
import type { ResetSignal } from "./classify";

// Time proximity is a search aid, NOT attribution or proof of eligibility.
export const RESET_MATCH_WINDOW_MS = 6 * 3_600_000;
export const MAX_RECOVERY_OBSERVATION_GAP_MS = 30 * 60_000;
export type CorrelationReason = "time-proximity-only" | "no-public-match" | "scheduled"
  | "reset-credit-decreased" | "insufficient-evidence" | "source-changed" | "observation-gap";

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function correlateRecoveries(events: QuotaEvent[], signals: ResetSignal[], nowMs: number) {
  return events.filter(event => ["scheduled_reset", "external_relief", "allowance_relief"].includes(event.kind)
    && event.occurredAtMs <= nowMs).map(event => {
    const d = event.details;
    const start = numeric(d.previousObservedAtMs);
    const before = numeric(d.usedPercentBefore);
    const after = numeric(d.usedPercentAfter);
    let reason: CorrelationReason = "no-public-match";
    if (start == null || start >= event.occurredAtMs || before == null || after == null || before <= after
      || d.previousQuality !== "authoritative" || d.nextQuality !== "authoritative") reason = "insufficient-evidence";
    else if (d.previousSource !== d.nextSource) reason = "source-changed";
    else if (event.occurredAtMs - start > MAX_RECOVERY_OBSERVATION_GAP_MS) reason = "observation-gap";
    else if (d.resetCreditDecreased === true) reason = "reset-credit-decreased";
    else if (event.kind === "scheduled_reset") reason = "scheduled";

    const candidates = reason === "no-public-match" && event.provider === "codex" ? signals.filter(signal =>
      (signal.state === "announced" || signal.state === "reported") && signal.resetKind !== "banked"
      && signal.publishedAtMs <= nowMs
      && signal.publishedAtMs >= start! - RESET_MATCH_WINDOW_MS
      && signal.publishedAtMs <= event.occurredAtMs + RESET_MATCH_WINDOW_MS
      && !signals.some(other => other.groupId === signal.groupId && other.publishedAtMs >= signal.publishedAtMs
        && other.publishedAtMs <= nowMs
        && (other.state === "withdrawn" || other.state === "updated"))
    ).map(signal => ({
      signalId: signal.id, groupId: signal.groupId, state: signal.state,
      sourceUrl: signal.sourceUrl, publishedAtMs: signal.publishedAtMs,
      observedVia: signal.observedVia,
      relation: "candidate" as const,
      publicationAfterObservation: signal.publishedAtMs > event.occurredAtMs,
    })) : [];
    if (candidates.length) reason = "time-proximity-only";
    return {
      eventId: event.id ?? null, provider: event.provider, account: event.account, bucket: event.bucket,
      kind: event.kind, observedBetween: { afterMs: start, byMs: event.occurredAtMs },
      remainingBefore: before == null ? null : 100 - before,
      remainingAfter: after == null ? null : 100 - after,
      previousResetsAtMs: numeric(d.previousResetsAtMs), nextResetsAtMs: numeric(d.nextResetsAtMs),
      reason, candidates,
    };
  });
}
