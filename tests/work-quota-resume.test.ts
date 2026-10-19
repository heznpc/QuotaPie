import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { ManagedContinuationResult, runManagedContinuation } from "../src/dots/managed-continuation";
import type { ResumeGate } from "../src/resume-gate";
import { QuotaStorage } from "../src/storage/database";
import { executeCodexWork } from "../src/work/codex";
import { WorkStore } from "../src/work/store";
import type { WorkPolicy, WorkPolicyInput, WorkResult } from "../src/work/types";

const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const nextTurnId = "33333333-3333-4333-8333-333333333333";
const evidence = { turnId, stamp: "verified-quota-terminal-snapshot" };
const databases: QuotaStorage[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function store(path = ":memory:") {
  const db = new QuotaStorage(path); databases.push(db);
  return new WorkStore(db);
}
function input(overrides: Partial<WorkPolicyInput> = {}): WorkPolicyInput {
  return { id: "quota-incident", provider: "codex", account: "plus", accountKey: "account-a", profileKey: "profile-a",
    nativeSessionId: threadId, cwd: "/tmp", purpose: "quota-resume", quotaResume: evidence,
    prompt: "한도로 중단된 기존 요청을 한 턴 이어가세요.\n사용자에게 추가 입력이 필요하면 멈추세요.",
    objective: "한도로 중단된 기존 요청 한 턴 이어가기", completionCriteria: ["같은 세션의 한 번의 실행이 종료됨"],
    dispatchOwner: "local", enabled: true, trigger: "quota-ready", resetWithinMinutes: 60,
    budgetByBucket: { weekly: { reservePercent: 5, maxUsagePercent: 20 } },
    maxTurns: 1, maxDurationSeconds: 60, maxTotalDurationSeconds: 60, expiresAtMs: 1_000_000,
    priority: 0, onReset: "continue", ...overrides };
}
function executable(overrides: Partial<WorkPolicyInput> = {}): WorkPolicy {
  return store().save(input({ expiresAtMs: Date.now() + 120_000, ...overrides }), null, "create");
}
const gate: ResumeGate = { schemaVersion: 1, provider: "codex", account: "plus", accountKey: "account-a", profileKey: "profile-a",
  ready: true, reason: "ready", checkedAtMs: 1_000, retryAtMs: null, windows: [] };
const completed: ManagedContinuationResult = { nativeThreadId: threadId, outcome: "completed", reason: "turn-completed", attempts: 1, report: "Original answer" };

describe("single quota-resume work policy", () => {
  test("requires evidence and the one-turn local Codex quota trigger", () => {
    const s = store();
    const invalid: Partial<WorkPolicyInput>[] = [
      { quotaResume: undefined }, { purpose: undefined }, { maxTurns: 2 }, { provider: "claude" },
      { dispatchOwner: "dots" }, { trigger: "scheduled" },
      { quotaResume: { turnId: "not-a-turn-id", stamp: "snapshot" } },
      { quotaResume: { turnId, stamp: " " } }, { quotaResume: { turnId, stamp: "snapshot\nchanged" } },
      { quotaResume: { turnId, stamp: "x".repeat(4097) } },
    ];
    for (const [index, override] of invalid.entries()) {
      expect(() => s.save(input(override), null, `invalid-${index}`)).toThrow("work-invalid-quota-resume");
    }
    expect(() => s.save(input({ purpose: "ordinary" as "quota-resume" }), null, "unknown-purpose")).toThrow("work-invalid-purpose");
    expect(s.save(input(), null, "valid").quotaResume).toEqual(evidence);
    expect(s.save(input({ id: "legacy", purpose: undefined, quotaResume: undefined, maxTurns: 3 }), null, "legacy").maxTurns).toBe(3);
  });

  test("a claimed or uncertain execution cannot change its purpose or quota incident", () => {
    for (const phase of ["claimed", "dispatched", "uncertain"] as const) {
      const s = store(); s.save(input(), null, "create");
      const execution = s.claim("quota-incident", "local", 1, 1_000)!;
      if (phase !== "claimed") s.markDispatched(execution.id, 1_001);
      if (phase === "uncertain") s.finish(execution.id, { status: "uncertain", reason: "result-unverified" }, 1_002);
      const revision = s.get("quota-incident")!.revision;
      for (const [index, override] of [
        { purpose: undefined, quotaResume: undefined },
        { quotaResume: { turnId: nextTurnId, stamp: evidence.stamp } },
        { quotaResume: { turnId, stamp: "different-terminal" } },
      ].entries()) expect(() => s.save(input(override), revision, `change-${index}`)).toThrow("work-active-binding-change");
      expect(s.get("quota-incident")?.quotaResume).toEqual(evidence);
      expect(s.getExecution(execution.id)?.policySnapshot.quotaResume).toEqual(evidence);
    }
  });

  test("claim and dispatch consumption survive reopening without permitting a second attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "quotapie-quota-resume-")); directories.push(directory);
    const path = join(directory, "quota.sqlite3");
    const first = store(path); first.save(input(), null, "create");
    const initial = first.claimRequest("quota-incident", "local", 1, "dispatch-once", 1_000);
    const reopened = store(path);
    expect(reopened.claimRequest("quota-incident", "local", 1, "dispatch-once", 1_001).execution?.id).toBe(initial.execution!.id);
    expect(reopened.claim("quota-incident", "local", 1, 1_001)).toBeNull();
    first.markDispatched(initial.execution!.id, 1_002);
    first.finish(initial.execution!.id, { status: "turn-finished", remainingWork: "Goal completion remains unverified" }, 2_002);
    expect(reopened.get("quota-incident")?.state.turns).toBe(1);
    expect(reopened.get("quota-incident")?.enabled).toBe(false);
    expect(reopened.get("quota-incident")?.state.status).toBe("turn-finished");
    expect(reopened.claimRequest("quota-incident", "local", 1, "dispatch-once", 3_000).created).toBe(false);
    expect(reopened.claimRequest("quota-incident", "local", 2, "different-request", 3_000).execution).toBeNull();
    const enabled = reopened.setEnabled("quota-incident", true, 2, "re-enable");
    expect(reopened.claim("quota-incident", "local", enabled.revision, 3_001)).toBeNull();
    expect(reopened.executions()).toHaveLength(1);
  });

  test("quota recovery and explicit re-enable do not refund an attempted incident", () => {
    for (const result of [
      { status: "quota-blocked", reason: "upstream-quota-hold" },
      { status: "failed", reason: "process-failed" },
      { status: "activity-paused", reason: "user-disabled" },
    ] satisfies WorkResult[]) {
      const s = store(); s.save(input(), null, "create");
      s.observe("quota-incident", { id: "before", atMs: 900, buckets: { weekly: { remainingPercent: 20, epoch: "old" } } });
      const execution = s.claim("quota-incident", "local", 1, 1_000)!;
      s.markDispatched(execution.id, 1_001); s.finish(execution.id, result, 2_001);
      expect(s.get("quota-incident")?.enabled).toBe(false);
      expect(s.get("quota-incident")?.state.status).toBe(result.status);
      s.observe("quota-incident", { id: "recovery", atMs: 3_000, buckets: { weekly: { remainingPercent: 100, epoch: "new" } } });
      const enabled = s.setEnabled("quota-incident", true, 2, "re-enable");
      expect(s.get("quota-incident")?.state.turns).toBe(1);
      expect(s.claim("quota-incident", "local", enabled.revision, 3_001)).toBeNull();
    }
  });

  test("uncertain execution remains fenced after restart and reconciliation cannot replay it", () => {
    const directory = mkdtempSync(join(tmpdir(), "quotapie-quota-uncertain-")); directories.push(directory);
    const path = join(directory, "quota.sqlite3");
    const first = store(path); first.save(input(), null, "create");
    const execution = first.claim("quota-incident", "local", 1, 1_000)!;
    first.markDispatched(execution.id, 1_001); first.finish(execution.id, { status: "uncertain" }, 2_001);
    const reopened = store(path);
    expect(reopened.get("quota-incident")?.state.activeExecutionId).toBe(execution.id);
    expect(reopened.get("quota-incident")?.enabled).toBe(false);
    expect(reopened.get("quota-incident")?.state.status).toBe("uncertain");
    expect(reopened.claim("quota-incident", "local", 2, 3_000)).toBeNull();
    expect(() => reopened.setEnabled("quota-incident", true, 2, "re-enable")).toThrow("work-needs-review");
    reopened.reconcile(execution.id, { status: "activity-paused", reason: "owned-process-stopped" }, 3_001);
    expect(reopened.claim("quota-incident", "local", 2, 3_002)).toBeNull();
  });
});

