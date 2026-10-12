import { describe, expect, test } from "bun:test";
import { compactClaudeLine } from "../src/format";
import { analyzeWindow, groupStatuses } from "../src/analytics";
import { DEFAULT_CONFIG } from "../src/config";
import type { QuotaObservation } from "../src/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function point(atMinutes: number, usedPercent: number, resetAtMs = 5 * HOUR): QuotaObservation {
  return {
    provider: "claude",
    account: "default",
    bucket: "five_hour",
    label: "Claude 5h",
    windowSeconds: 5 * 3_600,
    usedPercent,
    resetsAtMs: resetAtMs,
    observedAtMs: atMinutes * MINUTE,
    source: "claude-statusline",
    quality: "authoritative",
  };
}

describe("personal burn analysis", () => {
  test("learns burn rate without counting resets as negative usage", () => {
    const history = [point(0, 10), point(15, 15), point(30, 20), point(45, 25), point(60, 30), point(75, 35)];
    const analysis = analyzeWindow(history.at(-1)!, history, DEFAULT_CONFIG, 75 * MINUTE);
    expect(analysis.recentBurnPerHour).toBeCloseTo(20, 3);
    expect(analysis.blendedBurnPerHour).toBeCloseTo(20, 3);
    expect(analysis.exhaustsAtMs).not.toBeNull();
    expect(analysis.confidence).toBe("low");
  });

  test("includes unchanged quantized samples instead of overstating burn", () => {
    const history = [point(0, 10), point(5, 10), point(10, 11), point(15, 11), point(20, 12)];
    const analysis = analyzeWindow(history.at(-1)!, history, DEFAULT_CONFIG, 20 * MINUTE);
    expect(analysis.recentBurnPerHour).toBeCloseTo(6, 3);
  });

  test("reserve forecasts use the usable budget while exhaustion keeps the full allowance", () => {
    const history = [point(0, 20, 4 * HOUR), point(30, 30, 4 * HOUR)];
    const analysis = analyzeWindow(history[1]!, history, DEFAULT_CONFIG, 30 * MINUTE);
    // 70% remains, but only 60% may be spent before the saved 10% reserve.
    // Full exhaustion coincides with reset, so it is not an early shortfall.
    expect(analysis.recentBurnPerHour).toBe(20);
    expect(analysis.exhaustsAtMs).toBeNull();
    expect(analysis.minutesBeforeReset).toBeNull();
    expect(analysis.reserveReachesAtMs).toBe(3.5 * HOUR);
    expect(analysis.reserveMinutesBeforeReset).toBe(30);
    expect(analysis.riskLevel).toBe("watch");
  });

  test("an already reached reserve forecasts now without changing exhaustion", () => {
    const history = [point(0, 85), point(30, 92)];
    const analysis = analyzeWindow(history[1]!, history, DEFAULT_CONFIG, 30 * MINUTE);
    expect(analysis.reserveReachesAtMs).toBe(30 * MINUTE);
    expect(analysis.reserveMinutesBeforeReset).toBe(270);
    expect(analysis.exhaustsAtMs).toBeGreaterThan(30 * MINUTE);
  });

  test("frequent polling cannot turn three minutes of consumption into high confidence", () => {
    const history = Array.from({ length: 21 }, (_, index) => ({ ...point(0, 10 + index), observedAtMs: index * 10_000 }));
    const analysis = analyzeWindow(history[20]!, history, DEFAULT_CONFIG, 200_000);
    expect(analysis.sampleCount).toBe(20);
    expect(analysis.recentBurnPerHour).toBeCloseTo(360);
    expect(analysis.confidence).toBe("low");
  });

  test("a single quantized jump after idle polls does not establish a repeated pattern", () => {
    const history = Array.from({ length: 25 }, (_, index) => point(index * 5, index === 24 ? 30 : 10));
    const analysis = analyzeWindow(history[24]!, history, DEFAULT_CONFIG, 2 * HOUR);
    expect(analysis.sampleCount).toBe(24);
    expect(analysis.recentBurnPerHour).toBeCloseTo(10);
    expect(analysis.confidence).toBe("low");
  });

  test("confidence increases with elapsed time and repeated consumption evidence", () => {
    const halfHour = Array.from({ length: 7 }, (_, index) => point(index * 5, 10 + index));
    expect(analyzeWindow(halfHour[6]!, halfHour, DEFAULT_CONFIG, 30 * MINUTE).confidence).toBe("medium");
    const twoHours = Array.from({ length: 121 }, (_, index) => point(index, 10 + index / 10));
    expect(analyzeWindow(twoHours[120]!, twoHours, DEFAULT_CONFIG, 2 * HOUR).confidence).toBe("high");
  });

  test("old samples cannot confer high confidence on a new short burst", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.profile.recentLookbackMinutes = 10;
    const history = Array.from({ length: 25 }, (_, index) => point(index * 5, 10 + index));
    history.push(point(120 + 1 / 6, 35));
    const analysis = analyzeWindow(history.at(-1)!, history, config, 120 * MINUTE + 10_000);
    expect(analysis.sampleCount).toBe(25);
    expect(analysis.recentBurnPerHour).toBeGreaterThan(12);
    expect(analysis.confidence).toBe("low");
  });

  test("does not invent a recharge after reset time passes", () => {
    const history = [point(0, 70), point(60, 80)];
    const analysis = analyzeWindow(history.at(-1)!, history, DEFAULT_CONFIG, 6 * HOUR);
    expect(analysis.freshness).toBe("reset_due");
    expect(analysis.usedPercent).toBe(80);
    expect(analysis.exhaustsAtMs).toBeNull();
    expect(analysis.reserveReachesAtMs).toBeNull();
    expect(analysis.reserveMinutesBeforeReset).toBeNull();
  });

  test("marks old snapshots stale", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.staleAfterSeconds = 60;
    const history = [point(0, 10)];
    const analysis = analyzeWindow(history[0]!, history, config, 2 * MINUTE);
    expect(analysis.freshness).toBe("stale");
    expect(analysis.reserveReachesAtMs).toBeNull();
  });

  test("stale usage cannot retain either exhaustion or reserve forecasts", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.staleAfterSeconds = 60;
    const history = [point(0, 50), point(5, 55)];
    const analysis = analyzeWindow(history[1]!, history, config, 7 * MINUTE);
    expect(analysis.recentBurnPerHour).toBeCloseTo(60);
    expect(analysis.freshness).toBe("stale");
    expect(analysis.exhaustsAtMs).toBeNull();
    expect(analysis.reserveReachesAtMs).toBeNull();
    expect(analysis.reserveMinutesBeforeReset).toBeNull();
  });

  test("projects observed consumption across overnight hours without a schedule gate", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.profile.timeZone = "UTC";
    config.profile.workSchedule.weekday = [{ start: "09:00", end: "17:00" }];
    config.profile.workSchedule.weekend = [{ start: "09:00", end: "17:00" }];
    const monday15 = Date.UTC(2026, 6, 6, 15, 0);
    const monday16 = Date.UTC(2026, 6, 6, 16, 0);
    const tuesday12 = Date.UTC(2026, 6, 7, 12, 0);
    const first = { ...point(0, 60, tuesday12), observedAtMs: monday15 };
    const latest = { ...point(0, 70, tuesday12), observedAtMs: monday16 };
    const analysis = analyzeWindow(latest, [first, { ...first, usedPercent: 65, observedAtMs: monday15 + 30 * MINUTE }, latest], config, monday16);
    expect(analysis.blendedBurnPerHour).toBeCloseTo(10, 3);
    expect(analysis.exhaustsAtMs).toBe(Date.UTC(2026, 6, 6, 19, 0));
  });

  test("selects the higher-risk provider window as bottleneck", () => {
    const shortHistory = [point(0, 50), point(15, 70)];
    const short = analyzeWindow(shortHistory.at(-1)!, shortHistory, DEFAULT_CONFIG, 15 * MINUTE);
    const weeklyPoint = {
      ...point(15, 10, 7 * 24 * HOUR),
      bucket: "seven_day",
      label: "Claude weekly",
      windowSeconds: 7 * 86_400,
    };
    const weekly = analyzeWindow(weeklyPoint, [weeklyPoint], DEFAULT_CONFIG, 15 * MINUTE);
    const status = groupStatuses([short, weekly])[0];
    expect(status?.bottleneckBucket).toBe("five_hour");
  });

  test("keeps two accounts with identical buckets in separate status groups", () => {
    const main = analyzeWindow(point(10, 20), [point(10, 20)], DEFAULT_CONFIG, 10 * MINUTE);
    const workPoint = { ...point(10, 70), account: "work" };
    const work = analyzeWindow(workPoint, [workPoint], DEFAULT_CONFIG, 10 * MINUTE);
    const statuses = groupStatuses(
      [main, work],
      (_provider, account) => account === "default" ? "Personal" : "Work",
    );
    expect(statuses).toHaveLength(2);
    expect(statuses.map((status) => [status.account, status.accountLabel])).toEqual([
      ["default", "Personal"],
      ["work", "Work"],
    ]);
    expect(statuses[0]?.windows[0]?.remainingPercent).toBe(80);
    expect(statuses[1]?.windows[0]?.remainingPercent).toBe(30);
  });
});

