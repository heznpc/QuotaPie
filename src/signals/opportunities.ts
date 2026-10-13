import type { Provider, QuotaEvent } from "../types";
import type { ResetSignal } from "./classify";
import { endOfDayBoundary } from "./time";
import { recoveryEvidence } from "./correlation";

export interface ResetOpportunity {
  signalId: string; provider: Provider; publishedAtMs: number; sourceUrl: string;
  actionableFromMs: number; expiresAtMs: number;
  calendarBoundaryMs: number | null;
  forecast: null | { earliestMs: number; latestMs: number; sampleCount: number; basis: "observed-recovery-proximity" };
}
const DAY = 86400000;
const textOf = (s: ResetSignal) => s.change?.evidence ?? s.timeHint ?? s.text;
const reset = (s: ResetSignal) => (s.benefitKind ?? "reset") === "reset" && s.resetKind !== "banked";
// Scope is deliberately explicit. A targeted promotion is not a global reset.
const universal = (s: ResetSignal) => /\bglobal\b|\bsystem.wide\b|\beveryone\b|\ball\s+(?:users|accounts|plans|subscriptions)\b/i.test(textOf(s)) &&
  !/\b(?:paid|Plus|Pro|Business|Enterprise|Team|Free|students?)\b/i.test(textOf(s));

/** Announcements create urgency, not allowance. Forecasts retain observation
 * intervals and require independent days; they never prove causal attribution. */
export function resetOpportunities(signals: ResetSignal[], events: QuotaEvent[], provider: Provider, account: string, now: number): ResetOpportunity[] {
  const known = signals.filter(s => (s.provider ?? "codex") === provider && s.publishedAtMs <= now && reset(s));
  const observed = events.filter(event => event.provider === provider && event.account === account &&
    ["external_relief", "allowance_relief"].includes(event.kind) && event.occurredAtMs <= now &&
    Number(event.details.usedPercentAfter) <= 1 &&
    recoveryEvidence(event, [], now).reason === "no-public-match");
  const announcements = known.filter(s => s.state === "announced" && universal(s));
  return announcements.filter(s => now - s.publishedAtMs < DAY && !resetSignalClosed(s, known, observed, now)).map(s => {
    const boundary = endOfDayBoundary(textOf(s), s.publishedAtMs);
    const samples = new Map<number, { low: number; high: number }>();
    const eod = /\bEOD\b|end of (?:the )?day/i;
    // UTC day anchors compare observed clock patterns without inventing the
    // missing timezone in an older announcement. Original timezone stays intact.
    const anchorDay = Math.floor(s.publishedAtMs / DAY) * DAY;
    if (eod.test(textOf(s))) for (const old of announcements) {
      const oldDay = Math.floor(old.publishedAtMs / DAY) * DAY;
      if (!eod.test(textOf(old)) || old.author.toLowerCase() !== s.author.toLowerCase() ||
          oldDay >= anchorDay || s.publishedAtMs - old.publishedAtMs > 30 * DAY) continue;
      for (const event of observed) {
        if (event.occurredAtMs > s.publishedAtMs || event.occurredAtMs < old.publishedAtMs || event.occurredAtMs > old.publishedAtMs + DAY) continue;
        const evidence = recoveryEvidence(event, [], now);
        if (evidence.reason !== "no-public-match" || evidence.observedAfterMs == null) continue;
        const recoveryDay = Math.floor(evidence.observedByMs / DAY) * DAY;
        const low = evidence.observedAfterMs - recoveryDay, high = evidence.observedByMs - recoveryDay;
        const prior = samples.get(oldDay);
        samples.set(oldDay, { low: Math.min(prior?.low ?? low, low), high: Math.max(prior?.high ?? high, high) });
      }
    }
    const ranges = [...samples.values()];
    const forecast = ranges.length >= 2 ? {
      earliestMs: (boundary ? Math.floor(boundary.targetAtMs / DAY) * DAY : anchorDay) + Math.min(...ranges.map(v => v.low)),
      latestMs: (boundary ? Math.floor(boundary.targetAtMs / DAY) * DAY : anchorDay) + Math.max(...ranges.map(v => v.high)),
      sampleCount: ranges.length, basis: "observed-recovery-proximity" as const,
    } : null;
    return { signalId: s.id, provider, publishedAtMs: s.publishedAtMs, sourceUrl: s.sourceUrl,
      // Start when announced. Waiting until a guessed deadline wastes usable quota.
      actionableFromMs: s.publishedAtMs, expiresAtMs: s.publishedAtMs + DAY,
      calendarBoundaryMs: boundary?.targetAtMs ?? null, forecast };
  });
}

/** Account observation and public completion are separate from calendar expiry. */
export function resetSignalClosed(s: ResetSignal, signals: ResetSignal[], events: QuotaEvent[], now: number): boolean {
  return events.some(event => event.provider === (s.provider ?? "codex") &&
    ["external_relief", "allowance_relief"].includes(event.kind) && event.occurredAtMs <= now &&
    Number(event.details.usedPercentAfter) <= 1 && recoveryEvidence(event, [], now).reason === "no-public-match" &&
    event.occurredAtMs >= s.publishedAtMs && event.occurredAtMs < s.publishedAtMs + DAY) || signals.some(other =>
    reset(other) && (other.provider ?? "codex") === (s.provider ?? "codex") &&
    other.publishedAtMs <= now && other.publishedAtMs >= s.publishedAtMs && other.publishedAtMs < s.publishedAtMs + DAY && other.id !== s.id &&
    (other.groupId === s.groupId || other.author.toLowerCase() === s.author.toLowerCase() && (universal(other) || other.state === "reported")) &&
    ["reported", "withdrawn", "updated"].includes(other.state));
}
