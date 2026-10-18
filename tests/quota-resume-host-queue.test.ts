import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { CodexThreadTurnSummary } from "../src/providers/codex-appserver";
import { executeHostQueuedQuotaResume, hostQueueClientMessageId, observeHostQueueReceipt,
  type HostQueueClient, type HostQueueOptions, type HostQueueReceipt } from "../src/quota-resume/host-queue";
import type { QuotaResumeEvidence } from "../src/quota-resume/evidence";
import type { WorkPolicy } from "../src/work/types";

const threadId = "11111111-1111-4111-8111-111111111111";
const failedTurnId = "22222222-2222-4222-8222-222222222222";
const ownTurnId = "33333333-3333-4333-8333-333333333333";
const queuedId = "44444444-4444-4444-8444-444444444444";
const otherQueuedId = "55555555-5555-4555-8555-555555555555";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-host-queue-")); directories.push(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "plus", label: "Plus", enabled: true, codexHome: root }];
  const policy: WorkPolicy = {
    id: "incident", provider: "codex", account: "plus", profileKey: root, accountKey: "account-a",
    purpose: "quota-resume", quotaResume: { turnId: failedTurnId, stamp: "same-snapshot" },
    nativeSessionId: threadId, cwd: root, model: "gpt-6.1-sol", prompt: "Continue the original request once.",
    objective: "One continuation", completionCriteria: ["One turn ended"], dispatchOwner: "local", enabled: true,
    trigger: "quota-ready", resetWithinMinutes: 60, budgetByBucket: { weekly: { reservePercent: 5, maxUsagePercent: 20 } },
    maxTurns: 1, maxDurationSeconds: 1, maxTotalDurationSeconds: 1, expiresAtMs: 100_000, priority: 0, onReset: "continue",
    revision: 1, state: { turns: 0, spentByBucket: {}, baselines: {}, totalDurationSeconds: 0, status: "running", activeExecutionId: "claim" },
  };
  const state = {
    now: 10_000, authorized: true, writer: true, lists: 0, adds: 0, deletes: [] as string[],
    queue: [] as Array<{ id: string; clientUserMessageId: string }>, receipts: [] as HostQueueReceipt[],
    turn: null as CodexThreadTurnSummary | null,
    evidence: { threadId, turnId: failedTurnId, failedAtMs: 9_000, stamp: "same-snapshot", cwd: root, model: policy.model! } as QuotaResumeEvidence | null,
    lookups: [] as Array<[string, string, string | undefined]>, order: [] as string[],
  };
  const client: HostQueueClient = {
    listThreadQueue: async () => { state.lists++; return { data: [...state.queue], nextCursor: null }; },
    addThreadQueue: async (id, clientId, text, beforeWrite) => {
      beforeWrite?.();
      state.adds++; state.order.push("add");
      expect(id).toBe(threadId); expect(text).toBe(policy.prompt);
      const item = { id: queuedId, clientUserMessageId: clientId }; state.queue.push(item); return item;
    },
    deleteThreadQueue: async (id, itemId) => {
      expect(id).toBe(threadId); state.deletes.push(itemId);
      state.queue = state.queue.filter(item => item.id !== itemId); return true;
    },
    readTurnForClientMessage: async (id, clientId, after) => { state.lookups.push([id, clientId, after]); return state.turn; },
  };
  const options: HostQueueOptions = {
    client, stillAuthorized: () => state.authorized, hasNativeWriter: () => state.writer, evidenceStillCurrent: () => true,
    beforeEnqueue: async () => { state.order.push("validate"); },
    onReceipt: receipt => { state.receipts.push({ ...receipt }); state.order.push(receipt.turnId ? "turn" : receipt.queuedSubmissionId ? "ack" : "intent"); },
    readEvidence: async (_config, account, id, opts) => {
      expect(account).toBe("plus"); expect(id).toBe(threadId); expect(opts?.allowNativeWriter).toBe(true); return state.evidence;
    },
    now: () => state.now, sleep: async ms => { state.now += ms; }, pollMs: 100,
  };
  const run = () => executeHostQueuedQuotaResume({ config, policy, claimId: "claim-once" }, options);
  const terminal = (status: CodexThreadTurnSummary["status"] = "completed", errorCode: string | null = null): CodexThreadTurnSummary => ({
    threadId, turnId: ownTurnId, status, errorCode, completedAtMs: status === "inProgress" ? null : state.now,
  });
  return { config, policy, state, client, options, run, terminal };
}

