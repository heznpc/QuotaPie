import { afterEach, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaStorage } from "../src/storage/database";
import { executeCodexWork } from "../src/work/codex";
import { workPolicyExpiresAtMs } from "../src/work/lifetime";
import { WorkStore } from "../src/work/store";
import type { WorkPolicyInput } from "../src/work/types";
import type { ResumeGate } from "../src/resume-gate";

const threadId = "11111111-1111-4111-8111-111111111111";
const failedId = "22222222-2222-4222-8222-222222222222";
const ownId = "33333333-3333-4333-8333-333333333333";
const databases: QuotaStorage[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const storage = new QuotaStorage(":memory:"); databases.push(storage);
  return { storage, store: new WorkStore(storage) };
}
function input(id = "recovery", extra: Partial<WorkPolicyInput> = {}): WorkPolicyInput {
  return { id, provider: "codex", account: "plus", accountKey: "account", profileKey: "profile", nativeSessionId: threadId,
    cwd: "/tmp", purpose: "quota-resume", quotaResume: { turnId: failedId, stamp: "snapshot" },
    prompt: "Continue the original request", objective: "Continue", completionCriteria: ["Same conversation"],
    dispatchOwner: "local", enabled: true, trigger: "quota-ready", resetWithinMinutes: 0,
    budgetByBucket: { "codex:primary": { reservePercent: 0, maxUsagePercent: 100 } },
    maxTurns: 1, maxDurationSeconds: 60, maxTotalDurationSeconds: 60, expiresAtMs: 10000,
    priority: 0, onReset: "continue", ...extra };
}

test("only explicitly marked automatic recovery has a consent lifetime", () => {
  const p = input();
  expect(workPolicyExpiresAtMs(p)).toBe(10000);
  expect(workPolicyExpiresAtMs({ ...p, quotaResume: { ...p.quotaResume!, waitUntilRecovered: true } })).toBe(Infinity);
  expect(workPolicyExpiresAtMs({ ...p, purpose: undefined, quotaResume: { ...p.quotaResume!, waitUntilRecovered: true } })).toBe(10000);
  const { store } = fixture();
  for (const invalid of [false, null, "true", 1]) {
    expect(() => store.save(input("invalid", { quotaResume: { ...p.quotaResume!, waitUntilRecovered: invalid as true } }), null, "invalid")).toThrow("work-invalid-quota-resume");
  }
});

test("authorized waiting policies can survive more than eight days without changing their saved expiry", () => {
  const { store } = fixture();
  store.save(input(), null, "create");
  store.save(input("unapproved"), null, "other");
  expect(store.claim("recovery", "local", 1, 9 * 86400000)).toBeNull();
  expect(store.migratePendingQuotaResumeLifetime(["recovery", "recovery"])).toBe(1);
  const p = store.get("recovery")!;
  expect(p.revision).toBe(2); expect(p.expiresAtMs).toBe(10000);
  expect(p.quotaResume?.waitUntilRecovered).toBe(true);
  expect(store.get("unapproved")?.quotaResume?.waitUntilRecovered).toBeUndefined();
  expect(store.migratePendingQuotaResumeLifetime(["recovery"])).toBe(0);
  const execution = store.claim("recovery", "local", 2, 40 * 86400000)!;
  expect(execution).not.toBeNull();
  expect(store.markDispatched(execution.id, 40 * 86400000 + 1).status).toBe("dispatched");
  expect(store.claim("recovery", "local", 2, 40 * 86400000 + 2)).toBeNull();
});

test("migration cannot revive disabled, attempted, active, or terminal policies", () => {
  for (const state of ["disabled", "active", "finished", "uncertain", "stopped"] as const) {
    const { storage, store } = fixture();
    store.save(input(), null, "create");
    if (state === "disabled") store.setEnabled("recovery", false, 1, "off");
    if (["active", "finished", "uncertain"].includes(state)) {
      const execution = store.claim("recovery", "local", 1, 1000)!;
      if (state !== "active") {
        store.markDispatched(execution.id, 1001);
        store.finish(execution.id, state === "uncertain" ? { status: "uncertain" } : { status: "quota-blocked" }, 1002);
      }
    }
    if (state === "stopped") {
      const p = store.get("recovery")!; p.state.status = "stopped";
      storage.db.query("UPDATE work_policies SET value=? WHERE id=?").run(JSON.stringify(p), p.id);
    }
    const before = store.get("recovery");
    expect(store.migratePendingQuotaResumeLifetime(["recovery"])).toBe(0);
    expect(store.get("recovery")).toEqual(before);
  }
});

