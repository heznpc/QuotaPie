import { expect, test } from "bun:test";
import { evaluateWorkAdmission, withinActivitySchedule, workObservation, workWindows } from "../src/work/admission";
import { analyzeWindow } from "../src/analytics";
import { DEFAULT_CONFIG } from "../src/config";
import { parseCodexRateLimits } from "../src/providers/codex-appserver";
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

test("forecast triggers use only verified action probabilities and explicit unknown behavior", () => {
  const p=policy(), w=windows();p.trigger="forecast-probability";p.startProbability=0.7;
  expect(evaluateWorkAdmission(p,w,NOW).reason).toBe("forecast-unavailable");
  expect(evaluateWorkAdmission(p,w,NOW,{forecast:{actionProbabilityEstimate:0.69,horizonAtMs:NOW+1000}}).reason).toBe("awaiting-forecast-probability");
  expect(evaluateWorkAdmission(p,w,NOW,{forecast:{actionProbabilityEstimate:0.7,horizonAtMs:NOW+1000}}).ready).toBe(true);
  p.unknownForecastAction="announcement";
  expect(evaluateWorkAdmission(p,w,NOW,{publicAnnouncementEligible:true}).ready).toBe(true);
  p.opportunityMaxAgeMinutes=1;
  expect(evaluateWorkAdmission(p,w,NOW,{publicAnnouncementEligible:true,announcementPublishedAtMs:NOW-60001}).ready).toBe(false);
  p.unknownForecastAction="notify";
  expect(evaluateWorkAdmission(p,w,NOW).reason).toBe("forecast-unavailable-notify");
});
test("planning preserves probability facts and bounds runtime by selected deadline and buffer", () => {
  const p=policy(),w=windows();p.expectedWorkMinutes=10;p.finishBufferMinutes=5;p.earlyResetQuantile=0.2;
  const answer=evaluateWorkAdmission(p,w,NOW,{forecast:{id:"f",actionProbabilityEstimate:null,horizonAtMs:NOW+900000,quantileAtMs:NOW+330000}});
  expect(answer.planning).toMatchObject({forecastId:"f",expectedWorkMinutes:10,expectedWorkSource:"user",horizonAtMs:NOW+900000,finishAtMs:NOW+30000,startByAtMs:NOW-570000,deadlineSource:"forecast"});
  expect(answer.timeoutSeconds).toBe(30);
  p.trigger="public-announcement";
  expect(evaluateWorkAdmission(p,w,NOW,{publicAnnouncementEligible:true}).ready).toBe(true); // no probability hold
  p.trigger="forecast-probability";p.unknownForecastAction="personal-deadline";p.personalDeadline=NOW+1800000;p.usePersonalDeadlineForPlanning=true;
  expect(evaluateWorkAdmission(p,w,NOW).reason).toBe("awaiting-planned-start");
  p.personalDeadline=NOW+900000;
  expect(evaluateWorkAdmission(p,w,NOW).ready).toBe(true);
});
test("activity inheritance is explicit and notification-only never dispatches",()=>{
  const p=policy(),w=windows();p.activityMode="inherit";
  expect(evaluateWorkAdmission(p,w,NOW).reason).toBe("activity-paused");
  const schedule={timeZone:"UTC",days:[0,1,2,3,4,5,6],start:"00:00",end:"00:00"};
  expect(evaluateWorkAdmission(p,w,NOW,{inheritedActivitySchedules:[schedule]}).ready).toBe(true);
  p.activityMode="unrestricted";p.activitySchedule={...schedule,days:[]};
  expect(evaluateWorkAdmission(p,w,NOW).ready).toBe(true);
  p.trigger="notify-only";
  expect(evaluateWorkAdmission(p,w,NOW).reason).toBe("notification-only");
});
test("a cached forecast retains the horizon actually published",()=>{
 const p=policy();p.expectedWorkMinutes=20;
 expect(evaluateWorkAdmission(p,windows(),NOW,{forecast:{id:"f",horizonAtMs:NOW+1000,actionProbabilityEstimate:0.8}}).planning.horizonAtMs).toBe(NOW+1000);
});
test("planning uses the earliest opted-in forecast, personal assumption and hard deadline",()=>{
 const p=policy();p.expectedWorkMinutes=5;p.usePersonalDeadlineForPlanning=true;p.personalDeadline=NOW+1200000;p.earlyResetQuantile=0.2;
 const result=evaluateWorkAdmission(p,windows(),NOW,{forecast:{actionProbabilityEstimate:0.8,horizonAtMs:NOW+300000,quantileAtMs:NOW+600000}});
 expect(result.planning.deadlineAtMs).toBe(NOW+600000);expect(result.planning.deadlineSource).toBe("forecast");
});

function codexRecovery() {
  const p = policy();
  p.provider = "codex"; p.model = "gpt-6-sol"; p.purpose = "quota-resume";
  p.quotaResume = { turnId: "failed-turn", stamp: "failed-stamp" };
  const response = {
    ordinaryUsageAllowed: true,
    rateLimitsByLimitId: {
      codex: { limitId: "codex", spendControlReached: false,
        primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: (NOW + 18000000) / 1000 },
        secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: (NOW + 604800000) / 1000 } },
      codex_model_pool: { limitId: "codex_model_pool", normalModelSlug: "gpt-6-sol", spendControlReached: false,
        primary: { usedPercent: 50, windowDurationMins: 43200, resetsAt: (NOW + 2592000000) / 1000 } },
    },
  };
  const w = parseCodexRateLimits(response, NOW - 1000).map(observation => analyzeWindow(observation, [], DEFAULT_CONFIG, NOW));
  p.budgetByBucket = Object.fromEntries(w.map(window => [window.bucket, { reservePercent: 5, maxUsagePercent: 100 }]));
  return { p, w };
}