describe("quota-resume Codex adapter", () => {
  test("forwards the final host-goal veto without changing the sixth injected runner argument", async () => {
    const policy = executable(); let checked = 0;
    const beforeSpawn = async () => { checked++; };
    const run: typeof runManagedContinuation = async (_request, options) => {
      expect(options.beforeSpawn).toBe(beforeSpawn);
      await options.beforeSpawn!();
      return { ...completed, outcome: "failed", attempts: 0, reason: "host-goal-not-active" };
    };
    expect(await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, run, beforeSpawn))
      .toMatchObject({ status: "failed", reason: "host-goal-not-active" });
    expect(checked).toBe(1);
  });

  test("preserves the reviewed prompt and identity, forwards evidence and budgets, and never upgrades a turn to goal completion", async () => {
    const policy = executable(); policy.state.spentByBucket.weekly = 3;
    const report = JSON.stringify({ claimId: "claim", policyRevision: 1, status: "objective-completed", summary: "Done", evidenceRefs: ["test:passed"], remainingWork: "", blockingQuestion: "" });
    const authorized = () => true;
    const run: typeof runManagedContinuation = async (request, options) => {
      expect(request.policy.continuation).toBe(policy.prompt);
      expect(request.policy.threadId).toBe(threadId);
      expect(request.policy.account).toBe(policy.account);
      expect(request.policy.profileKey).toBe(policy.profileKey);
      expect(request.policy.accountKey).toBe(policy.accountKey);
      expect(request.policy.maxTurns).toBe(1);
      expect(request.claimId).toBe("claim");
      expect(options.quotaResume).toEqual(evidence);
      expect(options.structuredWork).toBe(false);
      expect(options.budgetByBucket).toEqual({ weekly: { reservePercent: 5, remainingUsagePercent: 17 } });
      expect(options.stillAuthorized).toBe(authorized);
      expect(await options.readGate!(request.policy)).toBe(gate);
      return { ...completed, report };
    };
    const result = await executeCodexWork(DEFAULT_CONFIG, policy, "claim", authorized, () => gate, run);
    expect(result.status).toBe("turn-finished");
    expect(result.summary).toBe("1회 재개 종료");
    expect(result.remainingWork).toBeTruthy();
    expect(result.completionAssessment).toBeUndefined();
    expect(result.report).toBe(report);
  });

  test("missing evidence cannot fall back to ordinary continuation", async () => {
    const policy = executable(); delete policy.quotaResume;
    let calls = 0;
    const run: typeof runManagedContinuation = async () => { calls++; return completed; };
    expect(await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, run))
      .toMatchObject({ status: "failed", reason: "quota-resume-evidence-required" });
    expect(calls).toBe(0);
  });

  test("quota and uncertain failures retain their existing execution semantics", async () => {
    for (const [outcome, status] of [
      [{ ...completed, outcome: "quota-blocked", processStopped: true, reason: "upstream-quota-hold" }, "quota-blocked"],
      [{ ...completed, outcome: "failed", attempts: 1, reason: "response-missing" }, "uncertain"],
      [{ ...completed, outcome: "failed", attempts: 0, reason: "quota-resume-evidence-changed" }, "failed"],
      [{ ...completed, outcome: "failed", attempts: 1, processStopped: true, reason: "authorization-ended" }, "activity-paused"],
    ] satisfies [ManagedContinuationResult, WorkResult["status"]][]) {
      const result = await executeCodexWork(DEFAULT_CONFIG, executable(), "claim", () => true, () => gate, async () => outcome);
      expect(result.status).toBe(status);
      expect(result.reason).toBe(outcome.reason);
    }
  });

  test("managed repeated-quota proof is persisted before return and an unverified stop keeps its fence", async () => {
    const policy = executable();
    const receipts: Array<{threadId:string;turnId:string}> = [];
    const readEvidence = async () => null;
    const result = await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, async (_request, options) => {
      expect(options.readQuotaResumeEvidence).toBe(readEvidence);
      return { ...completed, outcome: "quota-blocked", processStopped: true, quotaTurnId: nextTurnId };
    }, undefined, { readEvidence, onManagedQuotaTurn: receipt => { receipts.push(receipt); } });
    expect(result.status).toBe("quota-blocked");
    expect(receipts).toEqual([{ threadId, turnId: nextTurnId }]);
    const uncertain = await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, async () =>
      ({ ...completed, outcome: "quota-blocked", quotaTurnId: nextTurnId }), undefined,
      { onManagedQuotaTurn: receipt => { receipts.push(receipt); } });
    expect(uncertain.status).toBe("uncertain"); expect(receipts).toHaveLength(1);
    const missingProof = await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, async () =>
      ({ ...completed, outcome: "quota-blocked", processStopped: true }), undefined,
      { onManagedQuotaTurn: receipt => { receipts.push(receipt); } });
    expect(missingProof.status).toBe("quota-blocked"); expect(receipts).toHaveLength(1);
  });

  test("ordinary work keeps structured progress and claim validation", async () => {
    const policy = executable({ purpose: undefined, quotaResume: undefined, maxTurns: 3 });
    const report = { claimId: "claim", policyRevision: policy.revision, status: "objective-completed", summary: "Verified", evidenceRefs: ["test:passed"], remainingWork: "", blockingQuestion: "" };
    const run: typeof runManagedContinuation = async (request, options) => {
      expect(request.policy.continuation).toContain("Completion criteria:");
      expect(request.policy.continuation).toContain("At the end return only a JSON object");
      expect(options.structuredWork).toBe(true);
      expect(options.quotaResume).toBeUndefined();
      return { ...completed, report: JSON.stringify(report) };
    };
    expect((await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, run)).status).toBe("objective-completed");
    const staleReport = async () => ({ ...completed, report: JSON.stringify({ ...report, claimId: "other-claim" }) });
    expect(await executeCodexWork(DEFAULT_CONFIG, policy, "claim", () => true, () => gate, staleReport))
      .toMatchObject({ status: "uncertain", reason: "structured-result-missing" });
  });
});
