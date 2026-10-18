import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient, CodexGoalUnsupportedError, CodexSnapshotUnavailableError, CodexTurnUnsupportedError } from "../src/providers/codex-appserver";

const threadId = "11111111-2222-4333-8444-555555555555";
const goal = {
  threadId, objective: "Finish the fixture task", status: "active" as const,
  tokenBudget: 20_000, tokensUsed: 2_500, timeUsedSeconds: 30, createdAt: 1_800_000_000, updatedAt: 1_800_000_030,
};

function fixture(state: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-host-goal-"));
  const binary = join(dir, "fake-codex");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "auth.json"), "{}");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ email: "fixture@example.invalid", result: { goal }, ...state }));
  writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const home = process.env.CODEX_HOME;
const path = home + '/state.json';
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.id == null) continue;
  appendFileSync(home + '/calls.jsonl', JSON.stringify({ method: req.method, params: req.params }) + '\\n');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  let result = {};
  if (req.method === 'account/read') {
    if (state.identityError) {
      console.log(JSON.stringify({ id: req.id, error: { code: state.identityError, message: 'Synthetic identity failure' } }));
      continue;
    }
    result = state.noIdentity ? {} : { account: { type: 'chatgpt', email: state.email } };
  }
  if (req.method === 'thread/goal/get') {
    if (state.accountRace) writeFileSync(path, JSON.stringify({ ...state, email: 'changed@example.invalid', accountRace: false }));
    if (state.credentialRace) writeFileSync(home + '/auth.json', '{"changed":true}');
    if (state.goalError) {
      console.log(JSON.stringify({ id: req.id, error: { code: state.goalError, message: 'Synthetic goal failure' } }));
      continue;
    }
    result = state.result;
  }
  if (req.method === 'thread/turns/list') {
    if (state.accountRace) writeFileSync(path, JSON.stringify({ ...state, email: 'changed@example.invalid', accountRace: false }));
    if (state.credentialRace) writeFileSync(home + '/auth.json', '{"changed":true}');
    if (state.turnError) {
      console.log(JSON.stringify({ id: req.id, error: { code: state.turnError, message: 'Synthetic turn failure' } }));
      continue;
    }
    result = state.turnResult;
  }
  if (req.method === 'thread/list') result = state.threadResult;
  console.log(JSON.stringify({ id: req.id, result }));
}
`, { mode: 0o700 });
  return {
    dir, calls,
    client: new CodexAppServerClient(binary, "fixture", 2_000, dir),
    requests: () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

async function withFixture(state: Record<string, unknown>, run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture(state);
  try { await run(f); }
  finally { await f.client.close(); rmSync(f.dir, { recursive: true, force: true }); }
}

test("reads only the requested goal between stable identity checks and drops unrelated provider fields", async () => {
  await withFixture({ result: { goal: { ...goal, preview: "private transcript", path: "/private/path", accessToken: "private token" } } }, async f => {
    expect(await f.client.readThreadGoal(threadId)).toEqual(goal);
    expect(f.requests().map(request => request.method)).toEqual(["initialize", "account/read", "thread/goal/get", "account/read"]);
    expect(f.requests().find(request => request.method === "thread/goal/get").params).toEqual({ threadId });
    expect(f.requests().filter(request => request.method === "account/read").map(request => request.params)).toEqual([
      { refreshToken: false }, { refreshToken: false },
    ]);
  });
});

test.each(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"])("preserves host goal state %s", async status => {
  await withFixture({ result: { goal: { threadId, objective: "Fixture", status, tokenBudget: null } } }, async f => {
    expect(await f.client.readThreadGoal(threadId)).toEqual({ threadId, objective: "Fixture", status, tokenBudget: null });
  });
});

test.each([{ goal: null }, {}])("a valid empty goal response means no goal", async result => {
  await withFixture({ result }, async f => { expect(await f.client.readThreadGoal(threadId)).toBeNull(); });
});

test("unsupported goal lookup is distinct from missing goal and unrelated RPC failures", async () => {
  await withFixture({ goalError: -32601 }, async f => {
    await expect(f.client.readThreadGoal(threadId)).rejects.toBeInstanceOf(CodexGoalUnsupportedError);
  });
  await withFixture({ goalError: -32603 }, async f => {
    let failure: unknown;
    try { await f.client.readThreadGoal(threadId); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CodexGoalUnsupportedError);
  });
});

test.each([{ noIdentity: true }, { identityError: -32601 }, { identityError: -32603 }])("unverified identity prevents the goal request", async state => {
  await withFixture(state, async f => {
    await expect(f.client.readThreadGoal(threadId)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
    expect(f.requests().some(request => request.method === "thread/goal/get")).toBe(false);
  });
});

test.each([{ accountRace: true }, { credentialRace: true }])("login or credential changes invalidate an in-flight goal snapshot", async state => {
  await withFixture(state, async f => {
    await expect(f.client.readThreadGoal(threadId)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
  });
});

test.each([
  { goal: { ...goal, threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } },
  { goal: { ...goal, status: "finished" } },
  { goal: { ...goal, objective: null } },
  { goal: { ...goal, tokensUsed: -1 } },
  { goal: { ...goal, timeUsedSeconds: 0.5 } },
  { goal: { ...goal, updatedAt: Number.MAX_SAFE_INTEGER + 1 } },
  { goal: { ...goal, tokenBudget: "20000" } },
  { goal: [] },
  null,
])("invalid or mismatched goal metadata is never accepted", async result => {
  await withFixture({ result }, async f => {
    await expect(f.client.readThreadGoal(threadId)).rejects.toThrow("invalid response");
  });
});

const turn = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "failed", completedAt: 1_800_000_000,
  items: [], itemsView: "notLoaded", error: { codexErrorInfo: "usageLimitExceeded", message: "private failure text" } };

test("latest turn reads request no items and preserve only typed incident metadata between identity checks", async () => {
  await withFixture({ turnResult: { data: [{ ...turn, extra: "private transcript" }] } }, async f => {
    expect(await f.client.readLatestTurn(threadId)).toEqual({ threadId, turnId: turn.id, status: "failed",
      errorCode: "usageLimitExceeded", completedAtMs: 1_800_000_000_000 });
    expect(f.requests().map(r => r.method)).toEqual(["initialize", "account/read", "thread/turns/list", "account/read"]);
    expect(f.requests().find(r => r.method === "thread/turns/list").params).toEqual({ threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  });
});

test.each(["completed", "interrupted", "inProgress"])("latest turn preserves non-quota state %s", async status => {
  await withFixture({ turnResult: { data: [{ ...turn, status, error: null, completedAt: null }] } }, async f => {
    expect(await f.client.readLatestTurn(threadId)).toMatchObject({ status, errorCode: null, completedAtMs: null });
  });
});

test("missing, unsupported and failed turn lookups are distinct", async () => {
  await withFixture({ turnResult: { data: [] } }, async f => { expect(await f.client.readLatestTurn(threadId)).toBeNull(); });
  await withFixture({ turnError: -32601 }, async f => {
    await expect(f.client.readLatestTurn(threadId)).rejects.toBeInstanceOf(CodexTurnUnsupportedError);
  });
  await withFixture({ turnError: -32603 }, async f => {
    await expect(f.client.readLatestTurn(threadId)).rejects.toThrow();
  });
});

test.each([{ noIdentity: true }, { identityError: -32601 }, { identityError: -32603 }, { accountRace: true }, { credentialRace: true }])(
  "turn evidence rejects missing or changed account identity", async state => {
    await withFixture({ turnResult: { data: [turn] }, ...state }, async f => {
      await expect(f.client.readLatestTurn(threadId)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
    });
  });

test.each([
  { data: [turn, turn] }, {}, null, { data: [{ ...turn, id: "not-a-uuid" }] },
  { data: [{ ...turn, status: "unknown" }] }, { data: [{ ...turn, completedAt: -1 }] },
  { data: [{ ...turn, completedAt: 1.25 }] }, { data: [{ ...turn, itemsView: "full" }] },
  { data: [{ ...turn, items: [{ text: "private body" }] }] },
  { data: [{ ...turn, status: "completed" }] },
])("invalid latest turn payload cannot become an eligible quota incident", async turnResult => {
  await withFixture({ turnResult }, async f => { await expect(f.client.readLatestTurn(threadId)).rejects.toThrow("invalid response"); });
});

test("thread list exposes valid millisecond update times without preview text", async () => {
  await withFixture({ threadResult: { data: [{ id: threadId, cwd: "/fixture", updatedAt: 1_800_000_000, preview: "private" },
    { id: turn.id, cwd: "/fixture", updatedAt: "invalid" }] } }, async f => {
    expect((await f.client.listThreads()).data).toEqual([
      { id: threadId, cwd: "/fixture", name: null, updatedAtMs: 1_800_000_000_000 },
      { id: turn.id, cwd: "/fixture", name: null },
    ]);
  });
});
