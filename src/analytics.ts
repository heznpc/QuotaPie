import type { AppConfig, TimeRange } from "./config";
import type { ProviderStatus, QuotaObservation, WindowAnalysis } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const localPartsCache = new Map<string, { weekday: number; minutes: number }>();

function localParts(timestampMs: number, timeZone: string): { weekday: number; minutes: number } {
  const cacheKey = `${timeZone}:${Math.floor(timestampMs / 60_000)}`;
  const cached = localPartsCache.get(cacheKey);
  if (cached) return cached;
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(timestampMs));
  const weekdayName = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const result = { weekday: weekdayMap[weekdayName] ?? 1, minutes: hour * 60 + minute };
  if (localPartsCache.size >= 50_000) localPartsCache.clear();
  localPartsCache.set(cacheKey, result);
  return result;
}

function parseClock(value: string): number {
  const [hourText = "0", minuteText = "0"] = value.split(":");
  const hour = Math.min(24, Math.max(0, Number(hourText)));
  const minute = Math.min(59, Math.max(0, Number(minuteText)));
  return hour * 60 + minute;
}

function rangesForDay(weekday: number, config: AppConfig): TimeRange[] {
  return weekday === 0 || weekday === 6
    ? config.profile.workSchedule.weekend
    : config.profile.workSchedule.weekday;
}

export function isActiveTime(timestampMs: number, config: AppConfig): boolean {
  const { weekday, minutes } = localParts(timestampMs, config.profile.timeZone);
  const currentRanges = rangesForDay(weekday, config);
  for (const range of currentRanges) {
    const start = parseClock(range.start);
    const end = parseClock(range.end);
    if (start === end) return true;
    if (start < end && minutes >= start && minutes < end) return true;
    if (start > end && minutes >= start) return true;
  }

  const previousWeekday = (weekday + 6) % 7;
  for (const range of rangesForDay(previousWeekday, config)) {
    const start = parseClock(range.start);
    const end = parseClock(range.end);
    if (start > end && minutes < end) return true;
  }
  return false;
}

export function activeHoursBetween(startMs: number, endMs: number, config: AppConfig): number {
  if (endMs <= startMs) return 0;
  const stepMs = 5 * 60_000;
  let activeMs = 0;
  for (let cursor = startMs; cursor < endMs; cursor += stepMs) {
    const slice = Math.min(stepMs, endMs - cursor);
    if (isActiveTime(cursor + slice / 2, config)) activeMs += slice;
  }
  return activeMs / HOUR_MS;
}

interface BurnSample {
  rate: number;
  increase: number;
  atMs: number;
  gapMs: number;
  activeHours: number;
}

function burnSamples(history: QuotaObservation[], config: AppConfig): BurnSample[] {
  const result: BurnSample[] = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (!previous || !current || previous.usedPercent == null || current.usedPercent == null) continue;
    const gapMs = current.observedAtMs - previous.observedAtMs;
    if (gapMs < 10_000 || gapMs > 6 * HOUR_MS) continue;
    if (
      previous.resetsAtMs != null &&
      current.resetsAtMs != null &&
      Math.abs(previous.resetsAtMs - current.resetsAtMs) > 2 * 60_000
    ) {
      continue;
    }
    const increase = current.usedPercent - previous.usedPercent;
    if (increase < 0) continue;
    const activeHours = gapMs <= 5 * 60_000
      ? (isActiveTime(previous.observedAtMs + gapMs / 2, config) ? gapMs / HOUR_MS : 0)
      : activeHoursBetween(previous.observedAtMs, current.observedAtMs, config);
    if (activeHours <= 0) continue;
    const rate = increase / activeHours;
    if (Number.isFinite(rate) && rate >= 0 && rate < 500) {
      result.push({ rate, increase, atMs: current.observedAtMs, gapMs, activeHours });
    }
  }
  return result;
}

function weightedBurn(samples: BurnSample[]): number | null {
  if (!samples.length) return null;
  const activeHours = samples.reduce((sum, sample) => sum + sample.activeHours, 0);
  if (activeHours <= 0) return null;
  const increase = samples.reduce((sum, sample) => sum + sample.increase, 0);
  return increase / activeHours;
}

export function addActiveHours(
  startMs: number,
  activeHours: number,
  config: AppConfig,
  stopAtMs: number,
): number | null {
  if (activeHours <= 0) return startMs;
  const stepMs = 5 * 60_000;
  let remainingMs = activeHours * HOUR_MS;
  for (let cursor = startMs; cursor < stopAtMs; cursor += stepMs) {
    const slice = Math.min(stepMs, stopAtMs - cursor);
    if (isActiveTime(cursor + slice / 2, config)) {
      if (remainingMs <= slice) return cursor + remainingMs;
      remainingMs -= slice;
    }
  }
  return null;
}

function reserveFor(snapshot: QuotaObservation, config: AppConfig): number {
  const reserve = config.reservePercent[snapshot.provider];
  if (snapshot.windowSeconds != null && snapshot.windowSeconds <= 6 * 3_600) return reserve.short;
  if (snapshot.windowSeconds != null && snapshot.windowSeconds >= 6 * 86_400) return reserve.weekly;
  return reserve.other;
}