test("consent lifetime retains explicit work deadlines and duration limits", async () => {
  const { store } = fixture();
  const p = store.save(input("recovery", { quotaResume: { turnId: failedId, stamp: "snapshot", waitUntilRecovered: true } }), null, "create");
  const began = Date.now();
  let called = false;
  const result = await executeCodexWork(DEFAULT_CONFIG, p, ownId, () => true, () => ({} as ResumeGate), async ({ policy }) => {
    called = true;
    expect(policy.maxDurationSeconds).toBe(60);
    expect(Number.isFinite(policy.expiresAtMs)).toBe(true);
    expect(policy.expiresAtMs).toBeGreaterThanOrEqual(began + 59000);
    expect(policy.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60000);
    return { nativeThreadId: threadId, outcome: "completed", reason: "turn-completed", attempts: 1 };
  });
  expect(called).toBe(true); expect(result.status).toBe("turn-finished");
  const blocked = fixture().store;
  blocked.save(input("deadline", { workDeadline: 10000, quotaResume: { turnId: failedId, stamp: "snapshot", waitUntilRecovered: true } }), null, "create");
  expect(blocked.claim("deadline", "local", 1, 10001)).toBeNull();
});

test("new quota lanes narrow only untouched recovery and do not erase existing budgets", () => {
  const { store } = fixture(); store.save(input(), null, "create");
  const budgets = { "codex:primary": { reservePercent: 99, maxUsagePercent: 1 }, "gpt-6:weekly": { reservePercent: 5, maxUsagePercent: 100 } };
  const changed = store.refreshQuotaResumeBudgets("recovery", budgets)!;
  expect(changed.revision).toBe(2);
  expect(changed.budgetByBucket["codex:primary"]).toEqual({ reservePercent: 0, maxUsagePercent: 100 });
  expect(changed.budgetByBucket["gpt-6:weekly"]).toEqual(budgets["gpt-6:weekly"]);
  expect(store.refreshQuotaResumeBudgets("recovery", {})?.revision).toBe(2);
  expect(() => store.refreshQuotaResumeBudgets("recovery", { bad: { reservePercent: -1, maxUsagePercent: 100 } })).toThrow();
  expect(store.get("recovery")!.revision).toBe(2);
  const execution = store.claim("recovery", "local", 2, 1000)!;
  expect(store.refreshQuotaResumeBudgets("recovery", { "codex:new": { reservePercent: 0, maxUsagePercent: 100 } })).toBeNull();
  expect(store.getExecution(execution.id)!.policySnapshot.budgetByBucket).toEqual(changed.budgetByBucket);
});

test("managed native-turn proof is immutable, distinct from the failed turn, and cannot mix host delivery", () => {
  const { store } = fixture(); store.save(input(), null, "create");
  const execution = store.claim("recovery", "local", 1, 1000)!;
  const receipt = { threadId, turnId: ownId };
  expect(() => store.recordManagedTurn(execution.id, receipt)).toThrow("work-managed-turn-receipt-invalid");
  store.markDispatched(execution.id, 1001);
  expect(() => store.recordManagedTurn(execution.id, { threadId, turnId: failedId })).toThrow();
  expect(() => store.recordManagedTurn(execution.id, { threadId: ownId, turnId: ownId })).toThrow();
  store.recordManagedTurn(execution.id, receipt);
  expect(store.getExecution(execution.id)?.managedTurn).toEqual(receipt);
  store.recordManagedTurn(execution.id, receipt);
  expect(() => store.recordManagedTurn(execution.id, { threadId, turnId: "44444444-4444-4444-8444-444444444444" })).toThrow("work-managed-turn-receipt-conflict");
  expect(() => store.recordHostQueue(execution.id, { threadId, clientUserMessageId: ownId, sentAtMs: 1002 })).toThrow();
  store.finish(execution.id, { status: "uncertain" }, 1003);
  store.recordManagedTurn(execution.id, receipt);
  store.reconcile(execution.id, { status: "quota-blocked" }, 1004);
  expect(() => store.recordManagedTurn(execution.id, receipt)).toThrow();
});

