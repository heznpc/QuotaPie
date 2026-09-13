import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { jobCapacity, jobProfile, ManagedJobRunner } from "../src/jobs/runner";
import type { JobSpec } from "../src/jobs/types";
import type { JobStepResult } from "../src/jobs/executor";
import type { WindowAnalysis } from "../src/types";
import { startDashboard } from "../src/server";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture(mode: "auto" | "manual" = "auto") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-job-runner-")));
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex[0]!.codexHome = root;
  config.collection.codexEnabled = false;
  config.alerts.enabled = false;
  config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  let now = Date.now();
  const spec: JobSpec = {
    version: 1, key: "run", label: "Private batch", provider: "codex", account: "default",
    cwd: root, profileKey: jobProfile(config, { provider: "codex", account: "default" }).key,
    buckets: ["codex:primary:300"], model: "gpt-5.6-sol",
    steps: [{ key: "one", prompt: "secret-prompt-one", retrySafe: true }, { key: "two", prompt: "secret-prompt-two", retrySafe: true }],
    policy: { mode, expiresAtMs: now + 3600_000, maxAttempts: 8 },
  };
  const job = service.jobs.submit(spec, now);
  const window = (remainingPercent = 50, overrides: Partial<WindowAnalysis> = {}): WindowAnalysis => ({
    provider: "codex", account: "default", bucket: "codex:primary:300", quality: "authoritative",
    freshness: "fresh", observedAtMs: now - 1, remainingPercent, resetsAtMs: now + 60_000, ...overrides,
  } as WindowAnalysis);
  const advance = () => { now += 10; return now; };
  advance();
  cleanup.push(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, config, job, spec, window, advance, now: () => now };
}

test("a passed reset, stale or missing observation cannot dispatch; unrelated Claude model capacity is independent", () => {
  const f = fixture();
  expect(jobCapacity(f.job, [f.window(0)], f.now()).ready).toBeFalse();
  expect(jobCapacity(f.job, [f.window(100, { resetsAtMs: f.now() - 1 })], f.now()).ready).toBeFalse();
  expect(jobCapacity(f.job, [f.window(100, { freshness: "stale" })], f.now()).ready).toBeFalse();
  expect(jobCapacity(f.job, [], f.now()).ready).toBeFalse();
  expect(jobCapacity(f.job, [f.window(50), f.window(0, { bucket: "codex:secondary:10080" })], f.now()).ready).toBeFalse();
  const claude = { ...f.job, spec: { ...f.spec, provider: "claude" as const, model: "sonnet", buckets: ["five_hour", "seven_day"] } };
  const windows = ["five_hour", "seven_day", "seven_day_opus"].map(bucket => f.window(bucket.endsWith("opus") ? 0 : 50, { provider: "claude", bucket }));
  expect(jobCapacity(claude, windows, f.now()).ready).toBeTrue();
  windows[2]!.observedAtMs = f.now() - 700_000;
  expect(jobCapacity(claude, windows, f.now(), 600_000).ready).toBeTrue();
  windows[0]!.observedAtMs = f.now() - 700_000;
  expect(jobCapacity(claude, windows, f.now(), 600_000).ready).toBeFalse();
});

test("old observations from unrelated Codex model lanes do not defer fresh authorized work", async () => {
  const f = fixture(); let calls = 0;
  const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now, execute: async () => {
    calls++; return { kind: "succeeded", reason: "completed", output: "ok" };
  } });
  runner.tick([f.window(), f.window(0, { bucket: "codex_bengalfox:primary:300", observedAtMs: f.now() - 700_000, freshness: "stale" })], f.now());
  await runner.settle();
  expect(calls).toBe(1);
  expect(f.service.jobs.get(f.job.id)!.steps[0]!.state).toBe("succeeded");
});

test("manual jobs need approval and successful checkpoints skip earlier steps", async () => {
  const f = fixture("manual");
  const prompts: string[] = [];
  const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now, execute: async input => {
    prompts.push(input.prompt); return { kind: "succeeded", output: "done", reason: "completed" };
  } });
  runner.tick([f.window()], f.now()); await runner.settle();
  expect(prompts).toHaveLength(0);
  f.service.jobs.approve(f.job.id, f.now());
  runner.tick([f.window()], f.now()); await runner.settle();
  expect(f.service.jobs.get(f.job.id)!.steps[0]!.state).toBe("succeeded");
  f.advance(); runner.tick([f.window()], f.now()); await runner.settle();
  expect(prompts).toEqual(["secret-prompt-one", "secret-prompt-two"]);
  expect(f.service.jobs.get(f.job.id)!.state).toBe("succeeded");
});

