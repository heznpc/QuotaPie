import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config";
import { inspectWorkTarget, executeWorkTurn, parseWorkProgress, type WorkBinding } from "../src/work/runtime";
import type { WorkPolicy } from "../src/work/types";
const SESSION = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-work-runtime-")); dirs.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  mkdirSync(join(root, "projects", "project"), { recursive: true });
  writeFileSync(join(root, "projects", "project", SESSION + ".jsonl"), JSON.stringify({ type: "assistant", sessionId: SESSION, cwd, message: { model: "claude-sonnet-4-6" } }) + "\n");
  const config = structuredClone(DEFAULT_CONFIG); config.accounts.claude = [{ id: "test", label: "test", enabled: true, configDir: root, keychainService: null }];
  return { root, cwd, config, target: { provider: "claude" as const, account: "test", nativeSessionId: SESSION } };
}
const authStatus = async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "private@example.invalid", orgId: "private-org" });
const subscriptionUsage = async () => ({ extra_usage: { is_enabled: false } });
test("binds an exact existing Claude session to subscription identity without exporting raw identity", async () => {
  const f = fixture();
  const binding = await inspectWorkTarget(f.config, f.target, { authStatus, subscriptionUsage });
  expect(binding.cwd).toBe(realpathSync(f.cwd));
  expect(binding.accountKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(binding)).not.toContain("private-org");
  expect(JSON.stringify(binding)).not.toContain("private@example");
  const changed = await inspectWorkTarget(f.config, f.target, { authStatus: async () => ({ ...await authStatus(), orgId: "different" }), subscriptionUsage });
  expect(changed.accountKey).not.toBe(binding.accountKey);
});
test("refuses API, cloud and paid extra usage even when credentials exist", async () => {
  const f = fixture();
  for (const override of [{ authMethod: "api_key" }, { apiProvider: "bedrock" }, { loggedIn: false }]) {
    expect(inspectWorkTarget(f.config, f.target, { authStatus: async () => ({ ...await authStatus(), ...override }), subscriptionUsage })).rejects.toThrow("claude-subscription-auth-required");
  }
  for (const usage of [{}, { extra_usage: { is_enabled: true } }])
    expect(inspectWorkTarget(f.config, f.target, { authStatus, subscriptionUsage: async () => usage })).rejects.toThrow("claude-paid-overage-not-disabled");
});
test("settings credentials override sanitized env so helper and project routes are rejected before auth execution", async () => {
  const f = fixture(); let calls = 0;
  mkdirSync(join(f.cwd, ".claude"));
  for (const setting of [{ apiKeyHelper: "echo secret" }, { env: { ANTHROPIC_BASE_URL: "https://example.invalid" } }]) {
    writeFileSync(join(f.cwd, ".claude", "settings.local.json"), JSON.stringify(setting));
    await expect(inspectWorkTarget(f.config, f.target, { authStatus: async () => { calls++; return authStatus(); }, subscriptionUsage })).rejects.toThrow("claude-subscription-routing-unverified");
  }
  expect(calls).toBe(0);
});
function policy(binding: WorkBinding): WorkPolicy {
  return { id: "test", provider: "claude", account: "test", ...binding, prompt: "Continue useful task", objective: "Produce result", completionCriteria: ["result exists"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetWithinMinutes: 30, budgetByBucket: { five_hour: { reservePercent: 0, maxUsagePercent: 10 } },
    maxTurns: 4, maxDurationSeconds: 60, maxTotalDurationSeconds: 120, expiresAtMs: Date.now() + 60000, priority: 1, onReset: "stop", revision: 1,
    state: { spentByBucket: {}, baselines: {}, turns: 0, totalDurationSeconds: 0, status: "waiting", activeExecutionId: null } };
}
const progress = (status = "objective-completed") => ({ claimId: "claim", policyRevision: 1, status, summary: "Saved result", evidenceRefs: ["result.txt"], remainingWork: status === "turn-finished" ? "verify result" : "", blockingQuestion: "" });
test("CLI success does not establish objective completion without matching structured progress", async () => {
  const f = fixture(), binding = await inspectWorkTarget(f.config, f.target, { authStatus, subscriptionUsage });
  const p = policy(binding);
  const options = { claimId: "claim", policyRevision: 1, timeoutMs: 10000, stillAuthorized: () => true, inspect: async () => binding };
  const success = { kind: "succeeded" as const, reason: "completed", sessionId: SESSION, output: "Done" };
  expect((await executeWorkTurn(f.config, p, { ...options, execute: async () => success })).reason).toBe("progress-result-unverified");
  expect((await executeWorkTurn(f.config, p, { ...options, execute: async () => ({ ...success, structuredOutput: progress("turn-finished") }) })).status).toBe("turn-finished");
  const completed = await executeWorkTurn(f.config, p, { ...options, execute: async input => {
    expect(input.sessionId).toBe(SESSION); expect(input.structuredOutputSchema).toBeDefined();
    return { ...success, structuredOutput: progress() };
  } });
  expect(completed.status).toBe("objective-completed"); expect(completed.completionAssessment).toBe("model-assessed");
  expect(parseWorkProgress({ ...progress(), claimId: "other" }, "claim", 1)).toBeNull();
  expect(parseWorkProgress({ ...progress(), evidenceRefs: [] }, "claim", 1)).toBeNull();
});
test("shared authorization changes cancel an in-flight provider and never grant completion", async () => {
  const f = fixture(), binding = await inspectWorkTarget(f.config, f.target, { authStatus, subscriptionUsage });
  let allowed = true;
  const value = await executeWorkTurn(f.config, policy(binding), { claimId: "claim", policyRevision: 1, timeoutMs: 10000,
    stillAuthorized: () => allowed, inspect: async () => binding, authorizationIntervalMs: 5,
    execute: async input => { allowed = false; await new Promise(resolve => input.signal!.addEventListener("abort", resolve, { once: true })); return { kind: "uncertain", reason: "aborted" }; } });
  expect(value.status).toBe("uncertain"); expect(value.reason).toBe("authorization-ended");
});
test("total remaining duration caps each provider turn and identity mismatch prevents spawn", async () => {
  const f = fixture(), binding = await inspectWorkTarget(f.config, f.target, { authStatus, subscriptionUsage });
  const p = policy(binding); p.state.totalDurationSeconds = 118;
  const options = { claimId: "claim", policyRevision: 1, timeoutMs: 10000, stillAuthorized: () => true, inspect: async () => binding };
  await executeWorkTurn(f.config, p, { ...options, execute: async input => { expect(input.timeoutMs).toBeLessThanOrEqual(2000); return { kind: "uncertain", reason: "test" }; } });
  let called = false;
  const mismatch = await executeWorkTurn(f.config, p, { ...options, inspect: async () => ({ ...binding, accountKey: "changed" }), execute: async () => { called = true; throw new Error(); } });
  expect(called).toBeFalse(); expect(mismatch.reason).toBe("account-session-mismatch");
});

test("only independently verified owned stops permit another turn", async () => {
  const f=fixture(),binding=await inspectWorkTarget(f.config,f.target,{authStatus,subscriptionUsage});
  for(const verified of [false,true]) {
    let allowed=true;
    const result=await executeWorkTurn(f.config,policy(binding),{claimId:"claim",policyRevision:1,timeoutMs:10000,
      stillAuthorized:()=>allowed,inspect:async()=>binding,authorizationIntervalMs:5,
      execute:async input=>{allowed=false;await new Promise(resolve=>input.signal!.addEventListener("abort",resolve,{once:true}));return {kind:"uncertain",reason:"aborted",...(verified?{ownedProcessStopped:true as const}:{})};}});
    expect(result.status).toBe(verified?"activity-paused":"uncertain");
  }
});

test("collector-only custom Keychain routing cannot establish the native CLI quota identity", async()=>{
  const f=fixture();f.config.accounts.claude[0]!.keychainService="collector-other-login";
  await expect(inspectWorkTarget(f.config,f.target,{authStatus,subscriptionUsage})).rejects.toThrow("custom-credentials-unsupported");
});