test("a later quota reset preserves the terminal automatic attempt for chain ownership", () => {
  const { store } = fixture(); store.save(input(), null, "create");
  store.observe("recovery", { id: "before", atMs: 1000, buckets: { "codex:primary": { remainingPercent: 50, epoch: "first" } } });
  const execution = store.claim("recovery", "local", 1, 1001)!;
  store.markDispatched(execution.id, 1002);
  store.recordManagedTurn(execution.id, { threadId, turnId: ownId });
  store.finish(execution.id, { status: "quota-blocked" }, 1003);
  store.observe("recovery", { id: "after", atMs: 2000, buckets: { "codex:primary": { remainingPercent: 100, epoch: "second" } } });
  expect(store.get("recovery")?.state.status).toBe("quota-blocked");
  expect(store.get("recovery")?.enabled).toBe(false);
  expect(store.getExecution(execution.id)?.managedTurn).toEqual({ threadId, turnId: ownId });
  expect(store.getExecution(execution.id)?.result?.status).toBe("quota-blocked");
});

test("explicit same-lane duration replacement preserves stricter limits and requires an untouched revision", () => {
  const { store } = fixture();
  store.save(input("recovery", { budgetByBucket: { "codex:primary:300": { reservePercent: 15, maxUsagePercent: 30, targetUsagePercent: 20 } } }), null, "create");
  const budgets = { "codex:primary:600": { reservePercent: 5, maxUsagePercent: 100, targetUsagePercent: 50 } };
  const replacements = [{ previousBucket: "codex:primary:300", nextBucket: "codex:primary:600" }];
  expect(() => store.refreshQuotaResumeBudgets("recovery", budgets, { replacements })).toThrow("work-quota-budget-replacement-invalid");
  expect(store.refreshQuotaResumeBudgets("recovery", budgets, { replacements, expectedRevision: 2 })).toBeNull();
  expect(() => store.refreshQuotaResumeBudgets("recovery", budgets, { replacements: [...replacements, ...replacements], expectedRevision: 1 })).toThrow();
  const p = store.refreshQuotaResumeBudgets("recovery", budgets, { replacements, expectedRevision: 1 })!;
  expect(p.budgetByBucket).toEqual({ "codex:primary:600": { reservePercent: 15, maxUsagePercent: 30, targetUsagePercent: 20 } });
  expect(p.revision).toBe(2);
  store.claim("recovery", "local", 2, 1000);
  expect(store.refreshQuotaResumeBudgets("recovery", { "codex:primary:1200": budgets["codex:primary:600"] },
    { replacements: [{ previousBucket: "codex:primary:600", nextBucket: "codex:primary:1200" }], expectedRevision: 2 })).toBeNull();
});

test("a model, alias, or lane change cannot delete a required quota budget", () => {
  for (const nextBucket of ["codex:secondary:600", "gpt-6:primary:600", "codex:primary:300", "unparsed"]) {
    const { store } = fixture();
    store.save(input("recovery", { budgetByBucket: { "codex:primary:300": { reservePercent: 0, maxUsagePercent: 100 } } }), null, "create");
    expect(() => store.refreshQuotaResumeBudgets("recovery", { [nextBucket]: { reservePercent: 0, maxUsagePercent: 100 } },
      { replacements: [{ previousBucket: "codex:primary:300", nextBucket }], expectedRevision: 1 })).toThrow("work-quota-budget-replacement-invalid");
    expect(Object.keys(store.get("recovery")!.budgetByBucket)).toEqual(["codex:primary:300"]);
  }
});
