import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient, CodexQueueUnsupportedError, CodexSnapshotUnavailableError } from "../src/providers/codex-appserver";

const threadId = "11111111-2222-4333-8444-555555555555";
const turnId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const failedTurnId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const clientId = "quota-recovery-fixture";
const text = "Synthetic continuation";
const queued = { id: "queued-fixture", clientUserMessageId: clientId, input: [{ type: "text", text }] };
const item = { turnId, item: { id: "user-fixture", type: "userMessage", clientId, content: [{ type: "text", text }] } };
const turn = { id: turnId, status: "completed", completedAt: 1_800_000_000, itemsView: "notLoaded", items: [], error: null };

async function fixture(state: Record<string, unknown>, run: (client: CodexAppServerClient, calls: () => any[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-queue-")), binary = join(dir, "fake-codex");
  writeFileSync(join(dir, "auth.json"), "{}");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ email: "fixture@example.invalid", queued, item, turn, ...state }));
  writeFileSync(binary, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const home = process.env.CODEX_HOME;
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.id == null) continue;
  appendFileSync(home + '/calls.jsonl', JSON.stringify(req) + '\\n');
  const path = home + '/state.json', state = JSON.parse(readFileSync(path, 'utf8'));
  let result = {};
  if (req.method === 'account/read') {
    result = state.noIdentity ? {} : { account: { type:'chatgpt', email:state.email } };
    if (state.beforeCredentialRace) { writeFileSync(home + '/auth.json', '{"changed":true}'); writeFileSync(path, JSON.stringify({...state,beforeCredentialRace:false})); }
  }
  if (req.method.startsWith('thread/')) {
    if (state.lostAck && req.method === 'thread/queue/add') process.exit(0);
    if (state.rpcError) { console.log(JSON.stringify({id:req.id,error:{code:state.rpcError,message:'private server error'}})); continue; }
    if (state.accountRace) writeFileSync(path, JSON.stringify({...state,email:'changed@example.invalid',accountRace:false}));
    if (state.credentialRace) writeFileSync(home + '/auth.json', '{"changed":true}');
    if (req.method === 'thread/queue/list') result = state.listResult ?? {data:[state.queued],nextCursor:null};
    if (req.method === 'thread/queue/add') result = state.addResult ?? {queuedSubmission:state.queued};
    if (req.method === 'thread/queue/delete') result = state.deleteResult ?? {deleted:true};
    if (req.method === 'thread/items/list') result = state.itemsResult ?? (state.pages ? state.pages[req.params.cursor ? Number(req.params.cursor) : 0] : {data:[state.item],nextCursor:null});
    if (req.method === 'thread/turns/list') result = state.turnsResult ?? {data:[state.turn],nextCursor:null};
  }
  console.log(JSON.stringify({id:req.id,result}));
}
`, { mode: 0o700 });
  const client = new CodexAppServerClient(binary, "fixture", 2_000, dir);
  const calls = () => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  try { await run(client, calls); }
  finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("queue reads sanitize private input and bracket the operation with identity checks", async () => {
  await fixture({}, async (client, calls) => {
    expect(await client.listThreadQueue(threadId, { limit: 1 })).toEqual({ data: [{ id: queued.id, clientUserMessageId: clientId }], nextCursor: null });
    expect(calls().map(r => r.method)).toEqual(["initialize", "account/read", "thread/queue/list", "account/read"]);
    expect(calls()[2].params).toEqual({ threadId, limit: 1 });
  });
});

test("add sends exactly the requested text and returns only a validated receipt", async () => {
  await fixture({}, async (client, calls) => {
    expect(await client.addThreadQueue(threadId, clientId, text)).toEqual({ id: queued.id, clientUserMessageId: clientId });
    expect(calls().filter(r => r.method === "thread/queue/add")).toEqual([
      expect.objectContaining({ params: { threadId, clientUserMessageId: clientId, input: [{ type: "text", text }] } }),
    ]);
  });
});

test("lost add acknowledgement is never transport-retried", async () => {
  await fixture({ lostAck: true }, async (client, calls) => {
    await expect(client.addThreadQueue(threadId, clientId, text)).rejects.toThrow("delivery may be unknown");
    expect(calls().filter(r => r.method === "thread/queue/add")).toHaveLength(1);
    expect(calls().filter(r => r.method === "initialize")).toHaveLength(1);
  });
});

test("the final synchronous veto runs after identity awaits and before any queue write", async () => {
  await fixture({}, async (client, calls) => {
    let authorized = true, vetoChecked = false;
    const pending = client.addThreadQueue(threadId, clientId, text, () => {
      vetoChecked = true;
      expect(calls().at(-1).method).toBe("account/read");
      if (!authorized) throw new Error("host-queue-authorization-changed");
    });
    authorized = false;
    await expect(pending).rejects.toThrow("host-queue-authorization-changed");
    expect(vetoChecked).toBe(true);
    expect(calls().some(r => r.method === "thread/queue/add")).toBe(false);
  });
});

test.each([true, false])("delete preserves host consumed/missing result %s without issuing turn actions", async deleted => {
  await fixture({ deleteResult: { deleted } }, async (client, calls) => {
    expect(await client.deleteThreadQueue(threadId, queued.id)).toBe(deleted);
    expect(calls().find(r => r.method === "thread/queue/delete").params).toEqual({ threadId, queuedSubmissionId: queued.id });
    expect(calls().some(r => /turn\/(start|interrupt)|queue\/start/.test(r.method))).toBe(false);
  });
});

test.each(["list", "add", "delete", "correlate"])("unsupported %s is explicit", async operation => {
  await fixture({ rpcError: -32601 }, async client => {
    const result = operation === "list" ? client.listThreadQueue(threadId) : operation === "add" ? client.addThreadQueue(threadId, clientId, text)
      : operation === "delete" ? client.deleteThreadQueue(threadId, queued.id) : client.readTurnForClientMessage(threadId, clientId);
    await expect(result).rejects.toBeInstanceOf(CodexQueueUnsupportedError);
  });
});

test.each([{ noIdentity: true }, { beforeCredentialRace: true }])("untrusted identity prevents queue mutation", async state => {
  await fixture(state, async (client, calls) => {
    await expect(client.addThreadQueue(threadId, clientId, text)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
    expect(calls().some(r => r.method === "thread/queue/add")).toBe(false);
  });
});

test.each([{ accountRace: true }, { credentialRace: true }])("an in-flight account change rejects the receipt without resending", async state => {
  await fixture(state, async (client, calls) => {
    await expect(client.addThreadQueue(threadId, clientId, text)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
    expect(calls().filter(r => r.method === "thread/queue/add")).toHaveLength(1);
  });
});

test.each([
  { addResult: { queuedSubmission: { ...queued, clientUserMessageId: "foreign" } } },
  { addResult: { queuedSubmission: { ...queued, input: [{ type: "text", text: "different" }] } } },
  { addResult: { queuedSubmission: { ...queued, id: "" } } },
  { addResult: { threadId: failedTurnId, queuedSubmission: queued } },
])("malformed or mismatched add receipts fail closed", async state => {
  await fixture(state, async client => { await expect(client.addThreadQueue(threadId, clientId, text)).rejects.toThrow("invalid response"); });
});

test.each([
  { listResult: { data: [queued, queued] } }, { listResult: { data: [{}] } },
  { listResult: { data: [], nextCursor: 3 } }, { listResult: { threadId: failedTurnId, data: [] } },
  { listResult: { data: [{ ...queued, input: [{ type: "image" }] }] } }, { listResult: [] },
])("invalid queue pages cannot masquerade as an empty queue", async state => {
  await fixture(state, async client => { await expect(client.listThreadQueue(threadId)).rejects.toThrow("invalid response"); });
});

test("correlation uses exact persisted clientId and returns metadata only", async () => {
  await fixture({}, async (client, calls) => {
    expect(await client.readTurnForClientMessage(threadId, clientId)).toEqual({ threadId, turnId, status: "completed", errorCode: null, completedAtMs: 1_800_000_000_000 });
    expect(calls().map(r => r.method)).toEqual(["initialize", "account/read", "thread/items/list", "thread/turns/list", "account/read"]);
    expect(calls().find(r => r.method === "thread/turns/list").params.itemsView).toBe("notLoaded");
  });
});

test("a login different from the last quota-verified account cannot submit", async () => {
  await fixture({}, async (client, calls) => {
    (client as any).remoteAccount = "original@example.invalid";
    await expect(client.addThreadQueue(threadId, clientId, text)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
    expect(calls().some(r => r.method === "thread/queue/add")).toBe(false);
  });
});

test("an already-correlated turn can be polled without reading its growing items", async () => {
  await fixture({ turn: { ...turn, status: "interrupted", error: { codexErrorInfo: null, message: "private detail" } } }, async (client, calls) => {
    expect(await client.readTurn(threadId, turnId)).toEqual({ threadId, turnId, status: "interrupted", errorCode: null, completedAtMs: 1_800_000_000_000 });
    expect(calls().map(r => r.method)).toEqual(["initialize", "account/read", "thread/turns/list", "account/read"]);
  });
});

test("exact turn lookup never substitutes an unrelated latest turn", async () => {
  await fixture({}, async client => { expect(await client.readTurn(threadId, failedTurnId)).toBeNull(); });
});

test("delete requires an explicit boolean acknowledgement", async () => {
  await fixture({ deleteResult: { deleted: "true" } }, async client => {
    await expect(client.deleteThreadQueue(threadId, queued.id)).rejects.toThrow("invalid response");
  });
});

test("correlation paginates up to the original failed-turn boundary, excluding older messages", async () => {
  await fixture({ pages: [{ data: [{ ...item, item: { ...item.item, id: "foreign", clientId: "different" } }], nextCursor: "1" },
    { data: [item, { ...item, turnId: failedTurnId, item: { ...item.item, id: "old" } }], nextCursor: "2" }] }, async (client, calls) => {
    expect((await client.readTurnForClientMessage(threadId, clientId, failedTurnId))?.turnId).toBe(turnId);
    expect(calls().filter(r => r.method === "thread/items/list")).toHaveLength(2);
  });
});

test("correlation never guesses from matching text or the latest unrelated turn", async () => {
  await fixture({ item: { ...item, item: { ...item.item, clientId: "different" } } }, async (client, calls) => {
    expect(await client.readTurnForClientMessage(threadId, clientId)).toBeNull();
    expect(calls().some(r => r.method === "thread/turns/list")).toBe(false);
  });
});

test.each([
  { itemsResult: { data: [item, { ...item, item: { ...item.item, id: "duplicate-client" } }] } },
  { itemsResult: { data: [item], nextCursor: "loop" } },
  { itemsResult: { data: [{ ...item, turnId: "invalid" }] } },
  { itemsResult: { threadId: failedTurnId, data: [item] } },
  { turnsResult: { data: [] } },
  { turnsResult: { data: [{ ...turn, items: [{ text: "unexpected body" }] }] } },
])("ambiguous or incomplete correlation is never accepted", async state => {
  await fixture(state, async client => { await expect(client.readTurnForClientMessage(threadId, clientId)).rejects.toThrow(); });
});

test("bounded correlation exhaustion remains unknown, not a safe-to-resend miss", async () => {
  await fixture({ pages: Array.from({ length: 5 }, (_, index) => ({ data: [{ ...item, item: { ...item.item, id: `item-${index}`, clientId: `other-${index}` } }], nextCursor: String(index + 1) })) }, async (client, calls) => {
    await expect(client.readTurnForClientMessage(threadId, clientId)).rejects.toBeInstanceOf(CodexSnapshotUnavailableError);
    expect(calls().filter(r => r.method === "thread/items/list")).toHaveLength(5);
  });
});