test("structured quota waits for a newer actual recovery, then resumes only the blocked step", async () => {
  const f = fixture(); let attempts = 0;
  const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now, execute: async () => {
    attempts += 1;
    return attempts === 1 ? { kind: "quota", reason: "rate-limit", retryAtMs: f.now() + 5, sessionId: "11111111-1111-4111-8111-111111111111" }
      : { kind: "succeeded", output: "ok", reason: "completed" };
  } });
  runner.tick([f.window()], f.now()); await runner.settle();
  expect(f.service.jobs.get(f.job.id)!.state).toBe("waiting");
  runner.tick([f.window()], f.now()); await runner.settle(); expect(attempts).toBe(1);
  f.advance(); runner.tick([f.window(0)], f.now()); await runner.settle(); expect(attempts).toBe(1);
  f.advance(); runner.tick([f.window(100)], f.now()); await runner.settle(); expect(attempts).toBe(2);
  expect(f.service.jobs.get(f.job.id)!.steps[0]!.state).toBe("succeeded");
});

test("unmapped quota and oversized results preserve session identity for explicit review", async () => {
  for (const output of [undefined, "x".repeat(1_048_577)]) {
    const f = fixture();
    const result: JobStepResult = { kind: output ? "succeeded" : "quota", reason: "completed", output, sessionId: "11111111-1111-4111-8111-111111111111" };
    const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now, execute: async () => result });
    runner.tick([f.window()], f.now()); await runner.settle();
    const job = f.service.jobs.get(f.job.id)!;
    expect(job.state).toBe("review");
    expect(job.steps[0]!.nativeSessionId).toBe(result.sessionId!);
    if (output) expect(job.steps[0]!.result).toContain("output truncated");
    expect(job.reason).toBe(output ? "result-limit" : "quota-scope-unconfirmed");
  }
});

test("a depleted unrelated model lane cannot authorize retries for an unscoped provider error", async () => {
  const f = fixture();
  const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now, execute: async () => ({ kind: "quota", reason: "provider-quota" }) });
  runner.tick([f.window(), f.window(0, { bucket: "codex_bengalfox:primary:300" })], f.now());
  await runner.settle();
  const job = f.service.jobs.get(f.job.id)!;
  expect(job.state).toBe("review");
  expect(job.reason).toBe("quota-scope-unconfirmed");
});

test("concurrent cancellation cannot terminate the collector", () => {
  const f = fixture();
  const original = f.service.jobs.setReadiness.bind(f.service.jobs);
  f.service.jobs.setReadiness = (id, ready, reason, now) => {
    f.service.jobs.cancel(id, now); return original(id, ready, reason, now);
  };
  const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now });
  expect(() => runner.tick([f.window()], f.now())).not.toThrow();
  expect(f.service.jobs.get(f.job.id)!.state).toBe("cancelled");
});

test("collector evaluates jobs after asynchronous observation timestamps", async () => {
  const f = fixture("manual");
  const start = Date.now();
  // Registration must precede the provider response.
  await Bun.sleep(3);
  f.service.pollCodex = async () => {
    await Bun.sleep(3);
    f.service.ingestCodexSnapshot([{ provider: "codex", account: "default", bucket: "codex:primary:300", label: "Codex", windowSeconds: 18000,
      usedPercent: 10, observedAtMs: Date.now(), resetsAtMs: Date.now() + 60000, quality: "authoritative", source: "codex-appserver" }]);
    return [];
  };
  await f.service.tick(start);
  expect(f.service.jobs.get(f.job.id)!.state).toBe("ready");
});

test("changed dispatch conditions defer without consuming an attempt or running the provider", async () => {
  const f = fixture();
  const original = f.service.jobs.claim.bind(f.service.jobs);
  f.service.jobs.claim = (id, now) => {
    const claim = original(id, now);
    if (claim) f.config.accounts.codex[0]!.enabled = false;
    return claim;
  };
  let calls = 0;
  const runner = new ManagedJobRunner(f.service.jobs, f.config, { now: f.now, execute: async () => {
    calls++; return { kind: "succeeded", reason: "completed" };
  } });
  runner.tick([f.window()], f.now()); await runner.settle();
  const job = f.service.jobs.get(f.job.id)!;
  expect(calls).toBe(0);
  expect(job.state).toBe("waiting");
  expect(job.attemptCount).toBe(0);
  expect(job.steps[0]!.attemptCount).toBe(0);
  expect(job.reason).toBe("dispatch-precondition-changed");
});

test("status API contains job summaries without prompts, results or execution plans", async () => {
  const f = fixture();
  const server = startDashboard(f.service, f.config);
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(1);
    const json = JSON.stringify(body.jobs);
    for (const secret of ["secret-prompt", "nativeSessionId", "profileKey", "expiresAtMs", f.spec.cwd]) expect(json).not.toContain(secret);
  } finally { server.stop(true); }
});

