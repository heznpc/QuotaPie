import type { WorkPolicyInput } from "./types";

/** Automatic recovery waits for capacity while consent remains valid. This
 * removes only its waiting deadline; each dispatch still has a finite duration
 * and retains goal, account, consent, and durable execution guards. */
export function workPolicyExpiresAtMs(
  policy: Pick<WorkPolicyInput, "purpose" | "quotaResume" | "expiresAtMs">,
): number {
  return policy.purpose === "quota-resume" && policy.quotaResume?.waitUntilRecovered === true
    ? Infinity : policy.expiresAtMs;
}
