import type { WorkExecution, WorkPolicy } from "./types";

export interface WorkBucketPerformance {
  observationCount: number; maxObservationGapMs: number | null;
  resetUncertaintyMs: number | null; resetEvidence: "quota-recovery" | "epoch-change" | "allowance-change" | "unverified";
  concurrentUsageAttribution: "unavailable";
  unusedBeforeResetPercent: number | null;
  targetMet: "not-configured" | "met" | "not-met";
  accountUsage: number;
  accountUsageScope: "authorization-total";
  beforeResetAccountUsage: number | null;
  beforeResetTargetMet: "not-configured" | "met" | "not-met" | null;
  targetUsagePercent?: number;
  maxUsagePercent: number;
  firstObservationAtMs: number | null;
  lastObservationAtMs: number | null;
  lastActiveObservationAtMs: number | null;
  accountingClosedAtMs: number | null;
  resetBoundary: { afterMs: number; beforeOrAtMs: number; preResetRemainingPercent: number } | null;
}
export interface WorkPerformance {
  policyRevision: number;
  buckets: Record<string, WorkBucketPerformance>;
  usefulWorkCompleted: boolean;
  completionAssessment: "machine" | "model-assessed" | null;
  limitsRespected: boolean;
  limitsAssessment: "observed-only";
  limitsChecked: Array<"account-usage" | "turns" | "total-duration" | "execution-duration" | "reserve">;
  attributionAvailable: false;
  firstDecisionAtMs: number | null; firstDispatchAtMs: number | null;
  leadBeforeResetMs: Record<string,{minimum:number;maximum:number}>;
  decisionForecastId: string | null; evidenceRefs: string[];
  usefulWorkBeforeReset: "confirmed" | "uncertain" | "not-confirmed";
}

/** Account percentage changes do not identify which simultaneous task spent them.
 * Results intentionally keep quota targets distinct from useful-work evidence. */
