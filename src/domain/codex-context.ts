import type { QuotaObservation } from "../types";

/** Only comparable within one resident collector; a restart is not an account switch. */
export function codexContextChange(previous: QuotaObservation | undefined, next: QuotaObservation): "account_changed" | "plan_changed" | null {
  const before = previous?.metadata, after = next.metadata;
  if (!before?.contextSession || before.contextSession !== after?.contextSession ||
      !before.accountContext || !after?.accountContext) return null;
  if (before.accountContext !== after.accountContext) return "account_changed";
  if (before.planType && after.planType && before.planType !== after.planType) return "plan_changed";
  return null;
}
