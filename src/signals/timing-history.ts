import type { Provider, QuotaEvent } from "../types";
import type { ResetSignal } from "./classify";
import { endOfDayBoundary } from "./time";
import { recoveryEvidence } from "./correlation";
import { buildForecast, deadlineOf, intervalScoreBounds } from "./forecast-model";

import {resetScopeMatchesBucket, resetBucketWindow} from "./reset-event-links";
const DAY = 86_400_000;
export interface TimingForecast {
  issuedAtMs: number; earliestMs: number; latestMs: number; sampleCount: number;
  method: "eod-observed-clock-v1" | "deadline-offset-empirical-v2";
  forecastId?: string; trainingEventIds?: string[]; alpha?: number;
}
export interface ResetTimingCase {
  provider: Provider; account: string; signalId: string; author: string;
  contextAtMs?: number;
  eventId?: string; eventLinkOverride?:string; scope?: string; relatedSourceIds?: string[]; linkStatus?: "resolved" | "ambiguous";
  labelKnownAtMs?: number; labelVersion?: number;
  sourceZone?: string | null; sourceDeadlineMs?: number | null;
  negativeEvidence?: { bucket: string; detectableFromMs: number; detectableUntilMs: number; knownAtMs: number; resetEpoch: string; method: "provider-reset-epoch" };
  collectionCoverage?: { fromMs: number; untilMs: number; successful: number; failed: number; resetDetectable: boolean };
  sourceUrl: string; originalText: string; publishedAtMs: number; firstSeenAtMs: number;
  forecast: TimingForecast | null;
  observation: { afterMs: number; byMs: number; remainingBefore: number; remainingAfter: number; bucket?: string; windowSeconds?: number } | null;
  observations?: NonNullable<ResetTimingCase["observation"]>[];
  status: "pending" | "observed" | "unobserved" | "withdrawn" | "context-changed" | "non-occurrence" | "ambiguous";
}
export function isTimingAnnouncement(s: ResetSignal): boolean {
  return ["announced", "updated"].includes(s.state) && (s.benefitKind ?? "reset") === "reset" && s.resetKind !== "banked";
}
/** Compatibility presentation uses the same deadline-relative model as policy
 * queries. No UTC clock pattern is copied across civil-time/DST boundaries. */
export function timingForecast(history: ResetTimingCase[], current: ResetTimingCase, now: number): TimingForecast | null {
  const deadline=deadlineOf(current)?.targetAtMs;
  if(deadline==null || deadline<=now)return null;
  const buckets=[...new Set(history.flatMap(row=>row.observation?.bucket?[row.observation.bucket]:[]))];
  const bucket=buckets.find(b=>resetBucketWindow(b)==="weekly")??buckets[0];
  if(!bucket)return null;
  const f=buildForecast(history,current,{signalId:current.signalId,provider:current.provider,account:current.account,bucket,horizonAtMs:deadline,now});
  if(!f.conditionalInterval)return null;
  return {issuedAtMs:now,earliestMs:f.conditionalInterval.lowerMs,latestMs:f.conditionalInterval.upperMs,sampleCount:f.sampleCount,
    method:"deadline-offset-empirical-v2",forecastId:f.id,trainingEventIds:f.trainingEventIds,alpha:f.conditionalInterval.alpha};
}
export function timingObservation(event: QuotaEvent, row: ResetTimingCase) {
  if (!resetScopeMatchesBucket(row.scope??"",event.bucket) || event.provider !== row.provider || event.account !== row.account || !["external_relief", "allowance_relief"].includes(event.kind) ||
      event.occurredAtMs > Math.max(row.publishedAtMs + DAY, (deadlineOf(row)?.targetAtMs ?? row.publishedAtMs) + DAY)) return null;
  const evidence = recoveryEvidence(event, [], event.occurredAtMs);
  if (evidence.reason !== "no-public-match" || evidence.observedAfterMs == null || evidence.observedAfterMs < row.publishedAtMs ||
      evidence.remainingBefore == null || evidence.remainingAfter == null || evidence.remainingAfter < 99) return null;
  return { afterMs: evidence.observedAfterMs, byMs: evidence.observedByMs,
    remainingBefore: evidence.remainingBefore, remainingAfter: evidence.remainingAfter, bucket: event.bucket,
    windowSeconds: typeof event.details.nextWindowSeconds === "number" ? event.details.nextWindowSeconds : 0 };
}
/** These are interval errors, not a fabricated point timestamp or a probability.
 * Retrospectively imported cases are explicitly excluded from forecast scores. */
export function timingEvaluation(row: ResetTimingCase) {
  const o = row.observation, f = row.forecast;
  if (!o || !f || f.issuedAtMs >= o.afterMs) return null;
  return { scoreBounds: f.alpha ? intervalScoreBounds(f.earliestMs,f.latestMs,o.afterMs,o.byMs,f.alpha) : null, overlaps: f.earliestMs <= o.byMs && f.latestMs >= o.afterMs,
    gapMs: Math.max(0, f.earliestMs - o.byMs, o.afterMs - f.latestMs),
    leadTimeMinMs: o.afterMs - f.issuedAtMs, leadTimeMaxMs: o.byMs - f.issuedAtMs };
}