export function evaluateWorkPerformance(policy: WorkPolicy, executions: WorkExecution[] = []): WorkPerformance {
  const own = executions.filter(execution => execution.policyId === policy.id);
  const first = own.filter(execution => execution.dispatchedAtMs !== undefined).sort((a, b) => a.dispatchedAtMs! - b.dispatchedAtMs!)[0];
  // A later settings edit cannot retroactively turn the original target into a hit.
  const authorized = first?.policySnapshot ?? policy;
  const buckets: Record<string, WorkBucketPerformance> = {};
  let limitsRespected = policy.state.turns <= policy.maxTurns && policy.state.totalDurationSeconds <= policy.maxTotalDurationSeconds;
  for (const [bucket, budget] of Object.entries(authorized.budgetByBucket)) {
    const accountUsage = policy.state.spentByBucket[bucket] ?? 0;
    const coverage = policy.state.observationCoverageByBucket?.[bucket];
    const effectiveCap = policy.budgetByBucket[bucket]?.maxUsagePercent ?? budget.maxUsagePercent;
    const beforeResetAccountUsage = coverage?.lastReset?.evidence === "quota-recovery" ? coverage.lastReset.preResetAccountUsage ?? null : null;
    buckets[bucket] = {
      observationCount:coverage?.observationCount ?? 0,maxObservationGapMs:coverage?.maxObservationGapMs ?? null,
      resetEvidence:coverage?.lastReset?.evidence??"unverified",
      resetUncertaintyMs:coverage?.lastReset ? coverage.lastReset.beforeOrAtMs - coverage.lastReset.afterMs : null,
      concurrentUsageAttribution:"unavailable",unusedBeforeResetPercent:coverage?.lastReset?.preResetRemainingPercent ?? null,
      targetMet: budget.targetUsagePercent === undefined ? "not-configured" : accountUsage >= budget.targetUsagePercent ? "met" : "not-met",
      accountUsage, accountUsageScope: "authorization-total", beforeResetAccountUsage,
      beforeResetTargetMet: beforeResetAccountUsage === null ? null : budget.targetUsagePercent === undefined ? "not-configured"
        : beforeResetAccountUsage >= budget.targetUsagePercent ? "met" : "not-met",
      targetUsagePercent: budget.targetUsagePercent, maxUsagePercent: effectiveCap,
      firstObservationAtMs: coverage?.firstObservationAtMs ?? null,
      lastObservationAtMs: coverage?.lastObservationAtMs ?? null,
      lastActiveObservationAtMs: coverage?.lastActiveObservationAtMs ?? null,
      accountingClosedAtMs: coverage?.accountingClosedAtMs ?? null,
      resetBoundary: coverage?.lastReset ?? null,
    };
    if (!Number.isFinite(accountUsage) || accountUsage < 0 || accountUsage > effectiveCap) limitsRespected = false;
  }
  for (const execution of own) {
    for (const [bucket,minimum] of Object.entries(execution.minimumRemainingByBucket??{})) {
      const floor=execution.effectiveReserveByBucket?.[bucket]??execution.policySnapshot.budgetByBucket[bucket]?.reservePercent??0;
      if (minimum<floor) limitsRespected=false;
    }
    const elapsed = execution.accountedDurationSeconds ?? (execution.dispatchedAtMs !== undefined && execution.finishedAtMs !== undefined
      ? Math.max(0, (execution.finishedAtMs - execution.dispatchedAtMs) / 1000) : 0);
    if (elapsed > execution.policySnapshot.maxDurationSeconds) limitsRespected = false;
  }
  const completed = own.find(execution => execution.status === "finished" && execution.result?.status === "objective-completed"
    && execution.result.evidenceRefs?.length && execution.result.completionAssessment)?.result;
  // The state result is also durable and useful when callers omit the ledger.
  const result = completed ?? policy.state.lastResult;
  const usefulWorkCompleted = result?.status === "objective-completed" && !!result.evidenceRefs?.length && !!result.completionAssessment;
  const leadBeforeResetMs:WorkPerformance["leadBeforeResetMs"]={};
  for(const [bucket,coverage] of Object.entries(policy.state.observationCoverageByBucket??{})) if(first?.dispatchedAtMs!==undefined && coverage.lastReset)
    leadBeforeResetMs[bucket]={minimum:coverage.lastReset.afterMs-first.dispatchedAtMs,maximum:coverage.lastReset.beforeOrAtMs-first.dispatchedAtMs};
  const completedAtMs=own.find(e=>e.result===completed)?.finishedAtMs;
  const resets=Object.entries(policy.state.observationCoverageByBucket??{}).filter(([bucket])=>authorized.resetBucket===undefined||bucket===authorized.resetBucket).flatMap(([,c])=>c.lastReset?.evidence==="quota-recovery"?[c.lastReset]:[]);
  const usefulWorkBeforeReset:WorkPerformance["usefulWorkBeforeReset"]=!usefulWorkCompleted||completedAtMs===undefined||!resets.length?"not-confirmed":
    resets.every(r=>completedAtMs<=r.afterMs)?"confirmed":resets.some(r=>completedAtMs<=r.beforeOrAtMs)?"uncertain":"not-confirmed";
  return {firstDecisionAtMs:first?.claimedAtMs??null,firstDispatchAtMs:first?.dispatchedAtMs??null,leadBeforeResetMs,
    decisionForecastId:first?.planning?.forecastId??null,evidenceRefs:result?.evidenceRefs??[],usefulWorkBeforeReset, policyRevision: authorized.revision, buckets, usefulWorkCompleted, completionAssessment: usefulWorkCompleted ? result!.completionAssessment! : null,
    limitsRespected, limitsAssessment: "observed-only", limitsChecked: ["account-usage", "turns", "total-duration", "execution-duration", "reserve"], attributionAvailable: false };
}
