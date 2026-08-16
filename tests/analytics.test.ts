import { describe, expect, test } from "bun:test";
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

  test("does not invent a recharge after reset time passes", () => {
    const history = [point(0, 70), point(60, 80)];
    const analysis = analyzeWindow(history.at(-1)!, history, DEFAULT_CONFIG, 6 * HOUR);
    expect(analysis.freshness).toBe("reset_due");
    expect(analysis.usedPercent).toBe(80);
    expect(analysis.exhaustsAtMs).toBeNull();
  });

  test("marks old snapshots stale", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.staleAfterSeconds = 60;
    const history = [point(0, 10)];
    expect(analyzeWindow(history[0]!, history, config, 2 * MINUTE).freshness).toBe("stale");
  });

  test("moves exhaustion across inactive overnight hours", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.profile.timeZone = "UTC";
    config.profile.workSchedule.weekday = [{ start: "09:00", end: "17:00" }];
    config.profile.workSchedule.weekend = [{ start: "09:00", end: "17:00" }];
    const monday15 = Date.UTC(2026, 6, 6, 15, 0);
    const monday16 = Date.UTC(2026, 6, 6, 16, 0);
    const tuesday12 = Date.UTC(2026, 6, 7, 12, 0);
    const first = { ...point(0, 60, tuesday12), observedAtMs: monday15 };
    const latest = { ...point(0, 70, tuesday12), observedAtMs: monday16 };
    const analysis = analyzeWindow(latest, [first, latest], config, monday16);
    expect(analysis.blendedBurnPerHour).toBeCloseTo(10, 3);
    expect(analysis.exhaustsAtMs).toBe(Date.UTC(2026, 6, 7, 10, 0));
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
