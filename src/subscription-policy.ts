import type { PoolPolicy } from "./account-pool";

/** Forecast headroom is advisory. Only the explicit, enabled account control
 * is an execution cutoff; absent/zero means use the subscription to exhaustion. */
export function explicitAccountReserve(account: string, policy: PoolPolicy): number {
  const value = policy.enabled && policy.reservePercent && Object.hasOwn(policy.reservePercent, account)
    ? policy.reservePercent[account]! : 0;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("reserve-invalid");
  return value;
}
