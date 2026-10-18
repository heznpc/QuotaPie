import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaStorage } from "../src/storage/database";
import { WorkStore } from "../src/work/store";
import type { WorkPolicyInput } from "../src/work/types";

const connections: QuotaStorage[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function store(path = ":memory:") { const db = new QuotaStorage(path); connections.push(db); return new WorkStore(db); }
function input(overrides: Partial<WorkPolicyInput> = {}): WorkPolicyInput {
  return { id: "work", provider: "claude", account: "default", accountKey: "identity-a", profileKey: "profile-a", nativeSessionId: "session-a", cwd: "/tmp",
    prompt: "Implement the small task", objective: "Complete the task", completionCriteria: ["Targeted check passes"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetWithinMinutes: 60, resetBucket: "weekly", budgetByBucket: { weekly: { reservePercent: 0, maxUsagePercent: 20 }, session: { reservePercent: 5, maxUsagePercent: 30 } },
    maxTurns: 3, maxDurationSeconds: 60, maxTotalDurationSeconds: 180, expiresAtMs: 1_000_000, priority: 0, onReset: "stop", ...overrides };
}

describe("shared work policy and execution ledger", () => {
  test("host queue intent survives restart and cannot change identity or clear an uncertain fence", () => {
    const dir=mkdtempSync(join(tmpdir(),"quotapie-host-queue-ledger-")); directories.push(dir);
    const a=store(join(dir,"quota.sqlite3")), b=store(join(dir,"quota.sqlite3"));
    const thread="11111111-2222-4333-8444-555555555555", turn="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    a.save(input({provider:"codex",purpose:"quota-resume",nativeSessionId:thread,quotaResume:{turnId:turn,stamp:"stable"},maxTurns:1}),null,"create");
    const e=a.claim("work","local",1,1000)!;
    const intent={threadId:thread,clientUserMessageId:e.id,sentAtMs:1002};
    expect(()=>a.recordHostQueue(e.id,intent)).toThrow();
    a.markDispatched(e.id,1001); a.recordHostQueue(e.id,intent);
    expect(b.getExecution(e.id)?.hostQueue).toEqual(intent);
    a.finish(e.id,{status:"uncertain",reason:"host-queue-ack-unverified"},1010);
    expect(b.claim("work","local",b.get("work")!.revision,1011)).toBeNull();
    const receipt={...intent,queuedSubmissionId:turn,turnId:thread};
    b.recordHostQueue(e.id,receipt);
    expect(()=>a.recordHostQueue(e.id,{...receipt,clientUserMessageId:"different"})).toThrow("work-host-queue-receipt-conflict");
    expect(()=>a.recordHostQueue(e.id,intent)).toThrow("work-host-queue-receipt-conflict");
    expect(a.get("work")!.state.activeExecutionId).toBe(e.id);
    a.reconcile(e.id,{status:"turn-finished",summary:"Correlated host turn finished",remainingWork:"Goal completion unverified"},2000);
    expect(b.getExecution(e.id)?.hostQueue).toEqual(receipt);
    expect(b.get("work")!.state.activeExecutionId).toBeNull();
    expect(b.get("work")!.state.turns).toBe(1);
  });
  test("equal-priority policies retain registration order across revisions", () => {
    const s = store();
    s.save(input({ id: "z-first" }), null, "first");
    s.save(input({ id: "a-second" }), null, "second");
    s.setEnabled("z-first", false, 1, "update-first");
    expect(s.list().map(policy => policy.id)).toEqual(["z-first", "a-second"]);
  });
  test("both connections share revision conflicts and idempotent writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-work-")); directories.push(dir);
    const first = store(join(dir, "quota.sqlite3")), second = store(join(dir, "quota.sqlite3"));
    const saved = first.save(input(), null, "create");
    expect(second.get("work")).toEqual(saved);
    expect(second.save(input(), null, "create")).toEqual(saved);
    expect(() => second.save(input({ prompt: "Different" }), null, "create")).toThrow("work-request-id-reused");
    const changed = second.setEnabled("work", false, 1, "disable");
    expect(changed.revision).toBe(2);
    expect(() => first.save(input(), 1, "stale")).toThrow("work-revision-conflict");
    expect(first.get("work")?.enabled).toBe(false);
  });
  test("account claims serialize Dots and local dispatch across database connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-work-")); directories.push(dir);
    const first = store(join(dir, "quota.sqlite3")), second = store(join(dir, "quota.sqlite3"));
    first.save(input(), null, "local");
    first.save(input({ id: "dot-work", nativeSessionId: "different-session", dispatchOwner: "dots" }), null, "dots");
    const claim = first.claim("work", "local", 1, 1_000)!;
    expect(second.claim("dot-work", "dots", 1, 1_000)).toBeNull();
    expect(second.claim("work", "local", 1, 1_000)).toBeNull();
    first.markDispatched(claim.id, 1_001);
    expect(second.claim("dot-work", "dots", 1, 999_000)).toBeNull();
    first.finish(claim.id, { status: "turn-finished", remainingWork: "Finish remaining assertions" }, 2_001);
    expect(second.claim("dot-work", "dots", 1, 2_002)).not.toBeNull();
  });
  test("dispatch retries share an atomic durable request association even after completion", () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-work-")); directories.push(dir);
    const first = store(join(dir, "quota.sqlite3")), second = store(join(dir, "quota.sqlite3"));
    first.save(input(), null, "create");
    const original = first.claimRequest("work", "local", 1, "dispatch-once", 1_000);
    expect(original.created).toBe(true);
    const duplicate = second.claimRequest("work", "local", 1, "dispatch-once", 1_001);
    expect(duplicate.created).toBe(false);
    expect(duplicate.execution?.id).toBe(original.execution!.id);
    first.markDispatched(original.execution!.id, 1_002);
    first.finish(original.execution!.id, { status: "turn-finished", remainingWork: "More work" }, 2_002);
    expect(second.claimRequest("work", "local", 1, "dispatch-once", 3_000).execution?.status).toBe("finished");
    expect(second.executions()).toHaveLength(1);
    expect(() => second.getClaimRequest("work", "dots", 1, "dispatch-once")).toThrow("work-request-id-reused");
  });
  test("per-bucket spending excludes duplicate, reversed, and reset-crossing observations", () => {
    const s = store(); s.save(input({ onReset: "continue", budgetByBucket: { weekly: { reservePercent: 0, maxUsagePercent: 4 }, session: { reservePercent: 0, maxUsagePercent: 4 } } }), null, "create");
    s.observe("work", { id: "a", atMs: 100, buckets: { weekly: { remainingPercent: 80, epoch: "w1" }, session: { remainingPercent: 80, epoch: "s1" } } });
    const first = s.claim("work", "local", 1, 101)!;
    s.markDispatched(first.id, 101);
    s.observe("work", { id: "b", atMs: 200, buckets: { weekly: { remainingPercent: 78, epoch: "w1" } } });
    s.observe("work", { id: "c", atMs: 300, buckets: { session: { remainingPercent: 77, epoch: "s1" } } });
    s.observe("work", { id: "c", atMs: 301, buckets: { session: { remainingPercent: 75, epoch: "s1" } } });
    s.observe("work", { id: "old", atMs: 150, buckets: { weekly: { remainingPercent: 20, epoch: "w1" } } });
    expect(s.get("work")?.state.spentByBucket).toEqual({ weekly: 2, session: 3 });
    s.observe("work", { id: "reset", atMs: 400, buckets: { weekly: { remainingPercent: 75, epoch: "w2" } } });
    s.observe("work", { id: "post-reset", atMs: 500, buckets: { weekly: { remainingPercent: 74, epoch: "w2" } } });
    expect(s.get("work")?.state.spentByBucket).toEqual({ weekly: 3, session: 3 });
    s.finish(first.id, { status: "activity-paused" }, 550);
    // The unrelated 3pp budgets must never become a synthetic 6pp budget.
    const execution = s.claim("work", "local", 1, 600)!;
    expect(execution).not.toBeNull();
    s.finish(execution.id, { status: "activity-paused" }, 600);
    s.observe("work", { id: "cap", atMs: 700, buckets: { weekly: { remainingPercent: 73, epoch: "w2" } } });
    expect(s.claim("work", "local", 1, 800)).toBeNull();
  });
  test("uncertain dispatched work never replays and reconciliation preserves time budget", () => {
    const s = store(); s.save(input(), null, "create");
    const execution = s.claim("work", "local", 1, 1_000)!;
    s.markDispatched(execution.id, 1_000);
    s.finish(execution.id, { status: "uncertain", reason: "Output missing" }, 2_000);
    expect(s.claim("work", "local", 1, 500_000)).toBeNull();
    s.reconcile(execution.id, { status: "activity-paused", reason: "Owned process confirmed stopped" }, 4_000);
    expect(s.get("work")?.state.totalDurationSeconds).toBe(3);
    expect(s.claim("work", "local", 1, 5_000)?.turnOrdinal).toBe(2);
  });
  test("turn end keeps authorization and objective completion stops it with immutable evidence", () => {
    const s = store(); s.save(input(), null, "create");
    const execution = s.claim("work", "local", 1, 1_000)!;
    s.markDispatched(execution.id, 1_000);
    expect(() => s.finish(execution.id, { status: "turn-finished" }, 2_000)).toThrow("work-remaining-work-required");
    s.finish(execution.id, { status: "turn-finished", remainingWork: "Run verification" }, 2_000);
    expect(s.get("work")?.enabled).toBe(true);
    const next = s.claim("work", "local", 1, 3_000)!;
    expect(next.turnOrdinal).toBe(2);
    s.markDispatched(next.id, 3_000);
    const result = { status: "objective-completed" as const, evidenceRefs: ["artifact:test-result"], completionAssessment: "machine" as const };
    const finished = s.finish(next.id, result, 4_000);
    expect(s.finish(next.id, result, 5_000)).toEqual(finished);
    expect(s.get("work")?.enabled).toBe(false);
    expect(s.get("work")?.state.totalDurationSeconds).toBe(2);
    expect(() => s.finish(next.id, { status: "failed" })).toThrow("work-result-already-recorded");
    expect(() => s.setEnabled("work", true, 2, "restart")).toThrow("work-needs-review");
  });
  test("legacy identity aliases fence new claims and only explicit release removes the fence", () => {
    const s = store(); s.save(input(), null, "create");
    s.fenceLegacy({ id: "legacy-dot", provider: "claude", account: "default", accountKey: "old-hash", nativeSessionId: "old-session", reason: "outcome unknown" });
    expect(s.claim("work", "local", 1, 1_000)).toBeNull();
    s.releaseLegacy("legacy-dot");
    expect(s.claim("work", "local", 1, 1_000)).not.toBeNull();
  });
  test("only selected bucket resets stop the policy; accumulated spending survives reset", () => {
    const s = store(); s.save(input(), null, "create");
    s.observe("work", { id: "a", atMs: 100, buckets: { weekly: { remainingPercent: 80, epoch: "w1" }, session: { remainingPercent: 80, epoch: "s1" } } });
    const first = s.claim("work", "local", 1, 101)!;
    s.markDispatched(first.id, 101);
    s.observe("work", { id: "b", atMs: 200, buckets: { weekly: { remainingPercent: 75, epoch: "w1" }, session: { remainingPercent: 100, epoch: "s2" } } });
    expect(s.get("work")?.enabled).toBe(true);
    s.observe("work", { id: "c", atMs: 300, buckets: { weekly: { remainingPercent: 100, epoch: "w2" } } });
    expect(s.get("work")?.enabled).toBe(false);
    expect(s.get("work")?.state.spentByBucket.weekly).toBe(5);
  });
  test("pre-dispatch changes only update baseline; disabling still accounts the owned stopping run", () => {
    const s = store(); s.save(input(), null, "create");
    const observation = (id: string, atMs: number, remainingPercent: number) => ({ id, atMs, buckets: { weekly: { remainingPercent, epoch: "w1" } } });
    s.observe("work", observation("a", 100, 90));
    s.observe("work", observation("b", 200, 70));
    expect(s.get("work")?.state.spentByBucket).toEqual({});
    const execution = s.claim("work", "local", 1, 201)!;
    expect(execution.policySnapshot.state.baselines.weekly?.remainingPercent).toBe(70);
    s.markDispatched(execution.id, 201);
    s.observe("work", observation("c", 300, 65));
    expect(s.get("work")?.state.spentByBucket.weekly).toBe(5);
    s.setEnabled("work", false, 1, "stop");
    s.observe("work", observation("d", 400, 50));
    expect(s.get("work")?.state.spentByBucket.weekly).toBe(20);
    expect(s.get("work")?.state.baselines.weekly?.remainingPercent).toBe(50);
    s.finish(execution.id, { status: "activity-paused" }, 450);
    s.observe("work", observation("final", 500, 49));
    expect(s.get("work")?.state.spentByBucket.weekly).toBe(21);
    expect(s.get("work")?.state.observationCoverageByBucket?.weekly?.lastActiveObservationAtMs).toBe(400);
    expect(s.get("work")?.state.observationCoverageByBucket?.weekly?.accountingClosedAtMs).toBe(500);
    s.observe("work", observation("unrelated", 600, 30));
    expect(s.get("work")?.state.spentByBucket.weekly).toBe(21);
  });
  test("reset closure freezes per-epoch account usage separately from cumulative usage", () => {
    const s = store(); s.save(input({ onReset: "continue" }), null, "create");
    const sample = (id: string, atMs: number, remainingPercent: number, epoch: string) => ({ id, atMs, buckets: { weekly: { remainingPercent, epoch } } });
    s.observe("work", sample("baseline", 100, 80, "w1"));
    const execution = s.claim("work", "local", 1, 101)!; s.markDispatched(execution.id, 101);
    s.observe("work", sample("first-use", 200, 77, "w1"));
    s.observe("work", sample("reset1", 300, 100, "w2"));
    expect(s.get("work")?.state.observationCoverageByBucket?.weekly?.lastReset?.preResetAccountUsage).toBe(3);
    s.observe("work", sample("second-use", 400, 96, "w2"));
    s.observe("work", sample("reset2", 500, 100, "w3"));
    expect(s.get("work")?.state.spentByBucket.weekly).toBe(7);
    expect(s.get("work")?.state.observationCoverageByBucket?.weekly?.lastReset?.preResetAccountUsage).toBe(4);
  });
  test("stop without a selected reset bucket applies to every budgeted bucket", () => {
    const s = store(); s.save(input({ resetBucket: undefined }), null, "create");
    s.observe("work", { id: "a", atMs: 100, buckets: { session: { remainingPercent: 80, epoch: "s1" } } });
    s.observe("work", { id: "b", atMs: 200, buckets: { session: { remainingPercent: 100, epoch: "s2" } } });
    expect(s.get("work")?.enabled).toBe(false);
  });
  test("explicit reviewed enable resumes failures or input waits without resetting consumed budgets", () => {
    for (const status of ["failed", "needs-user-input", "time-budget-ended"] as const) {
      const s = store(); s.save(input(), null, "create");
      const execution = s.claim("work", "local", 1, 100)!;
      s.markDispatched(execution.id, 100);
      s.finish(execution.id, { status, report: "Stopped at this step" }, 1100);
      expect(s.claim("work", "local", 1, 1200)).toBeNull();
      const resumed = s.setEnabled("work", true, 1, "explicit-resume");
      expect(resumed.state.status).toBe("waiting");
      expect(resumed.state.lastResult?.status).toBe(status);
      expect(resumed.state.turns).toBe(1);
      expect(resumed.state.totalDurationSeconds).toBe(1);
      expect(s.claim("work", "local", 2, 1200)).not.toBeNull();
    }
  });
  test("zero reserve is allowed but cap and revision changes still gate dispatch", () => {
    const s = store(); s.save(input(), null, "create");
    s.observe("work", { id: "a", atMs: 100, buckets: { weekly: { remainingPercent: 10, epoch: "w1" } } });
    const claim = s.claim("work", "local", 1, 1_000)!;
    expect(claim).not.toBeNull();
    s.setEnabled("work", false, 1, "stop");
    expect(() => s.markDispatched(claim.id, 1_001)).toThrow("work-policy-changed-before-dispatch");
    expect(claim.policySnapshot.enabled).toBe(true);
    expect(s.get("work")?.state.turns).toBe(0);
  });
});
test("observations freeze per-execution minima and distinguish epoch changes from actual recoveries",()=>{
 const s=store();s.save(input({onReset:"continue"}),null,"save");
 s.observe("work",{id:"before",atMs:100,buckets:{weekly:{remainingPercent:50,epoch:"old"}}});
 const e=s.claim("work","local",1,101)!;s.markDispatched(e.id,102);
 s.observe("work",{id:"spent",atMs:110,buckets:{weekly:{remainingPercent:45,epoch:"old"}}});
 expect(s.getExecution(e.id)!.minimumRemainingByBucket?.weekly).toBe(45);
 s.observe("work",{id:"epoch",atMs:120,buckets:{weekly:{remainingPercent:45,epoch:"changed"}}});
 expect(s.get("work")!.state.observationCoverageByBucket!.weekly!.lastReset!.evidence).toBe("epoch-change");
 s.observe("work",{id:"recovery",atMs:130,buckets:{weekly:{remainingPercent:100,epoch:"changed"}}});
 expect(s.get("work")!.state.observationCoverageByBucket!.weekly!.lastReset!.evidence).toBe("quota-recovery");
 expect(s.getExecution(e.id)!.minimumRemainingByBucket?.weekly).toBe(45);
});
