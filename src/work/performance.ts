import type { WorkExecution, WorkPolicy } from "./types";

export interface WorkBucketPerformance {
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
  limitsChecked: Array<"account-usage" | "turns" | "total-duration" | "execution-duration">;
  attributionAvailable: false;
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
    const beforeResetAccountUsage = coverage?.lastReset?.preResetAccountUsage ?? null;
    buckets[bucket] = {
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
    const elapsed = execution.accountedDurationSeconds ?? (execution.dispatchedAtMs !== undefined && execution.finishedAtMs !== undefined
      ? Math.max(0, (execution.finishedAtMs - execution.dispatchedAtMs) / 1000) : 0);
    if (elapsed > execution.policySnapshot.maxDurationSeconds) limitsRespected = false;
  }
  const completed = own.find(execution => execution.status === "finished" && execution.result?.status === "objective-completed"
    && execution.result.evidenceRefs?.length && execution.result.completionAssessment)?.result;
  // The state result is also durable and useful when callers omit the ledger.
  const result = completed ?? policy.state.lastResult;
  const usefulWorkCompleted = result?.status === "objective-completed" && !!result.evidenceRefs?.length && !!result.completionAssessment;
  return { policyRevision: authorized.revision, buckets, usefulWorkCompleted, completionAssessment: usefulWorkCompleted ? result!.completionAssessment! : null,
    limitsRespected, limitsAssessment: "observed-only", limitsChecked: ["account-usage", "turns", "total-duration", "execution-duration"], attributionAvailable: false };
}
