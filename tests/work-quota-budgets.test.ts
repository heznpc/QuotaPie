import { expect, test } from "bun:test";
import { planQuotaResumeBudgets, codexQuotaLane } from "../src/work/quota-budgets";
import type { WindowAnalysis } from "../src/types";
import type { WorkPolicy } from "../src/work/types";
import { analyzeWindow } from "../src/analytics";
import { DEFAULT_CONFIG } from "../src/config";

const NOW = 2_000_000_000_000, BEFORE = NOW - 5000;
const previousBucket = "codex:secondary:10080", nextBucket = "codex:secondary:43200";
function fixture() {
  const policy: WorkPolicy = {
    id: "recovery", provider: "codex", purpose: "quota-resume", account: "plus", profileKey: "profile", accountKey: "account",
    quotaResume: { turnId: "failed", stamp: "stable", waitUntilRecovered: true }, nativeSessionId: "thread", model: "gpt-6-sol", cwd: "/tmp",
    prompt: "Continue", objective: "Finish", completionCriteria: ["Done"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetWithinMinutes: 0, budgetByBucket: {
      "codex:primary:300": { reservePercent: 5, maxUsagePercent: 100 },
      [previousBucket]: { reservePercent: 25, maxUsagePercent: 30, targetUsagePercent: 20 },
    }, maxTurns: 1, maxDurationSeconds: 60, maxTotalDurationSeconds: 60, expiresAtMs: NOW, priority: 0,
    onReset: "continue", revision: 1, state: { baselines: {}, spentByBucket: {}, turns: 0, totalDurationSeconds: 0, status: "waiting", activeExecutionId: null },
  };
  function window(bucket: string): WindowAnalysis {
    const lane = codexQuotaLane(bucket)!;
    return { ...analyzeWindow({ provider: "codex", account: "plus", bucket, label: bucket, source: "codex-app-server", windowSeconds: lane.durationMinutes * 60,
      metadata: { limitId: lane.limitId, lane: lane.lane }, quality: "authoritative", observedAtMs: NOW - 1000,
      usedPercent: 10, resetsAtMs: NOW + 86400000 }, [], DEFAULT_CONFIG, NOW), reservePercent: 10 };
  }
  const windows = [window("codex:primary:300"), window(nextBucket)];
  const options = { afterMs: BEFORE, nowMs: NOW };
  return { policy, windows, window, options, plan: () => planQuotaResumeBudgets(policy, windows, options) };
}

test("an explicit newer duration replacement keeps the stronger old budget", () => {
  const f = fixture(), original = structuredClone(f.policy), plan = f.plan();
  expect(plan.replacements).toEqual([{ previousBucket, nextBucket }]);
  expect(plan.budgets[nextBucket]).toEqual({ reservePercent: 25, maxUsagePercent: 30, targetUsagePercent: 20 });
  expect(plan.budgets[previousBucket]).toBeUndefined();
  expect(f.policy).toEqual(original);
  f.windows[1]!.reservePercent = 40;
  f.policy.budgetByBucket[nextBucket] = { reservePercent: 35, maxUsagePercent: 12, targetUsagePercent: 8 };
  expect(f.plan().budgets[nextBucket]).toEqual({ reservePercent: 40, maxUsagePercent: 12, targetUsagePercent: 8 });
});

test("a genuinely missing lane or differently identified alias is never retired", () => {
  const f = fixture();
  f.windows.pop();
  expect(f.plan().replacements).toEqual([]);
  f.windows.push(f.window("another-pool:secondary:43200"));
  expect(f.plan().replacements).toEqual([]);
  f.windows[1]!.metadata!.normalModelSlug = "gpt-6-sol";
  expect(f.plan().replacements).toEqual([]);
  f.windows[1] = f.window("codex:primary:43200");
  expect(f.plan().replacements).toEqual([]);
});

test("the retained old window must disappear before its replacement can remove its budget", () => {
  const f = fixture();
  const retained = f.window(previousBucket); retained.observedAtMs = BEFORE;
  f.windows.push(retained);
  expect(f.plan().replacements).toEqual([]);
  expect(f.plan().budgets[nextBucket]).toBeDefined();
  expect(f.plan().budgets[previousBucket]).toBeDefined();
});

test("duplicate or ambiguous same-lane observations cannot authorize a replacement", () => {
  for (const duplicate of [nextBucket, "codex:secondary:300", "codex:secondary:unknown"]) {
    const f = fixture();
    f.windows.push({ ...f.windows[1]!, bucket: duplicate });
    expect(f.plan().replacements).toEqual([]);
  }
  const f = fixture();
  f.windows.push({ ...f.windows[1]!, bucket: "other:secondary:300" });
  expect(f.plan().replacements).toEqual([]);
  const historical = fixture();
  historical.policy.budgetByBucket["codex:secondary:300"] = { reservePercent: 20, maxUsagePercent: 15 };
  expect(historical.plan().replacements).toEqual([]);
});

test("replacement requires explicit metadata, encoded duration agreement, and a current authoritative reading", () => {
  const patches: Partial<WindowAnalysis>[] = [
    { metadata: undefined }, { metadata: { limitId: "other", lane: "secondary" } }, { metadata: { limitId: "codex", lane: "primary" } },
    { windowSeconds: 60 }, { quality: "fallback" }, { freshness: "stale" }, { freshness: "reset_due" },
    { observedAtMs: NOW - 120001 }, { observedAtMs: NOW + 1 }, { observedAtMs: BEFORE },
    { remainingPercent: null }, { remainingPercent: 101 }, { resetsAtMs: NOW }, { resetsAtMs: null },
  ];
  for (const patch of patches) {
    const f = fixture(); Object.assign(f.windows[1]!, patch);
    expect(f.plan().replacements).toEqual([]);
  }
});

test("replacement is newer than the old recorded baseline and belongs to the newest account snapshot", () => {
  const f = fixture();
  f.policy.state.baselines[previousBucket] = { atMs: NOW - 500, observationId: "newer", remainingPercent: 0, epoch: "old" };
  expect(f.plan().replacements).toEqual([]);
  f.policy.state.baselines[previousBucket]!.atMs = NOW - 2000;
  expect(f.plan().replacements).toHaveLength(1);
  f.windows[0]!.observedAtMs = NOW;
  expect(f.plan().replacements).toEqual([]);
});

test("only enabled, untouched automatic waiting policies can plan budget changes", () => {
  const changes: Array<(policy: WorkPolicy) => void> = [
    policy => { delete policy.purpose; }, policy => { delete policy.quotaResume; }, policy => { policy.enabled = false; },
    policy => { policy.provider = "claude"; }, policy => { policy.state.status = "quota-blocked"; },
    policy => { policy.state.turns = 1; }, policy => { policy.state.activeExecutionId = "claim"; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.policy);
    expect(f.plan()).toEqual({ budgets: {}, replacements: [] });
  }
});

test("cross-account observations cannot substitute for the required account lane", () => {
  const f = fixture(); f.windows[1]!.account = "pro";
  expect(f.plan().replacements).toEqual([]);
  expect(f.plan().budgets[nextBucket]).toBeUndefined();
});

test("unknown or malformed stored identities never become duration-change proof", () => {
  for (const bucket of ["weekly", "codex:secondary:unknown", "codex:secondary:0", "codex:secondary:NaN"]) {
    const f = fixture();
    f.policy.budgetByBucket = { [bucket]: { reservePercent: 20, maxUsagePercent: 100 } };
    expect(f.plan().replacements).toEqual([]);
  }
});

test("a changed duration alone never makes an exhausted replacement ready", () => {
  const f = fixture(); f.windows[1]!.remainingPercent = 0;
  // Refreshing identities preserves the constraint; admission still requires
  // positive remaining quota above the preserved reserve before any execution.
  expect(f.plan().replacements).toEqual([{ previousBucket, nextBucket }]);
  expect(f.plan().budgets[nextBucket]?.reservePercent).toBe(25);
});