test("durable intent precedes one unchanged prompt and only its correlated terminal proves a finished turn", async () => {
  const f = fixture();
  f.options.sleep = async ms => { f.state.now += ms; f.state.turn = f.terminal(); f.state.queue = []; };
  const result = await f.run();
  expect(result).toMatchObject({ status: "turn-finished", summary: "1회 재개 종료" });
  expect(result.remainingWork).toContain("아직 확인하지 않았습니다");
  expect(f.state.order).toEqual(["validate", "validate", "intent", "add", "ack", "turn"]);
  expect(f.state.adds).toBe(1); expect(f.state.deletes).toEqual([]);
  expect(f.state.receipts).toHaveLength(3);
  expect(f.state.receipts[2]).toEqual({ threadId, clientUserMessageId: hostQueueClientMessageId("claim-once"), sentAtMs: 10_000, queuedSubmissionId: queuedId, turnId: ownTurnId });
  expect(f.state.lookups.every(args => args[2] === failedTurnId)).toBe(true);
  expect(hostQueueClientMessageId("claim-once")).toBe(hostQueueClientMessageId("claim-once"));
  expect(hostQueueClientMessageId("claim-once")).not.toBe(hostQueueClientMessageId("another-claim"));
});

test("foreign queued input, including one arriving during preflight, prevents enqueue", async () => {
  for (const arrivesLater of [false, true]) {
    const f = fixture(), item = { id: otherQueuedId, clientUserMessageId: "foreign-message" };
    if (arrivesLater) f.options.beforeEnqueue = async () => { f.state.queue.push(item); };
    else f.state.queue.push(item);
    expect(await f.run()).toMatchObject({ status: "activity-paused", reason: "host-queue-not-empty" });
    expect(f.state.adds).toBe(0); expect(f.state.receipts).toEqual([]); expect(f.state.deletes).toEqual([]);
  }
});

test("changed failure evidence, lost native owner and host-goal veto cannot send", async () => {
  for (const failure of ["evidence", "writer", "goal", "permission"] as const) {
    const f = fixture();
    if (failure === "evidence") f.state.evidence!.stamp = "new-user-message";
    if (failure === "writer") f.state.writer = false;
    if (failure === "goal") f.options.beforeEnqueue = async () => { throw new Error("host-goal-not-active"); };
    if (failure === "permission") f.options.beforeEnqueue = async () => { f.state.authorized = false; };
    expect((await f.run()).status).not.toBe("turn-finished");
    expect(f.state.adds).toBe(0); expect(f.state.receipts).toEqual([]);
  }
});

test("failed durable intent save and permission revocation during its save do not enqueue", async () => {
  for (const throws of [true, false]) {
    const f = fixture();
    f.options.onReceipt = async () => { if (throws) throw new Error("receipt-save-failed"); f.state.authorized = false; };
    expect((await f.run()).status).not.toBe("turn-finished"); expect(f.state.adds).toBe(0);
  }
});

test("a goal changed during the final evidence read is checked again before enqueue", async () => {
  const f = fixture(); let goalActive = true, goalReads = 0;
  f.options.beforeEnqueue = async () => { goalReads++; if (!goalActive) throw new Error("host-goal-not-active"); };
  f.options.readEvidence = async () => { goalActive = false; return f.state.evidence; };
  expect(await f.run()).toMatchObject({ status: "failed", reason: "host-goal-not-active" });
  expect(goalReads).toBe(2); expect(f.state.adds).toBe(0); expect(f.state.receipts).toEqual([]);
});

test("the final provider write callback rejects permission and evidence changes during connection", async () => {
  for (const changed of ["permission", "evidence"] as const) {
    const f = fixture(), add = f.client.addThreadQueue; let sameEvidence = true;
    f.options.evidenceStillCurrent = () => sameEvidence;
    f.client.addThreadQueue = async (...args) => {
      if (changed === "permission") f.state.authorized = false;
      else sameEvidence = false;
      return add(...args);
    };
    expect((await f.run()).status).toBe("uncertain"); expect(f.state.adds).toBe(0);
    expect(f.state.receipts).toHaveLength(1);
  }
});

test("lost enqueue acknowledgement never resends and deletion remains uncertain", async () => {
  const f = fixture(), add = f.client.addThreadQueue;
  f.client.addThreadQueue = async (...args) => { await add(...args); throw new Error("transport-timeout"); };
  expect(await f.run()).toMatchObject({ status: "uncertain", reason: "transport-timeout" });
  expect(f.state.adds).toBe(1); expect(f.state.deletes).toEqual([queuedId]);
  expect(f.state.receipts[0]?.queuedSubmissionId).toBeUndefined();
  expect(f.state.receipts.at(-1)?.queuedSubmissionId).toBe(queuedId);
});

test("lost ack can close only on a correlated terminal, not on queue absence", async () => {
  for (const completed of [false, true]) {
    const f = fixture(), add = f.client.addThreadQueue;
    f.client.addThreadQueue = async (...args) => {
      await add(...args); f.state.queue = []; if (completed) f.state.turn = f.terminal(); throw new Error("transport-timeout");
    };
    expect((await f.run()).status).toBe(completed ? "turn-finished" : "uncertain");
    expect(f.state.adds).toBe(1); expect(f.state.deletes).toEqual([]);
  }
});

