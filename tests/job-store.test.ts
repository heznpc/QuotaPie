import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSpec } from "../src/jobs/types";
import { QuotaStorage } from "../src/storage/database";
import { JOB_LEASE_MS, JobStore, JobStoreError, validateJobSpec } from "../src/storage/job-store";

const opened: QuotaStorage[] = [];
const directories: string[] = [];
function open(path = ":memory:"): JobStore {
  const storage = new QuotaStorage(path);
  opened.push(storage);
  return new JobStore(storage);
}
function privatePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "quotapie-jobs-"));
  directories.push(directory);
  return join(directory, "jobs.sqlite3");
}
function spec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    version: 1, key: "batch-1", label: "A small batch", provider: "codex", account: "default",
    cwd: "/private/project", buckets: ["codex:primary", "codex:weekly"],
    steps: [{ key: "first", prompt: "private-prompt-alpha", retrySafe: true }, { key: "second", prompt: "private-prompt-beta", retrySafe: true }],
    policy: { mode: "manual", expiresAtMs: 10_000_000, maxAttempts: 10 }, ...overrides,
  };
}
function approved(store: JobStore, input = spec(), now = 1_000): string {
  const job = store.submit(input, now);
  store.setReadiness(job.id, true, null, now + 1);
  store.approve(job.id, now + 2);
  return job.id;
}
afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable job checkpoints", () => {
  test("reopens private results, rejects another spec for the same key, and only exports summaries", () => {
    const path = privatePath();
    const store = open(path);
    const id = approved(store);
    const claim = store.claim(id, 2_000)!;
    store.finish(claim.token, { outcome: "succeeded", output: "private-result", sessionId: "private-session" }, 3_000);
    const reopened = open(path);
    const restored = reopened.get(id, 3_100)!;
    expect(restored.steps[0]).toMatchObject({ state: "succeeded", result: "private-result", nativeSessionId: "private-session", attemptCount: 1 });
    expect(restored.state).toBe("ready");
    expect(restored.approvalValid).toBeTrue();
    expect(reopened.submit(spec({ buckets: ["codex:weekly", "codex:primary"] }), 4_000).id).toBe(id);
    expect(reopened.get(id)?.updatedAtMs).toBe(3_000);
    expect(() => reopened.submit(spec({ label: "Different plan" }), 4_000)).toThrow(JobStoreError);
    const summary = reopened.summaries()[0]!;
    expect(summary.completedSteps).toBe(1);
    const serialized = JSON.stringify(summary);
    for (const privateValue of ["private-prompt", "private-result", "private-session", "/private/project", "expiresAtMs", "approvalValid"]) {
      expect(serialized.includes(privateValue)).toBeFalse();
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
  });

  test("requires manual approval and skips completed steps without counting failures", () => {
    const store = open();
    const job = store.submit(spec(), 1_000);
    expect(store.claim(job.id, 1_100)).toBeNull();
    store.setReadiness(job.id, true, null, 1_200);
    expect(store.claim(job.id, 1_300)).toBeNull();
    store.approve(job.id, 1_400);
    const first = store.claim(job.id, 1_500)!;
    expect(first.step.key).toBe("first");
    store.finish(first.token, { outcome: "succeeded", output: "done" }, 1_600);
    const second = store.claim(job.id, 1_700)!;
    expect(second.step.key).toBe("second");
    expect(second.job.steps[0]?.attemptCount).toBe(1);
    const failed = store.finish(second.token, { outcome: "failed", output: "invalid credentials" }, 1_800);
    expect(failed.state).toBe("failed");
    expect(failed.steps[1]?.state).toBe("failed");
    expect(store.summaries()[0]).toMatchObject({ completedSteps: 1, totalSteps: 2, attemptCount: 2 });
    expect(store.claim(job.id, 1_900)).toBeNull();
  });

  test("safe quota retry waits until the observed time and renews manual approval", () => {
    const store = open();
    const id = approved(store);
    const claim = store.claim(id, 2_000)!;
    const blocked = store.finish(claim.token, { outcome: "quota", retryAtMs: 5_000 }, 2_100);
    expect(blocked).toMatchObject({ state: "waiting", approvalValid: false, blockedAtMs: 2_100, notBeforeMs: 5_000 });
    expect(blocked.steps[0]?.state).toBe("blocked");
    store.setReadiness(id, true, null, 3_000);
    expect(store.claim(id, 3_100)).toBeNull();
    store.approve(id, 3_200);
    const same = store.setReadiness(id, true, null, 3_300);
    expect(same.approvalValid).toBeTrue();
    expect(same.updatedAtMs).toBe(3_200);
    expect(store.claim(id, 4_999)).toBeNull();
    const retry = store.claim(id, 5_000)!;
    expect(retry.step).toMatchObject({ key: "first", attemptCount: 2 });
    expect(() => store.finish(claim.token, { outcome: "succeeded" }, 5_100)).toThrow("claim is absent or expired");
    store.finish(retry.token, { outcome: "succeeded" }, 5_100);
  });

  test("quota without explicit retry safety requires review even with automatic policy", () => {
    const store = open();
    const unsafe = spec({ steps: [{ key: "first", prompt: "perform side effect" }], policy: { mode: "auto", expiresAtMs: 10_000_000, maxAttempts: 10 } });
    const id = store.submit(unsafe, 1_000).id;
    store.setReadiness(id, true, null, 1_100);
    const claim = store.claim(id, 1_200)!;
    expect(store.finish(claim.token, { outcome: "quota" }, 1_300)).toMatchObject({ state: "review", reason: "quota-retry-review", approvalValid: false });
    expect(store.claim(id, 1_400)).toBeNull();
    expect(() => store.setReadiness(id, true, null, 1_400)).toThrow("expected waiting or ready");
    const reviewed = store.resolveReview(id, 1_500);
    expect(reviewed.steps[0]?.state).toBe("pending");
    store.setReadiness(id, true, null, 1_600);
    expect(store.claim(id, 1_700)?.step.attemptCount).toBe(2);
  });

  test("losing readiness requires observations after the latest loss without moving the repeated-wait baseline", () => {
    const store = open();
    const id = store.submit(spec(), 1_000).id;
    expect(store.setReadiness(id, false, "quota-wait", 1_100).blockedAtMs).toBe(1_100);
    store.setReadiness(id, true, null, 1_200);
    store.approve(id, 1_250);
    const lost = store.setReadiness(id, false, "quota-wait", 1_300);
    expect(lost).toMatchObject({ state: "waiting", blockedAtMs: 1_300, approvalValid: false });
    const repeated = store.setReadiness(id, false, "quota-collection-wait", 1_400);
    expect(repeated.blockedAtMs).toBe(1_300);
    expect(repeated.updatedAtMs).toBe(1_400);
    expect(store.setReadiness(id, false, "quota-collection-wait", 1_500)).toEqual(repeated);
    expect(store.setReadiness(id, true, null, 1_600).blockedAtMs).toBe(1_300);
    expect(store.setReadiness(id, false, "quota-wait", 1_700).blockedAtMs).toBe(1_700);
  });

  test("two connections cannot claim the same job or run two jobs for one account", () => {
    const path = privatePath();
    const a = open(path);
    const b = open(path);
    const first = approved(a);
    const second = approved(b, spec({ key: "batch-2" }));
    const otherAccount = approved(b, spec({ key: "batch-3", account: "other" }));
    const claim = a.claim(first, 2_000)!;
    expect(b.claim(first, 2_001)).toBeNull();
    expect(b.claim(second, 2_001)).toBeNull();
    expect(b.claim(otherAccount, 2_001)).not.toBeNull();
    expect(b.heartbeat("wrong-token", 2_100)).toBeFalse();
    expect(b.heartbeat(claim.token, 2_100)).toBeTrue();
    a.finish(claim.token, { outcome: "succeeded" }, 2_200);
    expect(b.claim(second, 2_300)).not.toBeNull();
    expect(() => b.finish(claim.token, { outcome: "succeeded" }, 2_400)).toThrow("claim is absent or expired");
  });

  test("heartbeat loss is uncertain and blocks the account until explicit review", () => {
    const store = open();
    const id = approved(store);
    const second = approved(store, spec({ key: "other-batch" }));
    const claim = store.claim(id, 2_000)!;
    expect(store.recoverStale(2_000 + JOB_LEASE_MS - 1)).toBe(0);
    const expired = 2_000 + JOB_LEASE_MS;
    expect(store.heartbeat(claim.token, expired)).toBeFalse();
    expect(() => store.finish(claim.token, { outcome: "succeeded" }, expired)).toThrow(JobStoreError);
    expect(store.recoverStale(expired)).toBe(1);
    expect(store.get(id, expired)).toMatchObject({ state: "review", reason: "lease-expired", approvalValid: false });
    expect(store.get(id)?.steps[0]?.state).toBe("uncertain");
    expect(store.recoverStale(expired + 1)).toBe(0);
    expect(store.claim(second, expired + 1)).toBeNull();
    store.resolveReview(id, expired + 2);
    store.setReadiness(id, true, null, expired + 3);
    expect(store.claim(id, expired + 4)).toBeNull();
    store.approve(id, expired + 5);
    const replacement = store.claim(id, expired + 6)!;
    expect(replacement.token).not.toBe(claim.token);
    expect(() => store.finish(claim.token, { outcome: "failed" }, expired + 7)).toThrow(JobStoreError);
    expect(store.get(id)?.state).toBe("running");
  });

  test("an active heartbeat prevents stale recovery and cannot be hijacked", () => {
    const store = open();
    const id = approved(store);
    const claim = store.claim(id, 2_000)!;
    expect(store.heartbeat(claim.token, 100_000)).toBeTrue();
    expect(store.recoverStale(130_000)).toBe(0);
    expect(store.get(id)?.state).toBe("running");
    expect(() => store.cancel(id, 130_001)).toThrow("job is running");
    expect(() => store.resolveReview(id, 130_001)).toThrow("job is running");
  });

  test("defers an unstarted claim without spending an attempt or losing completed work", () => {
    const path = privatePath();
    const store = open(path);
    const id = approved(store);
    const first = store.claim(id, 2_000)!;
    store.finish(first.token, { outcome: "succeeded", output: "first-result", sessionId: "first-session" }, 2_100);
    const second = store.claim(id, 2_200)!;
    expect(second.job.attemptCount).toBe(2);
    const deferred = store.defer(second.token, "dispatch-precondition-changed", 2_300);
    expect(deferred).toMatchObject({
      state: "waiting", reason: "dispatch-precondition-changed", attemptCount: 1,
      approvalValid: false, blockedAtMs: 2_300, notBeforeMs: null, updatedAtMs: 2_300,
    });
    expect(deferred.steps[0]).toMatchObject({ state: "succeeded", attemptCount: 1, result: "first-result", nativeSessionId: "first-session" });
    expect(deferred.steps[1]).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(store.heartbeat(second.token, 2_400)).toBeFalse();
    expect(() => store.defer(second.token, "dispatch-precondition-changed", 2_400)).toThrow("claim is absent or expired");
    expect(() => store.finish(second.token, { outcome: "succeeded" }, 2_400)).toThrow("claim is absent or expired");
    const reopened = open(path);
    expect(reopened.get(id, 2_500)).toEqual(deferred);
    expect(reopened.claim(id, 2_500)).toBeNull();
    reopened.setReadiness(id, true, null, 2_600);
    expect(reopened.claim(id, 2_700)).toBeNull();
    reopened.approve(id, 2_800);
    const retry = reopened.claim(id, 2_900)!;
    expect(retry.job.attemptCount).toBe(2);
    expect(retry.step).toMatchObject({ key: "second", attemptCount: 1 });
    expect(retry.token).not.toBe(second.token);
  });

  test("an expired defer token cannot erase an uncertain execution or refund its attempt", () => {
    const store = open();
    const id = approved(store);
    const claim = store.claim(id, 2_000)!;
    const expired = 2_000 + JOB_LEASE_MS;
    expect(() => store.defer(claim.token, "dispatch-precondition-changed", expired)).toThrow("claim is absent or expired");
    expect(store.get(id, expired)).toMatchObject({ state: "running", attemptCount: 1 });
    expect(store.get(id)?.steps[0]).toMatchObject({ state: "running", attemptCount: 1 });
    expect(store.recoverStale(expired)).toBe(1);
    expect(() => store.defer(claim.token, "dispatch-precondition-changed", expired + 1)).toThrow("claim is absent or expired");
    expect(store.get(id, expired + 1)).toMatchObject({ state: "review", attemptCount: 1 });
    expect(store.get(id)?.steps[0]).toMatchObject({ state: "uncertain", attemptCount: 1 });
  });

  test("checks expiration immediately before launch and enforces total attempts", () => {
    const store = open();
    const expired = approved(store, spec({ policy: { mode: "manual", expiresAtMs: 2_000, maxAttempts: 10 } }));
    expect(store.claim(expired, 2_000)).toBeNull();
    expect(store.get(expired)).toMatchObject({ state: "failed", reason: "policy-expired", attemptCount: 0 });
    const limited = approved(store, spec({ key: "limited", policy: { mode: "auto", expiresAtMs: 1_000_000, maxAttempts: 1 } }));
    const claim = store.claim(limited, 2_100)!;
    store.finish(claim.token, { outcome: "succeeded" }, 2_200);
    expect(store.claim(limited, 2_300)).toBeNull();
    expect(store.get(limited)).toMatchObject({ state: "failed", reason: "attempts-exhausted", attemptCount: 1 });
    expect(store.summaries().find((job) => job.id === limited)?.completedSteps).toBe(1);
  });

  test("completing all steps is terminal and cancellation does not launch anything", () => {
    const store = open();
    const id = approved(store, spec({ steps: [spec().steps[0]!] }));
    const claim = store.claim(id, 2_000)!;
    const result = store.finish(claim.token, { outcome: "succeeded", output: "final" }, 2_100);
    expect(result.state).toBe("succeeded");
    expect(result.approvalValid).toBeFalse();
    expect(store.claim(id, 2_200)).toBeNull();
    const cancelled = store.submit(spec({ key: "cancelled" }), 2_300).id;
    expect(store.cancel(cancelled, 2_400).state).toBe("cancelled");
    expect(store.claim(cancelled, 2_500)).toBeNull();
  });

  test("imports matching legacy checkpoints once, skips successes, and retains errors as failed", () => {
    const store = open();
    const id = store.submit(spec(), 1_000).id;
    expect(() => store.importCompleted(id, { first: "done" }, "wrong-run", 1_100)).toThrow("does not match");
    expect(() => store.importCompleted(id, { first: "done", unknown: "bad" }, "batch-1", 1_100)).toThrow("unknown step key");
    expect(store.get(id)?.steps[0]?.state).toBe("pending");
    const imported = store.importCompleted(id, { first: { value: "legacy output" } }, "batch-1", 1_200);
    expect(imported.steps[0]).toMatchObject({ state: "succeeded", result: '{"value":"legacy output"}', attemptCount: 0 });
    expect(() => store.importCompleted(id, {}, "batch-1", 1_300)).toThrow("requires a new");
    store.setReadiness(id, true, null, 1_400);
    store.approve(id, 1_500);
    expect(store.claim(id, 1_600)?.step.key).toBe("second");
    const failed = store.submit(spec({ key: "legacy-failed" }), 2_000).id;
    expect(store.importCompleted(failed, { first: "done", second: { error: "provider failed" } }, "legacy-failed", 2_100).state).toBe("failed");
    expect(store.summaries().find((job) => job.id === failed)?.completedSteps).toBe(1);
    expect(store.get(failed)?.steps[1]?.state).toBe("failed");
  });

  test("imports legacy task::method step keys without widening job IDs", () => {
    const store = open();
    const legacySpec = spec({ steps: [
      { key: "task1::method1", prompt: "first operation" },
      { key: "task2::method1", prompt: "second operation" },
    ] });
    const id = store.submit(legacySpec, 1_000).id;
    const imported = store.importCompleted(id, { "task1::method1": { result: "done" } }, legacySpec.key, 1_100);
    expect(imported.steps[0]).toMatchObject({ key: "task1::method1", state: "succeeded" });
    store.setReadiness(id, true, null, 1_200);
    store.approve(id, 1_300);
    expect(store.claim(id, 1_400)?.step.key).toBe("task2::method1");
    expect(() => validateJobSpec(spec({ key: "task::method" }))).toThrow("invalid job key");
    for (const unsafe of ["", "   ", "step\nkey", "step\0key", "x".repeat(161)]) {
      expect(() => validateJobSpec(spec({ steps: [{ key: unsafe, prompt: "operation" }] }))).toThrow("invalid step key");
    }
  });

  test("validates bounded plans, fixed identity, and reason codes without leaking input", () => {
    for (const input of [
      spec({ cwd: "relative" }), spec({ key: "../escape" }), spec({ buckets: [] }),
      spec({ steps: [spec().steps[0]!, spec().steps[0]!] }),
      spec({ profileKey: "/private/profile" }), spec({ policy: { mode: "auto", expiresAtMs: 1_000, maxAttempts: 0 } }),
      { ...spec(), arbitrary: true },
    ]) expect(() => validateJobSpec(input)).toThrow(JobStoreError);
    const valid = validateJobSpec(spec({ profileKey: "a".repeat(64) }));
    expect(valid.profileKey).toBe("a".repeat(64));
    const store = open();
    const id = store.submit(valid, 1_000).id;
    expect(() => store.setReadiness(id, false, "private raw error message", 1_100)).toThrow("reason must be a short code");
    expect(() => store.submit({ ...valid, profileKey: "b".repeat(64) }, 1_200)).toThrow("different specification");
    expect(store.get(id)?.spec.profileKey).toBe("a".repeat(64));
  });

  test("notification summaries retain older eligible jobs beyond the public history limit", () => {
    const store = open();
    const older = approved(store);
    for (let i = 0; i < 101; i++) {
      const id = store.submit(spec({ key: `newer-${i}` }), 2_000 + i).id;
      store.cancel(id, 2_200 + i);
    }
    expect(store.summaries()).toHaveLength(100);
    expect(store.summaries().some((job) => job.id === older)).toBeFalse();
    expect(store.notificationSummaries()).toEqual([{
      id: older, key: "batch-1", label: "A small batch", provider: "codex", account: "default",
      state: "ready", completedSteps: 0, totalSteps: 2, attemptCount: 0,
      reason: null, updatedAtMs: 1_002, policy: { mode: "manual" },
    }]);
    const publicText = JSON.stringify(store.notificationSummaries());
    expect(publicText).not.toContain("private-prompt");
    expect(publicText).not.toContain("/private/project");
  });
});