describe("the compact status line shows the weekly window that matters", () => {
  test("a model-scoped weekly at risk outranks a healthy overall weekly", () => {
    const base = {
      provider: "claude" as const,
      account: "default",
      windowSeconds: 7 * 86_400,
      source: "claude-oauth",
      quality: "authoritative" as const,
      freshness: "fresh" as const,
      observedAtMs: 1_000,
      resetsAtMs: 100_000,
      timeToResetMs: 99_000,
      reservePercent: 15,
      recentBurnPerHour: 1,
      personalBurnPerHour: 1,
      blendedBurnPerHour: 1,
      safePacePerActiveHour: 1,
      exhaustsAtMs: null,
      minutesBeforeReset: null,
      confidence: "high" as const,
      sampleCount: 100,
      activeHoursUntilReset: 10,
      riskLevel: "none" as const,
    };
    const line = compactClaudeLine([
      { ...base, bucket: "seven_day", label: "Claude weekly", usedPercent: 10, remainingPercent: 90, paceRatio: 0.2, bottleneckScore: 0.1 },
      { ...base, bucket: "seven_day_fable", label: "Claude Fable weekly", usedPercent: 100, remainingPercent: 0, paceRatio: 4, bottleneckScore: 2.4, riskLevel: "watch" },
    ], "Main");
    // The overall weekly is fine; the scoped one is exhausted, and that is the
    // number worth a single line.
    expect(line).toContain("0%");
    expect(line).not.toContain("90%");
  });
});