test("timeout deletes only its own visible queue row but does not claim cancellation", async () => {
  const f = fixture();
  f.options.sleep = async ms => {
    f.state.now += ms;
    if (f.state.queue.length === 1) f.state.queue.push({ id: otherQueuedId, clientUserMessageId: "foreign" });
  };
  expect(await f.run()).toMatchObject({ status: "uncertain", reason: "host-queue-timeout" });
  expect(f.state.adds).toBe(1); expect(f.state.deletes).toEqual([queuedId]);
  expect(f.state.queue).toEqual([{ id: otherQueuedId, clientUserMessageId: "foreign" }]);
});

test("abort after acceptance preserves a consumed host turn and records running identity", async () => {
  const f = fixture(), abort = new AbortController(); f.options.signal = abort.signal;
  f.state.turn = f.terminal("inProgress");
  f.options.sleep = async () => { f.state.queue = []; abort.abort(); };
  expect(await f.run()).toMatchObject({ status: "uncertain", reason: "host-queue-authorization-changed" });
  expect(f.state.deletes).toEqual([]); expect(f.state.adds).toBe(1);
  expect(f.state.receipts.at(-1)?.turnId).toBe(ownTurnId);
});

test("a host consuming a row concurrently with delete can still prove completion", async () => {
  const f = fixture(); f.options.sleep = async () => { f.state.authorized = false; };
  f.client.deleteThreadQueue = async (_id, itemId) => { f.state.deletes.push(itemId); f.state.queue = []; f.state.turn = f.terminal(); return true; };
  expect((await f.run()).status).toBe("turn-finished"); expect(f.state.deletes).toEqual([queuedId]);
});

test("correlated quota failure and manual interruption remain distinct from completion", async () => {
  for (const [status, code, expected] of [
    ["failed", "usageLimitExceeded", "quota-blocked"], ["failed", "other", "failed"], ["interrupted", null, "activity-paused"],
  ] as const) {
    const f = fixture(); f.state.turn = f.terminal(status, code);
    expect((await f.run()).status).toBe(expected); expect(f.state.adds).toBe(1);
  }
});

test("a real host's provisional interrupted snapshot without an end time is not terminal", async () => {
  const f=fixture();
  // The real Plus host's persisted metadata briefly exposed this snapshot
  // while its owning app-server was still generating the verification reply.
  f.state.turn={...f.terminal("interrupted"),completedAtMs:null};
  f.options.sleep=async ms=>{f.state.now+=ms;f.state.turn=f.terminal();f.state.queue=[];};
  const result=await f.run();
  expect(result.status).toBe("turn-finished");
  expect(f.state.adds).toBe(1);
  expect(f.state.deletes).toEqual([]);
  expect(f.state.receipts.at(-1)?.turnId).toBe(ownTurnId);
});

test("restart reconciliation recovers an acknowledged queue id without sending, then observes its turn", async () => {
  const f = fixture(); const receipt: HostQueueReceipt = { threadId, clientUserMessageId: hostQueueClientMessageId("claim-once"), sentAtMs: 10_000 };
  f.state.queue.push({ id: queuedId, clientUserMessageId: receipt.clientUserMessageId });
  const opts = { client: f.client, onReceipt: f.options.onReceipt, afterTurnId: failedTurnId };
  expect(await observeHostQueueReceipt(receipt, opts)).toBeNull(); expect(receipt.queuedSubmissionId).toBe(queuedId);
  f.state.queue = []; f.state.turn = f.terminal();
  expect((await observeHostQueueReceipt(receipt, opts))?.status).toBe("turn-finished");
  expect(f.state.adds).toBe(0); expect(f.state.deletes).toEqual([]);
});

test("an observed turn identity cannot be replaced by another completed turn", async () => {
  const f = fixture(); const receipt: HostQueueReceipt = { threadId, clientUserMessageId: hostQueueClientMessageId("claim-once"), sentAtMs: 10_000, turnId: failedTurnId };
  f.state.turn = f.terminal();
  await expect(observeHostQueueReceipt(receipt, { client: f.client, onReceipt: f.options.onReceipt, afterTurnId: failedTurnId }))
    .rejects.toThrow("host-queue-turn-identity-changed");
  expect(f.state.adds).toBe(0); expect(f.state.receipts).toEqual([]);
});

test("after correlation, restart reconciliation reads exact turn metadata without rescanning items", async () => {
  const f = fixture(), receipt: HostQueueReceipt = { threadId, clientUserMessageId: hostQueueClientMessageId("claim-once"), sentAtMs: 10_000, turnId: ownTurnId };
  let exactReads = 0;
  f.client.readTurn = async (id, turn) => { expect(id).toBe(threadId); expect(turn).toBe(ownTurnId); exactReads++; return f.terminal(); };
  f.client.readTurnForClientMessage = async () => { throw new Error("history-bound-exceeded"); };
  expect((await observeHostQueueReceipt(receipt, { client: f.client, onReceipt: f.options.onReceipt, afterTurnId: failedTurnId }))?.status).toBe("turn-finished");
  expect(exactReads).toBe(1); expect(f.state.adds).toBe(0);
});
