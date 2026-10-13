import { expect, test } from "bun:test";
import { evaluateWorkAdmission, withinActivitySchedule, workObservation } from "../src/work/admission";
import type { WorkPolicy } from "../src/work/types";
import type { WindowAnalysis } from "../src/types";

const NOW = Date.UTC(2026, 9, 13, 12);
function policy(): WorkPolicy {
  return { id: "p", provider: "claude", account: "default", profileKey: "profile", accountKey: "account", nativeSessionId: "session", cwd: "/tmp", prompt: "work", objective: "done", completionCriteria: ["checks pass"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetBucket: "seven_day", resetWithinMinutes: 60, budgetByBucket: { five_hour: { reservePercent: 0, maxUsagePercent: 20 }, seven_day: { reservePercent: 10, maxUsagePercent: 30 } },
    maxTurns: 3, maxDurationSeconds: 60, maxTotalDurationSeconds: 120, expiresAtMs: NOW + 3600_000, priority: 0, onReset: "stop", revision: 1,
    state: { baselines: {}, spentByBucket: {}, turns: 0, totalDurationSeconds: 0, status: "waiting", activeExecutionId: null } };
}
function windows(): WindowAnalysis[] {
  return ["five_hour", "seven_day"].map(bucket => ({ provider: "claude", account: "default", bucket, quality: "authoritative", freshness: "fresh", observedAtMs: NOW - 1000,
    remainingPercent: 50, resetsAtMs: NOW + 3600_000, reservePercent: 10 } as WindowAnalysis));
}
test("explicit zero reserve overrides preference but other general windows constrain admission", () => {
  const p = policy(), w = windows();
  w[0]!.remainingPercent = 1;
  expect(evaluateWorkAdmission(p, w, NOW).ready).toBe(true);
  expect(evaluateWorkAdmission(p, w, NOW, { minimumReserveByBucket: { five_hour: 2 } }).reason).toBe("reserve-reached");
  w[1]!.remainingPercent = 10;
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("reserve-reached");
  p.state.spentByBucket.five_hour = 20; w[1]!.remainingPercent = 50;
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("usage-budget-ended");
});
test("every configured bucket must exist and observations must be fresh authoritative and bounded", () => {
  expect(evaluateWorkAdmission(policy(), windows().slice(1), NOW).reason).toBe("quota-unknown");
  for (const patch of [{ quality: "estimated" }, { remainingPercent: NaN }, { remainingPercent: 101 }, { remainingPercent: null },
    { observedAtMs: NOW + 1 }, { observedAtMs: NOW - 120_001 }, { observedAtMs: NaN }, { freshness: "stale" }, { resetsAtMs: null }, { resetsAtMs: NOW }]) {
    const w = windows(); Object.assign(w[0]!, patch);
    expect(evaluateWorkAdmission(policy(), w, NOW).ready).toBe(false);
  }
});
test("selected Claude model limits constrain usage without blocking unrelated selected models", () => {
  const p = policy(), w = windows();
  w.push({ ...w[1]!, bucket: "seven_day_opus", remainingPercent: 0 });
  p.model = "claude-sonnet-4-6";
  expect(evaluateWorkAdmission(p, w, NOW).ready).toBe(true);
  p.model = "claude-opus-4-6";
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("work-bucket-budget-required");
  p.budgetByBucket.seven_day_opus = { reservePercent: 0, maxUsagePercent: 10 };
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("reserve-reached");
  delete p.model;
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("reserve-reached");
});
test("newly published applicable windows stop already running work until budgeted", () => {
  const p = policy(), w = windows();
  p.model = "claude-opus-4-6";
  p.state.activeExecutionId = "owned-execution";
  p.state.status = "running";
  expect(evaluateWorkAdmission(p, w, NOW, { running: true, ignoreTrigger: true }).ready).toBe(true);
  w.push({ ...w[1]!, bucket: "seven_day_opus", remainingPercent: 80 });
  expect(evaluateWorkAdmission(p, w, NOW, { running: true, ignoreTrigger: true }).reason).toBe("work-bucket-budget-required");
  p.budgetByBucket.seven_day_opus = { reservePercent: 10, maxUsagePercent: 5 };
  expect(evaluateWorkAdmission(p, w, NOW, { running: true, ignoreTrigger: true }).ready).toBe(true);
});
test("public announcements and scheduled triggers cannot bypass quota admission", () => {
  const p = policy(), w = windows();
  p.trigger = "public-announcement";
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("awaiting-announcement");
  expect(evaluateWorkAdmission(p, w, NOW, { publicAnnouncementEligible: true }).ready).toBe(true);
  w[0]!.remainingPercent = 0;
  expect(evaluateWorkAdmission(p, w, NOW, { publicAnnouncementEligible: true }).reason).toBe("reserve-reached");
  w[0]!.remainingPercent = 50; p.trigger = "scheduled"; p.resetWithinMinutes = 30;
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("awaiting-reset-window");
  expect(evaluateWorkAdmission(p, w, NOW, { ignoreTrigger: true }).ready).toBe(true);
  p.resetWithinMinutes = 60;
  expect(evaluateWorkAdmission(p, w, NOW).ready).toBe(true);
});
test("overnight activity belongs to its starting weekday and follows regional DST", () => {
  const p = policy();
  p.activitySchedule = { timeZone: "Asia/Seoul", days: [1], start: "22:00", end: "02:00" };
  expect(withinActivitySchedule(p, Date.UTC(2026, 9, 12, 13))).toBe(true); // Monday 22:00
  expect(withinActivitySchedule(p, Date.UTC(2026, 9, 12, 16))).toBe(true); // Tuesday 01:00
  expect(withinActivitySchedule(p, Date.UTC(2026, 9, 12, 17))).toBe(false);
  expect(withinActivitySchedule(p, Date.UTC(2026, 9, 13, 13))).toBe(false);
  p.activitySchedule = { timeZone: "America/Los_Angeles", days: [0], start: "01:00", end: "02:00" };
  expect(withinActivitySchedule(p, Date.UTC(2026, 10, 1, 8, 30))).toBe(true);
  expect(withinActivitySchedule(p, Date.UTC(2026, 10, 1, 9, 30))).toBe(true);
  expect(withinActivitySchedule(p, Date.UTC(2026, 10, 1, 10, 30))).toBe(false);
});
test("per-turn timeout uses total remaining time and deadlines; running final turn may finish", () => {
  const p = policy();
  p.state.totalDurationSeconds = 100;
  expect(evaluateWorkAdmission(p, windows(), NOW).timeoutSeconds).toBe(20);
  p.workDeadline = NOW + 5000;
  expect(evaluateWorkAdmission(p, windows(), NOW).timeoutSeconds).toBe(5);
  p.state.turns = 3;
  expect(evaluateWorkAdmission(p, windows(), NOW).reason).toBe("turn-budget-ended");
  expect(evaluateWorkAdmission(p, windows(), NOW, { ignoreTrigger: true, running: true }).ready).toBe(true);
});
test("observation mapping keeps each bucket timestamp and ignores other accounts", () => {
  const p = policy(), w = windows();
  p.budgetByBucket.seven_day = { reservePercent: 0, maxUsagePercent: 20 };
  w[1]!.observedAtMs = NOW - 3000;
  w.push({ ...w[0]!, account: "other", observedAtMs: NOW });
  const observation = workObservation(p, w)!;
  expect(observation.atMs).toBe(NOW - 1000);
  expect(observation.buckets.seven_day?.atMs).toBe(NOW - 3000);
  expect(Object.keys(observation.buckets)).toEqual(["five_hour", "seven_day"]);
  w[0]!.observedAtMs = NOW + 1;
  expect(workObservation(p, w, NOW)?.buckets.five_hour).toBeUndefined();
});
