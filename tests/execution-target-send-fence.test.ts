import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionTargetLeaseStore } from "../src/work/execution-target-lease";
import { nativeExecutionHistory, portableReplay } from "../src/account-replay";

test("durable target intent survives restart, rejects concurrent or unknown resend, and records failure cause", () => {
  const root = mkdtempSync(join(tmpdir(), "qp-target-send-")), path = join(root, "lease.sqlite3"), now = Date.now();
  const thread = randomUUID(), turn = randomUUID(), execution = randomUUID(), bucket = "codex:primary:300";
  const hash = (digit: string) => digit.repeat(64);
  const policy: any = { id: "test", revision: 1, nativeSessionId: thread, provider: "codex", account: "a",
    profileKey: hash("1"), accountKey: hash("2"), model: "gpt-6.1-sol", prompt: "[QuotaPie quota recovery:test]\nContinue",
    quotaResume: { turnId: randomUUID(), stamp: "actual-failure" }, purpose: "quota-resume", dispatchOwner: "local", maxTurns: 1 };
  const target: any = { account: "b", profileKey: hash("3"), accountKey: hash("4"), identity: hash("5"), sourceIdentity: hash("6"),
    poolPolicyHash: hash("7"), selectedAtMs: now, expiresAtMs: now + 60000,
    budgetByBucket: { [bucket]: { reservePercent: 5, maxUsagePercent: 10 } },
    baselineByBucket: { [bucket]: { observationId: "actual-quota", atMs: now, remainingPercent: 90, epoch: String(now + 3600000) } } };
  let store = new ExecutionTargetLeaseStore(path);
  try {
    const lease = store.request(policy, execution, randomUUID(), target, now);
    store.acknowledge(execution, lease.digest, "relay", policy.profileKey, now);
    store.bindRequest({ sourceProfileKey: policy.profileKey, threadId: thread, turnId: turn,
      body: { input: [{ role: "user", content: policy.prompt }] }, relayInstanceId: "relay" }, now);
    const first = { requestId: randomUUID(), turnId: turn, identity: target.identity, fingerprint: hash("a") };
    store.beginTargetRequest(execution, lease.digest, "relay", first, now);
    store.close(); store = new ExecutionTargetLeaseStore(path);
    expect(() => store.beginTargetRequest(execution, lease.digest, "relay", { ...first, requestId: randomUUID() }, now)).toThrow();
    expect(() => store.beginTargetRequest(execution, lease.digest, "relay", { ...first, requestId: randomUUID(), fingerprint: hash("b") }, now)).toThrow();
    store.finishTargetRequest(execution, lease.digest, "relay", first.requestId, "completed", 200, now);
    expect(() => store.beginTargetRequest(execution, lease.digest, "relay", { ...first, requestId: randomUUID() }, now)).toThrow();
    const next = { ...first, requestId: randomUUID(), fingerprint: hash("b") };
    store.beginTargetRequest(execution, lease.digest, "relay", next, now);
    store.finishTargetRequest(execution, lease.digest, "relay", next.requestId, "failed", 0, now, "upstream_connect_error");
    expect(store.get(execution)).toMatchObject({ state: "closed", targetRequest: { state: "failed", status: 0, errorCode: "upstream_connect_error" } });
    expect(() => store.renew(execution, lease.digest, now)).toThrow();
    expect(() => store.beginTargetRequest(execution, lease.digest, "relay", { ...next, requestId: randomUUID(), fingerprint: hash("c") }, now)).toThrow();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("native encrypted history preserves compacted tool pairs without broadening ordinary replay or remote references", () => {
  const body = { input: [{ type: "compaction", encrypted_content: "opaque-original" },
    { type: "function_call_output", call_id: "call-inside-compaction", output: "local result" },
    { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "local_tool", parameters: {
      type: "object", properties: { file_id: { type: "string" }, container: { type: "string" } } } }] }] };
  const before = JSON.stringify(body);
  expect(nativeExecutionHistory(body)).toBe(true);
  expect(portableReplay(body)).toBeNull();
  expect(JSON.stringify(body)).toBe(before);
  expect(nativeExecutionHistory({ ...body, tools: [{ type: "code_interpreter", container: "foreign" }] })).toBe(false);
  expect(nativeExecutionHistory({ ...body, tools: [{ type: "namespace", tools: [{ type: "file_search", vector_store_ids: ["foreign"] }] }] })).toBe(false);
});