export function analyzeWindow(
  latest: QuotaObservation,
  history: QuotaObservation[],
  config: AppConfig,
  nowMs = Date.now(),
): WindowAnalysis {
  const ageMs = Math.max(0, nowMs - latest.observedAtMs);
  let freshness: WindowAnalysis["freshness"] = "fresh";
  if (latest.usedPercent == null || latest.resetsAtMs == null) freshness = "unknown";
  else if (nowMs >= latest.resetsAtMs) freshness = "reset_due";
  else if (ageMs > config.collection.staleAfterSeconds * 1_000) freshness = "stale";

  const samples = burnSamples(history, config);
  const recentCutoff = nowMs - config.profile.recentLookbackMinutes * 60_000;
  const recentSamples = samples.filter((sample) => sample.atMs >= recentCutoff && sample.gapMs <= 30 * 60_000);
  const recentBurn = weightedBurn(recentSamples);

  const currentLocal = localParts(nowMs, config.profile.timeZone);
  const samePeriod = samples.filter((sample) => {
    const local = localParts(sample.atMs, config.profile.timeZone);
    const sameDayType = (local.weekday === 0 || local.weekday === 6) ===
      (currentLocal.weekday === 0 || currentLocal.weekday === 6);
    const hourDistance = Math.abs(Math.floor(local.minutes / 60) - Math.floor(currentLocal.minutes / 60));
    return sameDayType && Math.min(hourDistance, 24 - hourDistance) <= 2;
  });
  const personalPool = samePeriod.length >= 3 ? samePeriod : samples;
  const personalBurn = weightedBurn(personalPool);

  let blendedBurn: number | null = null;
  if (recentBurn != null && personalBurn != null) {
    const recentWeight = config.profile.recentWeight * Math.min(1, recentSamples.length / 5);
    blendedBurn = recentBurn * recentWeight + personalBurn * (1 - recentWeight);
  } else {
    blendedBurn = recentBurn ?? personalBurn;
  }

  const reservePercent = reserveFor(latest, config);
  const remainingPercent = latest.usedPercent == null ? null : Math.max(0, 100 - latest.usedPercent);
  const safeRemaining = latest.usedPercent == null
    ? null
    : Math.max(0, 100 - reservePercent - latest.usedPercent);
  const timeToResetMs = latest.resetsAtMs == null ? null : Math.max(0, latest.resetsAtMs - nowMs);
  const activeHours = latest.resetsAtMs == null
    ? null
    : activeHoursBetween(nowMs, latest.resetsAtMs, config);
  const safePace = safeRemaining != null && activeHours != null && activeHours > 0
    ? safeRemaining / activeHours
    : null;
  const paceRatio = blendedBurn != null && safePace != null && safePace > 0
    ? blendedBurn / safePace
    : null;

  let exhaustsAtMs: number | null = null;
  let minutesBeforeReset: number | null = null;
  if (
    freshness === "fresh" &&
    safeRemaining != null &&
    blendedBurn != null &&
    blendedBurn > 0 &&
    latest.resetsAtMs != null
  ) {
    const activeHoursNeeded = safeRemaining / blendedBurn;
    exhaustsAtMs = addActiveHours(nowMs, activeHoursNeeded, config, latest.resetsAtMs);
    if (exhaustsAtMs != null) {
      minutesBeforeReset = (latest.resetsAtMs - exhaustsAtMs) / 60_000;
    }
  }

  const sampleCount = samples.length;
  const confidence: WindowAnalysis["confidence"] = blendedBurn == null
    ? "none"
    : sampleCount >= 20
      ? "high"
      : sampleCount >= 6
        ? "medium"
        : "low";

  let bottleneckScore = 0;
  if (latest.usedPercent != null) bottleneckScore += latest.usedPercent / 100;
  if (paceRatio != null && paceRatio > 1) bottleneckScore += Math.min(2, paceRatio - 1);
  if (remainingPercent != null && remainingPercent <= reservePercent) bottleneckScore += 1;
  if (freshness !== "fresh") bottleneckScore *= 0.25;

  return {
    provider: latest.provider,
    account: latest.account,
    bucket: latest.bucket,
    label: latest.label,
    windowSeconds: latest.windowSeconds,
    source: latest.source,
    quality: latest.quality,
    freshness,
    observedAtMs: latest.observedAtMs,
    usedPercent: latest.usedPercent,
    remainingPercent,
    resetsAtMs: latest.resetsAtMs,
    timeToResetMs,
    reservePercent,
    recentBurnPerHour: recentBurn,
    personalBurnPerHour: personalBurn,
    blendedBurnPerHour: blendedBurn,
    safePacePerActiveHour: safePace,
    paceRatio,
    exhaustsAtMs,
    minutesBeforeReset,
    confidence,
    sampleCount,
    activeHoursUntilReset: activeHours,
    bottleneckScore,
  };
}

export function groupStatuses(
  windows: WindowAnalysis[],
  accountLabel: (provider: ProviderStatus["provider"], account: string) => string = (_provider, account) => account,
): ProviderStatus[] {
  const providers = new Map<string, WindowAnalysis[]>();
  for (const window of windows) {
    const key = `${window.provider}\u0000${window.account}`;
    const list = providers.get(key) ?? [];
    list.push(window);
    providers.set(key, list);
  }
  return [...providers.values()].map((providerWindows) => {
    const first = providerWindows[0]!;
    const provider = first.provider;
    const account = first.account;
    const sorted = [...providerWindows].sort((a, b) => b.bottleneckScore - a.bottleneckScore);
    return {
      provider,
      account,
      accountLabel: accountLabel(provider, account),
      windows: providerWindows.sort((a, b) => (a.windowSeconds ?? 0) - (b.windowSeconds ?? 0)),
      bottleneckBucket: sorted[0]?.bucket ?? null,
      updatedAtMs: providerWindows.length
        ? Math.max(...providerWindows.map((window) => window.observedAtMs))
        : null,
    };
  });
}

export function analysisHistoryStart(config: AppConfig, nowMs = Date.now()): number {
  return nowMs - config.profile.historyDays * DAY_MS;
}