test("job ready notifications respect mute, cancel obsolete approvals and notify a new recovery", async () => {
  const f = fixture("manual");
  f.config.alerts.enabled = true;
  f.config.alerts.macOSNotifications = true;
  f.service.setNativeNotificationTransportAvailable(true);
  f.service.alerts.setNativeNotificationConsumer(true);
  f.service.jobs.setReadiness(f.job.id, true, null, f.now());
  f.config.alerts.topics.resumeReady = false;
  await f.service.deliverJobNotifications();
  expect(f.service.claimNextAppNotification()).toBeNull();
  f.config.alerts.topics.resumeReady = true;
  await f.service.deliverJobNotifications();
  const first = f.service.claimNextAppNotification()!;
  expect(first).not.toBeNull();
  f.service.jobs.approve(f.job.id, f.now());
  expect(f.service.renewAppNotification(first.id, first.claimToken)).toBeFalse();
  f.advance(); f.service.jobs.setReadiness(f.job.id, false, "quota-wait", f.now());
  f.advance(); f.service.jobs.setReadiness(f.job.id, true, null, f.now());
  await f.service.deliverJobNotifications();
  const second = f.service.claimNextAppNotification()!;
  expect(second).not.toBeNull();
  expect(second.alertKey).not.toBe(first.alertKey);
});

test("older ready jobs still notify after more than one hundred newer registrations", async () => {
  const f = fixture("manual");
  f.config.alerts.enabled = true;
  f.config.alerts.macOSNotifications = true;
  f.service.setNativeNotificationTransportAvailable(true);
  f.service.alerts.setNativeNotificationConsumer(true);
  f.service.jobs.setReadiness(f.job.id, true, null, f.now());
  for (let i = 0; i < 101; i++) {
    const now = f.advance();
    const newer = f.service.jobs.submit({ ...f.spec, key: `newer-${i}` }, now);
    f.service.jobs.cancel(newer.id, now);
  }
  expect(f.service.jobs.summaries().some(job => job.id === f.job.id)).toBeFalse();
  await f.service.deliverJobNotifications();
  expect(f.service.claimNextAppNotification()?.alertKey).toStartWith(`jobs:${f.job.id}:ready:`);
});

test("suppressed completion, failure, and review notifications retry only when their topic is enabled", async () => {
  for (const outcome of ["succeeded", "failed", "uncertain"] as const) {
    const f = fixture("manual");
    f.config.alerts.enabled = true;
    f.config.alerts.macOSNotifications = true;
    f.service.setNativeNotificationTransportAvailable(true);
    f.service.alerts.setNativeNotificationConsumer(true);
    f.service.jobs.setReadiness(f.job.id, true, null, f.now());
    f.service.jobs.approve(f.job.id, f.now());
    const claim = f.service.jobs.claim(f.job.id, f.now())!;
    f.service.jobs.finish(claim.token, { outcome }, f.now());
    if (outcome === "succeeded") {
      const second = f.service.jobs.claim(f.job.id, f.now())!;
      f.service.jobs.finish(second.token, { outcome }, f.now());
    }
    await f.service.deliverJobNotifications();
    const first = f.service.claimNextAppNotification()!;
    expect(first).not.toBeNull();
    expect(f.service.completeAppNotification(first.id, first.claimToken, "suppressed")).toBeTrue();
    f.config.alerts.topics.resumeReady = false;
    await f.service.deliverJobNotifications();
    expect(f.service.claimNextAppNotification()).toBeNull();
    f.config.alerts.topics.resumeReady = true;
    await f.service.deliverJobNotifications();
    const retry = f.service.claimNextAppNotification()!;
    expect(retry).not.toBeNull();
    expect(retry.alertKey).toBe(first.alertKey);
    expect(retry.id).not.toBe(first.id);
    expect(f.service.completeAppNotification(retry.id, retry.claimToken, "scheduled")).toBeTrue();
    await f.service.deliverJobNotifications();
    expect(f.service.claimNextAppNotification()).toBeNull();
  }
});

test("muted terminal outbox entries retry after unmute but obsolete cancelled jobs stay silent", async () => {
  const f = fixture("manual");
  f.config.alerts.enabled = true;
  f.config.alerts.macOSNotifications = true;
  f.service.setNativeNotificationTransportAvailable(true);
  f.service.alerts.setNativeNotificationConsumer(true);
  f.service.jobs.setReadiness(f.job.id, true, null, f.now());
  f.service.jobs.approve(f.job.id, f.now());
  const claim = f.service.jobs.claim(f.job.id, f.now())!;
  f.service.jobs.finish(claim.token, { outcome: "failed" }, f.now());
  await f.service.deliverJobNotifications();
  f.service.applyNotificationPreferences({ topics: { resumeReady: false } });
  expect(f.service.claimNextAppNotification()).toBeNull();
  f.service.applyNotificationPreferences({ topics: { resumeReady: true } });
  await f.service.deliverJobNotifications();
  expect(f.service.claimNextAppNotification()?.alertKey).toStartWith(`jobs:${f.job.id}:failed:`);
  f.service.jobs.cancel(f.job.id, f.advance());
  await f.service.deliverJobNotifications();
  expect(f.service.claimNextAppNotification()).toBeNull();
});
