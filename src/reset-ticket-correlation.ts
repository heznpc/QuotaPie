import type { QuotaObservation } from "./types";

const MAX_REFLECTION_DELAY_MS = 10 * 60_000;

// Persist the correlation with the accepted snapshot, so a provider's delayed
// quota update survives polls and collector process restarts. Authentication
// epoch/context changes deliberately clear it.
export function correlateResetTicket(
  previous: QuotaObservation | undefined,
  next: QuotaObservation,
  ticketDecreased: boolean,
  ticketCount: number | null | undefined,
  sameContext: boolean,
  resetToleranceMs: number,
): QuotaObservation {
  const metadata = { ...next.metadata, resetTicketPending: false, resetTicketRecovery: false };
  if (!sameContext || !previous || previous.provider !== next.provider || previous.account !== next.account ||
      previous.bucket !== next.bucket || next.quality !== "authoritative" || previous.quality !== "authoritative" ||
      previous.source !== next.source || next.observedAtMs <= previous.observedAtMs ||
      previous.resetsAtMs == null || previous.usedPercent == null || previous.usedPercent < 99 ||
      next.observedAtMs >= previous.resetsAtMs - resetToleranceMs) return { ...next, metadata };
  const pendingAt = ticketDecreased ? next.observedAtMs : previous.metadata?.resetTicketObservedAtMs;
  const pendingCount = ticketDecreased ? ticketCount : previous.metadata?.resetTicketCountAfter;
  const eligible = ticketDecreased || previous.metadata?.resetTicketPending === true;
  if (!eligible || typeof pendingAt !== "number" || typeof pendingCount !== "number" ||
      ticketCount !== pendingCount || next.observedAtMs - pendingAt > MAX_REFLECTION_DELAY_MS ||
      next.observedAtMs < pendingAt || previous.windowSeconds !== next.windowSeconds) return { ...next, metadata };
  // A near-zero drop plus the provider's advanced reset clock distinguishes a
  // reset application from an ordinary meter correction or allowance increase.
  const recovered = next.usedPercent != null && next.usedPercent <= 1 && next.usedPercent < previous.usedPercent &&
    next.resetsAtMs != null && next.resetsAtMs > previous.resetsAtMs;
  return { ...next, metadata: { ...metadata,
    resetTicketPending: !recovered,
    resetTicketRecovery: recovered && !ticketDecreased,
    resetTicketObservedAtMs: pendingAt,
    resetTicketCountAfter: pendingCount,
  } };
}

/** Brief, account-local read burst; never spend another ticket or run inference. */
export function resetTicketFollowupDelay(observations: readonly QuotaObservation[], nowMs: number): number | null {
  const ages = observations.filter(o => o.metadata?.resetTicketPending === true)
    .map(o => typeof o.metadata?.resetTicketObservedAtMs === "number" ? nowMs - o.metadata.resetTicketObservedAtMs : -1)
    .filter(age => age >= 0 && age < 90_000);
  if (!ages.length) return null;
  return Math.min(...ages) < 30_000 ? 2_000 : 10_000;
}
