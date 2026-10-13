import type { Provider, QuotaEvent } from "../types";
import type { ResetSignal } from "./classify";
import { endOfDayBoundary } from "./time";
import { recoveryEvidence } from "./correlation";

const DAY = 86_400_000;
export interface TimingForecast {
  issuedAtMs: number; earliestMs: number; latestMs: number; sampleCount: number;
  method: "eod-observed-clock-v1";
}
export interface ResetTimingCase {
  provider: Provider; account: string; signalId: string; author: string;
  contextAtMs?: number;
  sourceUrl: string; originalText: string; publishedAtMs: number; firstSeenAtMs: number;
  forecast: TimingForecast | null;
  observation: { afterMs: number; byMs: number; remainingBefore: number; remainingAfter: number; bucket?: string; windowSeconds?: number } | null;
  status: "pending" | "observed" | "unobserved" | "withdrawn" | "context-changed";
}
export function isTimingAnnouncement(s: ResetSignal): boolean {
  const text = s.change?.evidence ?? s.timeHint ?? s.text;
  return s.state === "announced" && (s.benefitKind ?? "reset") === "reset" && s.resetKind !== "banked" &&
    /\bEOD\b|end of (?:the )?day/i.test(text) &&
    /\bglobal\b|\beveryone\b|\ball\s+(?:users|accounts|plans|subscriptions)\b/i.test(text) &&
    !/\b(?:Plus|Pro|Business|Enterprise|Team|Free|students?)\b/i.test(text);
}
/** One day counts once, regardless of duplicate posts or limit windows. Only
 * observations already known at issue time can train a prospective estimate. */
export function timingForecast(history: ResetTimingCase[], current: ResetTimingCase, now: number): TimingForecast | null {
  const day = Math.floor(current.publishedAtMs / DAY) * DAY;
  const targetDay = Math.floor((endOfDayBoundary(current.originalText, current.publishedAtMs)?.targetAtMs ?? current.publishedAtMs) / DAY) * DAY;
  const samples = new Map<number, { low: number; high: number }>();
  for (const row of history) {
    const oldDay = Math.floor(row.publishedAtMs / DAY) * DAY;
    if ((row.contextAtMs ?? 0) !== (current.contextAtMs ?? 0) || row.provider !== current.provider || row.account !== current.account || row.author.toLowerCase() !== current.author.toLowerCase() ||
        row.status !== "observed" || !row.observation || row.observation.byMs >= now || oldDay >= day || now - oldDay > 90 * DAY) continue;
    // Clock pattern is an empirical UTC interval, not an inferred author timezone.
    const recoveryDay = Math.floor(row.observation.byMs / DAY) * DAY;
    const old = samples.get(recoveryDay);
    const low = row.observation.afterMs - recoveryDay, high = row.observation.byMs - recoveryDay;
    samples.set(recoveryDay, { low: Math.min(old?.low ?? low, low), high: Math.max(old?.high ?? high, high) });
  }
  if (samples.size < 2) return null;
  return { issuedAtMs: now, earliestMs: targetDay + Math.min(...[...samples.values()].map(s => s.low)),
    latestMs: targetDay + Math.max(...[...samples.values()].map(s => s.high)), sampleCount: samples.size,
    method: "eod-observed-clock-v1" };
}
export function timingObservation(event: QuotaEvent, row: ResetTimingCase) {
  if (event.provider !== row.provider || event.account !== row.account || !["external_relief", "allowance_relief"].includes(event.kind) ||
      event.occurredAtMs > row.publishedAtMs + DAY) return null;
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
  return { overlaps: f.earliestMs <= o.byMs && f.latestMs >= o.afterMs,
    gapMs: Math.max(0, f.earliestMs - o.byMs, o.afterMs - f.latestMs),
    leadTimeMinMs: o.afterMs - f.issuedAtMs, leadTimeMaxMs: o.byMs - f.issuedAtMs };
}
