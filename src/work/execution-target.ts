import { createHash } from "node:crypto";
import type { PoolPolicy } from "../account-pool";
import type { WorkExecutionTarget, WorkPolicy, WorkTargetAccounting } from "./types";

/** Configuration changes revoke the frozen execution; they never select a new account. */
export function executionPoolPolicyHash(policy: PoolPolicy): string {
  return createHash("sha256").update(JSON.stringify({ enabled: policy.enabled,
    accounts: [...policy.accounts].sort(), reservePercent: Object.fromEntries(Object.entries(policy.reservePercent ?? {}).sort()) })).digest("hex");
}

export function validExecutionTarget(source: WorkPolicy, target: WorkExecutionTarget, nowMs: number): boolean {
  const hash = /^[a-f0-9]{64}$/;
  if (source.provider !== "codex" || source.purpose !== "quota-resume" || !source.quotaResume ||
      source.dispatchOwner !== "local" || source.maxTurns !== 1 || !target ||
      !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(target.account) || target.account === source.account ||
      ![target.profileKey, target.accountKey, target.identity, target.sourceIdentity, target.poolPolicyHash].every(v => typeof v === "string" && hash.test(v)) ||
      target.profileKey === source.profileKey || target.accountKey === source.accountKey || target.identity === target.sourceIdentity ||
      !Number.isFinite(target.selectedAtMs) || target.selectedAtMs > nowMs ||
      !Number.isFinite(target.expiresAtMs) || target.expiresAtMs <= nowMs || target.expiresAtMs - target.selectedAtMs > 3_600_000 ||
      !target.budgetByBucket || !target.baselineByBucket) return false;
  const buckets = Object.keys(target.budgetByBucket);
  if (!buckets.length || buckets.length !== Object.keys(target.baselineByBucket).length) return false;
  return buckets.every(bucket => {
    const budget = target.budgetByBucket[bucket]!, baseline = target.baselineByBucket[bucket];
    return /^[a-zA-Z0-9:_.-]{1,160}$/.test(bucket) && baseline && typeof baseline.observationId === "string" && !!baseline.observationId &&
      Number.isFinite(budget.reservePercent) && budget.reservePercent >= 0 && budget.reservePercent < 100 &&
      Number.isFinite(budget.maxUsagePercent) && budget.maxUsagePercent > 0 && budget.maxUsagePercent <= 100 &&
      (budget.targetUsagePercent === undefined || Number.isFinite(budget.targetUsagePercent) && budget.targetUsagePercent >= 0 && budget.targetUsagePercent <= budget.maxUsagePercent) &&
      Number.isFinite(baseline.atMs) && baseline.atMs <= target.selectedAtMs && target.selectedAtMs - baseline.atMs <= 120_000 &&
      Number.isFinite(baseline.remainingPercent) && baseline.remainingPercent > budget.reservePercent && baseline.remainingPercent <= 100 &&
      Number.isFinite(Number(baseline.epoch)) && Number(baseline.epoch) > target.selectedAtMs;
  });
}

/** Internal quota projection only. Never pass it to a native session adapter or
 * save it as a policy: the source account continues to own session and consent. */
export function executionQuotaPolicy(source: WorkPolicy, target: WorkExecutionTarget, accounting?: WorkTargetAccounting): WorkPolicy {
  return { ...source, account: target.account, profileKey: target.profileKey, accountKey: target.accountKey,
    budgetByBucket: target.budgetByBucket,
    state: { ...source.state, spentByBucket: accounting?.spentByBucket ?? {},
      baselines: accounting?.baselines ?? target.baselineByBucket,
      observationCoverageByBucket: accounting?.observationCoverageByBucket,
      pendingAccountingByBucket: accounting?.pendingAccountingByBucket } };
}

export function executionTargetDigest(target: WorkExecutionTarget): string {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}
