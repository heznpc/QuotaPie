import { expect, test } from "bun:test";
import { evaluateWorkPerformance } from "../src/work/performance";
import type { WorkExecution, WorkPolicy } from "../src/work/types";

function policy(): WorkPolicy {
  return { id: "p", provider: "claude", account: "default", profileKey: "profile", accountKey: "account", nativeSessionId: "session", cwd: "/tmp", prompt: "work", objective: "done", completionCriteria: ["checks pass"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetWithinMinutes: 60, budgetByBucket: { five_hour: { reservePercent: 0, maxUsagePercent: 20, targetUsagePercent: 10 }, seven_day: { reservePercent: 5, maxUsagePercent: 30 } },
    maxTurns: 3, maxDurationSeconds: 60, maxTotalDurationSeconds: 120, expiresAtMs: 100_000, priority: 0, onReset: "stop", revision: 1,
    state: { baselines: {}, spentByBucket: { five_hour: 10, seven_day: 3 }, turns: 1, totalDurationSeconds: 30, status: "turn-finished", activeExecutionId: null,
      observationCoverageByBucket: { five_hour: { firstObservationAtMs: 100, lastObservationAtMs: 300, minimumRemainingPercent: 40,
        lastReset: { afterMs: 200, beforeOrAtMs: 300, preResetRemainingPercent: 40 } } } } };
}
test("quota target and useful-work completion are separate and never claim attribution", () => {
  const p = policy();
  const summary = evaluateWorkPerformance(p);
  expect(summary.buckets.five_hour?.targetMet).toBe("met");
  expect(summary.buckets.seven_day?.targetMet).toBe("not-configured");
  expect(summary.buckets.five_hour?.accountUsage).toBe(10);
  expect(summary.usefulWorkCompleted).toBe(false);
  expect(summary.attributionAvailable).toBe(false);
  expect(summary.limitsRespected).toBe(true);
  p.state.lastResult = { status: "objective-completed", evidenceRefs: ["file:result"], completionAssessment: "model-assessed" };
  expect(evaluateWorkPerformance(p).usefulWorkCompleted).toBe(true);
  expect(evaluateWorkPerformance(p).completionAssessment).toBe("model-assessed");
  p.state.spentByBucket.five_hour = 2;
  expect(evaluateWorkPerformance(p).buckets.five_hour?.targetMet).toBe("not-met");
});
test("performance carries observed reset bounds rather than inventing a reset instant", () => {
  const result = evaluateWorkPerformance(policy());
  expect(result.buckets.five_hour).toMatchObject({ firstObservationAtMs: 100, lastObservationAtMs: 300,
    resetBoundary: { afterMs: 200, beforeOrAtMs: 300, preResetRemainingPercent: 40 } });
  expect(result.buckets.seven_day?.resetBoundary).toBeNull();
  expect(result.buckets.seven_day?.beforeResetAccountUsage).toBeNull();
  expect(result.buckets.seven_day?.beforeResetTargetMet).toBeNull();
});
test("cumulative target reached across epochs does not imply pre-reset target reached", () => {
  const p = policy();
  p.state.spentByBucket.five_hour = 12;
  p.state.observationCoverageByBucket!.five_hour!.lastReset!.preResetAccountUsage = 4;
  const result = evaluateWorkPerformance(p).buckets.five_hour!;
  expect(result.targetMet).toBe("met");
  expect(result.accountUsageScope).toBe("authorization-total");
  expect(result.beforeResetAccountUsage).toBe(4);
  expect(result.beforeResetTargetMet).toBe("not-met");
});
test("limits flag exceeded usage, turns and duration independently", () => {
  for (const mutate of [
    (p: WorkPolicy) => { p.state.spentByBucket.five_hour = 21; },
    (p: WorkPolicy) => { p.state.turns = 4; },
    (p: WorkPolicy) => { p.state.totalDurationSeconds = 121; },
  ]) {
    const p = policy(); mutate(p);
    expect(evaluateWorkPerformance(p).limitsRespected).toBe(false);
  }
});
test("later target edits do not rewrite the first dispatched target", () => {
  const p = policy();
  const execution: WorkExecution = { id: "e", policyId: p.id, policyRevision: 1, owner: "local", policySnapshot: structuredClone(p), turnOrdinal: 1,
    claimedAtMs: 100, dispatchedAtMs: 101, finishedAtMs: 30101, status: "finished", result: { status: "turn-finished", remainingWork: "verify" } };
  p.revision = 2;
  p.budgetByBucket.five_hour!.targetUsagePercent = 1;
  p.state.spentByBucket.five_hour = 2;
  expect(evaluateWorkPerformance(p, [execution]).buckets.five_hour?.targetMet).toBe("not-met");
  expect(evaluateWorkPerformance(p, [execution]).policyRevision).toBe(1);
});
