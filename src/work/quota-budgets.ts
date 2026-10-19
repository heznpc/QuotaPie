import type { WindowAnalysis } from "../types";
import { workWindows } from "./admission";
import type { WorkBudget, WorkPolicy } from "./types";

export interface QuotaBudgetReplacement { previousBucket: string; nextBucket: string }
export interface QuotaResumeBudgetPlan {
  budgets: Record<string, WorkBudget>;
  replacements: QuotaBudgetReplacement[];
}

/** The adapter's bucket identity, not a model-name or display-name guess. */
export function codexQuotaLane(bucket: string): { limitId: string; lane: "primary" | "secondary"; durationMinutes: number } | null {
  const match = /^(.+):(primary|secondary):(\d+(?:\.\d+)?)$/.exec(bucket);
  if (!match) return null;
  const durationMinutes = Number(match[3]);
  return Number.isFinite(durationMinutes) && durationMinutes > 0
    ? { limitId: match[1]!, lane: match[2]! as "primary" | "secondary", durationMinutes } : null;
}

export function stricterQuotaBudget(...budgets: WorkBudget[]): WorkBudget {
  const maxUsagePercent = Math.min(...budgets.map(budget => budget.maxUsagePercent));
  const targets = budgets.flatMap(budget => budget.targetUsagePercent === undefined ? [] : [budget.targetUsagePercent]);
  return { reservePercent: Math.max(...budgets.map(budget => budget.reservePercent)), maxUsagePercent,
    ...(targets.length ? { targetUsagePercent: Math.min(maxUsagePercent, ...targets) } : {}) };
}

/** Adds newly reported constraints and follows an explicit duration change for
 * the same provider lane. A missing lane, alias change, or ambiguous response
 * retains the old requirement. Store application must recheck the revision and
 * that no execution has ever claimed this automatic wait. */
export function planQuotaResumeBudgets(
  policy: WorkPolicy, windows: WindowAnalysis[],
  options: { afterMs: number; nowMs: number; maxAgeMs?: number },
): QuotaResumeBudgetPlan {
  const result: QuotaResumeBudgetPlan = { budgets: {}, replacements: [] };
  if (policy.provider !== "codex" || policy.purpose !== "quota-resume" || !policy.quotaResume || !policy.enabled ||
      policy.state.status !== "waiting" || policy.state.turns !== 0 || policy.state.activeExecutionId !== null) return result;
  const accountWindows = windows.filter(window => window.provider === policy.provider && window.account === policy.account);
  const scoped = workWindows(policy, accountWindows);
  for (const window of scoped) {
    if (!Number.isFinite(window.reservePercent) || window.reservePercent < 0 || window.reservePercent > 100) continue;
    const budget = { reservePercent: window.reservePercent, maxUsagePercent: 100 };
    result.budgets[window.bucket] = result.budgets[window.bucket]
      ? stricterQuotaBudget(result.budgets[window.bucket]!, budget) : budget;
  }
  if (!Number.isFinite(options.afterMs) || !Number.isFinite(options.nowMs) || options.afterMs > options.nowMs) return result;
  const maxAgeMs = options.maxAgeMs ?? 120_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return result;
  const newestAtMs = Math.max(...accountWindows.map(window => window.observedAtMs));
  for (const [previousBucket, previousBudget] of Object.entries(policy.budgetByBucket)) {
    if (accountWindows.some(window => window.bucket === previousBucket)) continue;
    const old = codexQuotaLane(previousBucket);
    if (!old) continue;
    const missingPriorLanes = Object.keys(policy.budgetByBucket).filter(bucket => {
      const lane = codexQuotaLane(bucket);
      return lane?.limitId === old.limitId && lane.lane === old.lane && !accountWindows.some(window => window.bucket === bucket);
    });
    if (missingPriorLanes.length !== 1) continue;
    // Include malformed same-lane metadata/IDs in ambiguity detection. They
    // cannot become proof merely because another row looks well formed.
    const candidates = accountWindows.filter(window => {
      const parsed = codexQuotaLane(window.bucket);
      return (parsed?.limitId === old.limitId && parsed.lane === old.lane) ||
        (window.metadata?.limitId === old.limitId && window.metadata?.lane === old.lane);
    });
    if (candidates.length !== 1) continue;
    const next = candidates[0]!, lane = codexQuotaLane(next.bucket);
    const previousAtMs = Math.max(options.afterMs, policy.state.baselines[previousBucket]?.atMs ?? -Infinity);
    if (!lane || lane.limitId !== old.limitId || lane.lane !== old.lane || lane.durationMinutes === old.durationMinutes ||
        next.metadata?.limitId !== old.limitId || next.metadata?.lane !== old.lane ||
        next.windowSeconds !== lane.durationMinutes * 60 || !result.budgets[next.bucket] ||
        next.quality !== "authoritative" || next.freshness !== "fresh" || !Number.isFinite(next.observedAtMs) ||
        next.observedAtMs !== newestAtMs || next.observedAtMs <= previousAtMs || next.observedAtMs > options.nowMs ||
        options.nowMs - next.observedAtMs > maxAgeMs ||
        next.remainingPercent === null || !Number.isFinite(next.remainingPercent) || next.remainingPercent < 0 || next.remainingPercent > 100 ||
        next.resetsAtMs === null || !Number.isFinite(next.resetsAtMs) || next.resetsAtMs <= options.nowMs) continue;
    result.budgets[next.bucket] = stricterQuotaBudget(previousBudget, result.budgets[next.bucket]!,
      ...(policy.budgetByBucket[next.bucket] ? [policy.budgetByBucket[next.bucket]!] : []));
    result.replacements.push({ previousBucket, nextBucket: next.bucket });
  }
  return result;
}
