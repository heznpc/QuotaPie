import { expect, test } from "bun:test";
import { createCompactionHandler } from "../src/codex-compaction";
import { PoolError } from "../src/account-pool";
import type { ExecutionTargetRelay } from "../src/execution-target-relay";
import type { SubscriptionGuard, SubscriptionGuardState } from "../src/subscription-guard";

const ready: SubscriptionGuardState = { version: 1, account: "fixture", profileKey: "fixture-profile",
  ready: true, reason: "ready", checkedAtMs: 1, windows: [], sourceIdentity: "fixture-identity" };

const reasons = [
  ["guard-unavailable", "local account protection settings"],
  ["quota-observation-unavailable", "local quota observation"],
  ["budget-baseline-invalid", "invalid quota budget"],
  ["budget-baseline-changed", "quota period changed"],
  ["pool_source_continuation_unavailable", "local account ownership record"],
  ["pool_execution_target_conflict", "conflicting saved automatic continuation attempts"],
  ["pool_execution_target_message_unverified", "official host turn receipt"],
  ["pool_execution_target_expired", "authorization for this automatic continuation expired"],
  ["pool_execution_target_unavailable", "saved automatic continuation could not be read"],
  ["execution-target-unavailable", "account binding could not be read"],
] as const;

for (const path of ["/responses", "/responses/compact"]) {
  for (const [reason, explanation] of reasons) test(`${path} explains ${reason} without dispatch or fallback`, async () => {
    let calls = 0;
    const isTarget = reason.includes("execution_target") || reason.startsWith("execution-target");
    const state = isTarget ? ready : { ...ready, ready: false, reason };
    const guard: SubscriptionGuard = { intervalMs: 1000, check: () => state, checkIdentity: () => state };
    const target = isTarget ? { resolve: async () => {
      if (reason.startsWith("pool_")) throw new PoolError(reason, 409);
      throw new Error("private internal exception must not reach the user");
    } } as unknown as ExecutionTargetRelay : undefined;
    const relay = createCompactionHandler({ executionMode: "interactive", subscriptionGuard: guard,
      executionTargetRelay: target,
      route: { from: "gpt-6-astra", to: "gpt-6-astra" },
      fetchUpstream: async () => { calls++; return Response.json({ output: [] }); } });
    const response = await relay.fetch(new Request(`http://localhost${relay.prefix}${path}`, {
      method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: [{ role: "user", content: "fixture" }] }),
    }));
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error.code).toBe("subscription_" + reason.replace(/^subscription-/, "").replaceAll("-", "_"));
    expect(result.error.message).toContain(explanation);
    expect(result.error.message).not.toContain("Subscription protection could not be verified for this request");
    expect(result.error.message).not.toContain("private internal exception");
    expect(result.error.message).toContain("No other account or paid fallback was used.");
    expect(calls).toBe(0);
  });
}
