import { expect, test } from "bun:test";
import { evaluateWorkPerformance } from "../src/work/performance";
import type { WorkExecution, WorkPolicy } from "../src/work/types";

function policy(): WorkPolicy {
  return { id: "p", provider: "claude", account: "default", profileKey: "profile", accountKey: "account", nativeSessionId: "session", cwd: "/tmp", prompt: "work", objective: "done", completionCriteria: ["checks pass"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetWithinMinutes: 60, budgetByBucket: { five_hour: { reservePercent: 0, maxUsagePercent: 20, targetUsagePercent: 10 }, seven_day: { reservePercent: 5, maxUsagePercent: 30 } },
    maxTurns: 3, maxDurationSeconds: 60, maxTotalDurationSeconds: 120, expiresAtMs: 100_000, priority: 0, onReset: "stop", revision: 1,
    state: { baselines: {}, spentByBucket: { five_hour: 10, seven_day: 3 }, turns: 1, totalDurationSeconds: 30, status: "turn-finished", activeExecutionId: null,
      observationCoverageByBucket: { five_hour: { firstObservationAtMs: 100, lastObservationAtMs: 300, minimumRemainingPercent: 40,
        lastReset: { evidence: "quota-recovery", afterMs: 200, beforeOrAtMs: 300, preResetRemainingPercent: 40 } } } } };
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
test("useful pre-reset completion retains reset uncertainty and first-decision forecast",()=>{
 const p=policy();p.state.observationCoverageByBucket!.five_hour!.observationCount=4;
 p.state.observationCoverageByBucket!.five_hour!.maxObservationGapMs=100;
 const e:WorkExecution={id:"e",policyId:p.id,policyRevision:1,owner:"dots",policySnapshot:structuredClone(p),turnOrdinal:1,
 claimedAtMs:50,dispatchedAtMs:100,finishedAtMs:190,status:"finished",result:{status:"objective-completed",evidenceRefs:["file:result"],completionAssessment:"machine"},
 planning:{forecastId:"frozen",horizonAtMs:200,expectedWorkMinutes:1,expectedWorkSource:"user",deadlineAtMs:200,deadlineSource:"forecast",finishAtMs:200,startByAtMs:-59800}};
 let result=evaluateWorkPerformance(p,[e]);expect(result.usefulWorkBeforeReset).toBe("confirmed");expect(result.decisionForecastId).toBe("frozen");
 expect(result.buckets.five_hour).toMatchObject({resetUncertaintyMs:100,maxObservationGapMs:100,observationCount:4});
 expect(result.leadBeforeResetMs.five_hour).toEqual({minimum:100,maximum:200});
 e.finishedAtMs=250;expect(evaluateWorkPerformance(p,[e]).usefulWorkBeforeReset).toBe("uncertain");
 e.finishedAtMs=301;expect(evaluateWorkPerformance(p,[e]).usefulWorkBeforeReset).toBe("not-confirmed");
});
test("pre-reset completion verdict uses the policy selected reset bucket",()=>{
 const p=policy();p.resetBucket="seven_day";
 const e:WorkExecution={id:"e",policyId:p.id,policyRevision:1,owner:"dots",policySnapshot:structuredClone(p),turnOrdinal:1,
 claimedAtMs:50,dispatchedAtMs:100,finishedAtMs:190,status:"finished",result:{status:"objective-completed",evidenceRefs:["file:result"],completionAssessment:"machine"}};
 expect(evaluateWorkPerformance(p,[e]).usefulWorkBeforeReset).toBe("not-confirmed");
 p.state.observationCoverageByBucket!.seven_day={firstObservationAtMs:100,lastObservationAtMs:150,minimumRemainingPercent:30,lastReset:{afterMs:110,beforeOrAtMs:150,preResetRemainingPercent:30}};
 expect(evaluateWorkPerformance(p,[e]).usefulWorkBeforeReset).toBe("not-confirmed");
});
test("observed reserve violations use each execution frozen floor and epoch shifts are not proven resets",()=>{
 const p=policy();const e:WorkExecution={id:"e",policyId:p.id,policyRevision:1,owner:"dots",policySnapshot:structuredClone(p),turnOrdinal:1,claimedAtMs:50,dispatchedAtMs:100,finishedAtMs:190,status:"finished",result:{status:"objective-completed",evidenceRefs:["file:result"],completionAssessment:"machine"},minimumRemainingByBucket:{five_hour:4},effectiveReserveByBucket:{five_hour:5}};
 expect(evaluateWorkPerformance(p,[e]).limitsRespected).toBe(false);
 e.minimumRemainingByBucket!.five_hour=5;expect(evaluateWorkPerformance(p,[e]).limitsRespected).toBe(true);
 p.state.observationCoverageByBucket!.five_hour!.lastReset!.evidence="epoch-change";
 const report=evaluateWorkPerformance(p,[e]);expect(report.usefulWorkBeforeReset).toBe("not-confirmed");expect(report.buckets.five_hour!.beforeResetAccountUsage).toBeNull();
});