test("five-hour, weekly, and provider-associated model windows must all recover", () => {
  const { p, w } = codexRecovery();
  expect(workWindows(p, w)).toHaveLength(3);
  expect(evaluateWorkAdmission(p, w, NOW).ready).toBe(true);
  for (let index = 0; index < w.length; index++) {
    const blocked = w.map((window, i) => ({ ...window, remainingPercent: i === index ? 0 : 95 }));
    expect(evaluateWorkAdmission(p, blocked, NOW).reason).toBe("reserve-reached");
    blocked[index]!.remainingPercent = 6;
    expect(evaluateWorkAdmission(p, blocked, NOW).ready).toBe(true);
  }
  // Two windows recover; the third window still independently owns the hold.
  const overlapping = w.map(window => ({ ...window, remainingPercent: 0 }));
  overlapping[0]!.remainingPercent = 100;
  expect(evaluateWorkAdmission(p, overlapping, NOW).ready).toBe(false);
  overlapping[1]!.remainingPercent = 100;
  expect(evaluateWorkAdmission(p, overlapping, NOW).ready).toBe(false);
  overlapping[2]!.remainingPercent = 100;
  expect(evaluateWorkAdmission(p, overlapping, NOW).ready).toBe(true);
});

test("model quota uses provider association, exact alias, or conservative unknown scope", () => {
  const { p, w } = codexRecovery();
  const alias = w[2]!;
  const unrelated = { ...alias, bucket: "different-pool:primary:300", metadata: { limitId: "different-pool", normalModelSlug: "gpt-6-luna" }, remainingPercent: 0 };
  expect(workWindows(p, [...w, unrelated])).toHaveLength(3);
  const opaque = { ...unrelated, metadata: { limitId: "different-pool", normalModelSlug: null } };
  expect(evaluateWorkAdmission(p, [...w, opaque], NOW).reason).toBe("work-bucket-budget-required");
  p.budgetByBucket[opaque.bucket] = { reservePercent: 0, maxUsagePercent: 100 };
  expect(evaluateWorkAdmission(p, [...w, opaque], NOW).reason).toBe("reserve-reached");
  delete p.budgetByBucket[opaque.bucket];
  p.model = "different-pool";
  expect(workWindows(p, [w[0]!, unrelated])).toContain(unrelated);
  delete p.model;
  expect(workWindows(p, [...w, unrelated])).toHaveLength(4);
});

test("a reset estimate, missing model lane, stale lane, or duplicate lane never grants admission", () => {
  const { p, w } = codexRecovery();
  expect(evaluateWorkAdmission(p, w.slice(0, 2), NOW).reason).toBe("quota-unknown");
  expect(evaluateWorkAdmission(p, [...w, { ...w[2]!, remainingPercent: 100 }], NOW).reason).toBe("quota-unknown");
  for (let index = 0; index < w.length; index++) {
    const stale = w.map((window, i) => i === index ? { ...window, observedAtMs: NOW - 120001 } : window);
    expect(evaluateWorkAdmission(p, stale, NOW).reason).toBe("quota-stale");
    const unconfirmed = w.map((window, i) => i === index ? { ...window, remainingPercent: 100, resetsAtMs: NOW } : window);
    expect(evaluateWorkAdmission(p, unconfirmed, NOW).reason).toBe("reset-unconfirmed");
  }
});

test("provider permission overrides positive percentages and unavailable permission fails closed", () => {
  const { p, w } = codexRecovery();
  const denials: NonNullable<WindowAnalysis["metadata"]>[] = [{ ordinaryUsageAllowed: false }, { spendControlReached: true }];
  for (const patch of denials) {
    const denied = w.map(window => ({ ...window, metadata: { ...window.metadata, ...patch } }));
    expect(evaluateWorkAdmission(p, denied, NOW).reason).toBe("reserve-reached");
  }
  const unknown = w.map(window => ({ ...window, metadata: { ...window.metadata, ordinaryUsageAllowed: null } }));
  expect(evaluateWorkAdmission(p, unknown, NOW).reason).toBe("quota-unknown");
  const legacy = w.map(window => { const metadata = { ...window.metadata }; delete metadata.ordinaryUsageAllowed; return { ...window, metadata }; });
  expect(evaluateWorkAdmission(p, legacy, NOW).ready).toBe(true);
});

test("continuous automatic recovery can wait beyond eight days while ordinary policy expiry stays enforced", () => {
  const { p, w } = codexRecovery();
  p.expiresAtMs = NOW - 1;
  p.quotaResume!.waitUntilRecovered = true;
  expect(evaluateWorkAdmission(p, w, NOW).ready).toBe(true);
  expect(evaluateWorkAdmission(p, w, NOW).timeoutSeconds).toBe(60);
  p.workDeadline = NOW - 1;
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("expired");
  delete p.workDeadline;
  delete p.purpose;
  expect(evaluateWorkAdmission(p, w, NOW).reason).toBe("expired");
});
