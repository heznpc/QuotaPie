import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool, type PoolAccount, type SourceContinuationInput } from "../src/account-pool";
import { createCompactionHandler } from "../src/codex-compaction";
import type { CodexForkParentResult } from "../src/account-pool-lineage";

const now = 2_000_000_000_000;
const body = { model: "gpt-6-astra", input: [{ role: "user", content: "fixture" }] };
const opaque = { ...body, previous_response_id: "opaque-response", input: [
  ...body.input, { type: "reasoning", encrypted_content: "opaque-reasoning" },
] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qp-source-only-")), path = join(root, "pool.sqlite3");
  const source: PoolAccount = { id: "source", label: "fixture", identity: "source-identity", accessToken: "fixture-token",
    upstreamAccount: "fixture-workspace", tokenExpiresAt: now + 3600000, models: [body.model], remaining: 80, validUntil: now + 60000 };
  const lineage = new Map<string, CodexForkParentResult>();
  const pool = new AccountPool({ path, sourceAccount: source.id, accounts: () => [source],
    policy: () => ({ enabled: false, accounts: [] }), now: () => now,
    forkParent: thread => lineage.get(thread) ?? { status: "unknown" } });
  const db = new Database(path);
  const input = (threadId: string | null, value: unknown = body): SourceContinuationInput => ({ threadId, body: value,
    headers: new Headers({ authorization: `Bearer ${source.accessToken}`, "chatgpt-account-id": source.upstreamAccount,
      ...(threadId ? { "thread-id": threadId } : {}) }) });
  const bind = (thread: string, account = "source", identity = "source-identity", sourceIdentity = "source-identity") =>
    db.query("INSERT INTO bindings VALUES (?,?,?,?,?,?,?)").run("source", thread, account, identity, sourceIdentity, "fixture", now);
  const replay = (thread: string) => db.query("INSERT INTO replay_filters VALUES (?,?,?)").run("source", thread, "[]");
  const state = () => JSON.stringify(["bindings", "requests", "replay_filters", "source_credentials", "quota_observations"]
    .map(table => db.query(`SELECT * FROM ${table}`).all()));
  return { pool, source, lineage, input, bind, replay, state,
    close() { db.close(); pool.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("verified native source history retains opaque handles without routing, rewriting or database writes", () => {
  const f = fixture(), thread = randomUUID();
  try {
    f.lineage.set(thread, { status: "known", parentId: null });
    const request = f.input(thread, opaque), before = f.state(), bytes = JSON.stringify(request.body);
    f.pool.assertSourceContinuation(request);
    expect(f.state()).toBe(before); expect(JSON.stringify(request.body)).toBe(bytes);
    // A restarted guard can still use native profile evidence without inventing a pool binding.
    f.pool.assertSourceContinuation(f.input(thread, { ...opaque, previous_response_id: "next-response" }));
    expect(f.state()).toBe(before);
  } finally { f.close(); }
});

test("foreign bindings and replaced source identities stay blocked with routing disabled", () => {
  for (const [account, identity, sourceIdentity] of [
    ["other", "other-identity", "source-identity"],
    ["source", "old-identity", "source-identity"],
    ["source", "source-identity", "old-source-identity"],
  ]) {
    const f = fixture(), thread = randomUUID();
    try {
      f.bind(thread, account, identity, sourceIdentity);
      f.lineage.set(thread, { status: "known", parentId: null });
      const before = f.state();
      for (const request of [body, opaque])
        expect(() => f.pool.assertSourceContinuation(f.input(thread, request))).toThrow("pool_source_continuation_mismatch");
      expect(f.state()).toBe(before);
    } finally { f.close(); }
  }
});

test("all known ancestors must remain on the original source without replay history", () => {
  for (const foreign of [false, true]) {
    const f = fixture(), child = randomUUID(), parent = randomUUID(), root = randomUUID();
    try {
      f.lineage.set(child, { status: "known", parentId: parent });
      f.lineage.set(parent, { status: "known", parentId: root });
      f.lineage.set(root, { status: "known", parentId: null });
      f.bind(child); f.bind(root);
      f.pool.assertSourceContinuation(f.input(child, opaque));
      if (foreign) f.bind(parent, "other", "other-identity"); else f.replay(parent);
      expect(() => f.pool.assertSourceContinuation(f.input(child, opaque)))
        .toThrow(foreign ? "pool_source_continuation_mismatch" : "pool_source_history_unverified");
    } finally { f.close(); }
  }
});

test("a source binding with old replay state cannot silently switch back even for portable input", () => {
  const f = fixture(), thread = randomUUID();
  try {
    f.bind(thread); f.replay(thread); f.lineage.set(thread, { status: "known", parentId: null });
    expect(() => f.pool.assertSourceContinuation(f.input(thread))).toThrow("pool_source_history_unverified");
  } finally { f.close(); }
});

test("unbound complete portable history is allowed with missing thread metadata or no thread ID", () => {
  const f = fixture(), thread = randomUUID();
  const history = { ...body, input: [...body.input,
    { type: "function_call", call_id: "call", name: "fixture", arguments: "{}" },
    { type: "function_call_output", call_id: "call", output: "fixture-result" },
    { role: "assistant", content: "reply" }, { role: "user", content: "continue" }] };
  try {
    const before = f.state();
    f.pool.assertSourceContinuation(f.input(null, history));
    for (const status of ["unknown", "missing"] as const) {
      f.lineage.set(thread, { status }); f.pool.assertSourceContinuation(f.input(thread, history));
    }
    expect(f.state()).toBe(before);
  } finally { f.close(); }
});

test("unverified opaque references, item IDs and incomplete tools never pass as portable history", () => {
  const f = fixture(), thread = randomUUID();
  const histories = [opaque, { ...body, conversation: "foreign-conversation" },
    { ...body, input: [...body.input, { type: "compaction", encrypted_content: "opaque" }] },
    { ...body, input: [{ ...body.input[0], id: "foreign-item" }] },
    { ...body, input: [...body.input, { type: "function_call", call_id: "call", name: "fixture", arguments: "{}" }] }];
  try {
    for (const history of histories) for (const id of [null, thread])
      expect(() => f.pool.assertSourceContinuation(f.input(id, history))).toThrow("pool_source_history_unverified");
  } finally { f.close(); }
});

test("ephemeral fork claims must match native ancestry and cannot hide a foreign parent", () => {
  const f = fixture(), child = randomUUID(), parent = randomUUID();
  const request = f.input(child, opaque);
  request.headers.set("x-codex-turn-metadata", JSON.stringify({ thread_id: child, forked_from_thread_id: parent }));
  try {
    f.lineage.set(child, { status: "missing" }); f.lineage.set(parent, { status: "known", parentId: null });
    f.pool.assertSourceContinuation(request);
    f.bind(parent, "other", "other-identity");
    expect(() => f.pool.assertSourceContinuation(request)).toThrow("pool_source_continuation_mismatch");
    f.lineage.set(child, { status: "known", parentId: randomUUID() });
    expect(() => f.pool.assertSourceContinuation(request)).toThrow("pool_lineage_conflict");
  } finally { f.close(); }
});

test("known forks with missing ancestors, cycles and malformed fork claims fail closed", () => {
  const f = fixture(), child = randomUUID(), parent = randomUUID();
  try {
    f.lineage.set(child, { status: "known", parentId: parent });
    expect(() => f.pool.assertSourceContinuation(f.input(child))).toThrow("pool_lineage_unavailable");
    f.lineage.set(parent, { status: "known", parentId: child });
    expect(() => f.pool.assertSourceContinuation(f.input(child))).toThrow("pool_lineage_invalid");
    const malformed = f.input(child); malformed.headers.set("x-codex-turn-metadata", "not-json");
    expect(() => f.pool.assertSourceContinuation(malformed)).toThrow("pool_lineage_invalid");
  } finally { f.close(); }
});

test("source continuation requires the current source credentials and a consistent thread claim", () => {
  const f = fixture(), thread = randomUUID();
  try {
    const request = f.input(thread);
    request.headers.set("authorization", "Bearer foreign");
    expect(() => f.pool.assertSourceContinuation(request)).toThrow("pool_source_identity_mismatch");
    const mismatch = f.input(thread); mismatch.headers.set("thread-id", randomUUID());
    expect(() => f.pool.assertSourceContinuation(mismatch)).toThrow("pool_thread_identity_required");
    f.source.tokenExpiresAt = now;
    expect(() => f.pool.assertSourceContinuation(f.input(thread))).toThrow("pool_source_auth_unavailable");
  } finally { f.close(); }
});


test("interactive source history can be ephemeral, unreadable or ID-less without edits or new bindings", () => {
  const f = fixture(), thread = randomUUID();
  try {
    const before = f.state();
    const histories = [opaque, { ...body, input: [{ type: "compaction", encrypted_content: "opaque" }] },
      { ...body, input: [{ ...body.input[0], id: "native-item" }] },
      { ...body, input: [{ type: "function_call_output", call_id: "native-call", output: "result" }] }];
    for (const status of ["missing", "unknown"] as const) for (const history of histories) {
      f.lineage.set(thread, { status });
      for (const id of [thread, null]) {
        const request = { ...f.input(id, history), historyPolicy: "authenticated-source" as const };
        const bytes = JSON.stringify(request.body), headers = [...request.headers];
        f.pool.assertSourceContinuation(request);
        expect(JSON.stringify(request.body)).toBe(bytes); expect([...request.headers]).toEqual(headers);
      }
    }
    expect(f.state()).toBe(before);
  } finally { f.close(); }
});

test("interactive mode still checks claimed parents even when both rollouts are missing", () => {
  for (const status of ["missing", "unknown"] as const) {
    const f = fixture(), child = randomUUID(), parent = randomUUID();
    try {
      f.lineage.set(child, { status });
      const request = { ...f.input(child, opaque), historyPolicy: "authenticated-source" as const };
      request.headers.set("x-codex-turn-metadata", JSON.stringify({ thread_id: child, forked_from_thread_id: parent }));
      f.pool.assertSourceContinuation(request);
      f.bind(parent, "other", "other-identity");
      expect(() => f.pool.assertSourceContinuation(request)).toThrow("pool_source_continuation_mismatch");
    } finally { f.close(); }
  }
});

test("interactive mode retains identity, replay and ancestry conflict protection", () => {
  for (const conflict of ["identity", "binding", "replay", "fork", "cycle", "malformed"] as const) {
    const f = fixture(), child = randomUUID(), parent = randomUUID();
    try {
      const request = { ...f.input(child, opaque), historyPolicy: "authenticated-source" as const };
      if (conflict === "identity") request.headers.set("authorization", "Bearer other");
      if (conflict === "binding") f.bind(child, "other", "other-identity");
      if (conflict === "replay") f.replay(child);
      if (conflict === "fork") {
        f.lineage.set(child, { status: "known", parentId: parent });
        request.headers.set("x-codex-turn-metadata", JSON.stringify({ thread_id: child, forked_from_thread_id: randomUUID() }));
      }
      if (conflict === "cycle") {
        f.lineage.set(child, { status: "known", parentId: parent });
        f.lineage.set(parent, { status: "known", parentId: child });
      }
      if (conflict === "malformed") request.headers.set("x-codex-turn-metadata", "invalid");
      const before = f.state();
      expect(() => f.pool.assertSourceContinuation(request)).toThrow();
      expect(f.state()).toBe(before);
    } finally { f.close(); }
  }
});

test("interactive HTTP requests preserve native opaque history and credentials; managed requests remain strict", async () => {
  const f = fixture(), child = randomUUID();
  const ready = { version: 1 as const, ready: true, reason: "ready", checkedAtMs: now, account: "source", profileKey: "fixture", windows: [] };
  let calls = 0, upstreamStatus = 200;
  let dispatched: { url: string; init: RequestInit } | undefined;
  try {
    const make = (interactive: boolean, reportOnly = false) => createCompactionHandler({ accountPool: f.pool, reportOnly,
      sourceHistoryPolicy: interactive ? "authenticated-source" : undefined,
      subscriptionGuard: { intervalMs: 500, check: () => ready, checkIdentity: () => ready },
      fetchUpstream: async (url, init) => {
        calls++;
        dispatched = { url, init };
        return Response.json(upstreamStatus === 200
          ? { id: `response-${calls}`, status: "completed", model: body.model, output: [] }
          : { error: { message: "provider limit" } }, { status: upstreamStatus });
      } });
    const request = async (handler: ReturnType<typeof make>) => {
      const input = f.input(child, opaque);
      const response = await handler.fetch(new Request(`http://localhost${handler.prefix}/responses`, {
        method: "POST", headers: input.headers, body: JSON.stringify(input.body) }));
      await response.text(); return response.status;
    };
    const before = f.state(), interactive = make(true);
    expect(await request(interactive)).toBe(200); expect(calls).toBe(1);
    expect(dispatched!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(dispatched!.init.headers).get("authorization")).toBe("Bearer fixture-token");
    expect(new Headers(dispatched!.init.headers).get("chatgpt-account-id")).toBe("fixture-workspace");
    expect(await new Response(dispatched!.init.body).json()).toEqual(opaque);
    expect(interactive.snapshot().subscriptionGuard?.sourceHistoryPolicy).toBe("authenticated-source");
    expect(await request(make(false))).toBe(400); expect(calls).toBe(1);
    // A report-only managed caller cannot loosen its history checks.
    expect(await request(make(true, true))).toBe(400); expect(calls).toBe(1);
    upstreamStatus = 429;
    expect(await request(interactive)).toBe(429); expect(calls).toBe(2);
    expect(f.state()).toBe(before); // No cross-account recovery or history writes.
    f.bind(child, "other", "other-identity");
    expect(await request(interactive)).toBe(400); expect(calls).toBe(2);
  } finally { f.close(); }
});

test("async interactive ancestry checks consult a claimed parent despite unreadable child metadata", async () => {
  const f = fixture(), child = randomUUID(), parent = randomUUID();
  const root = mkdtempSync(join(tmpdir(), "qp-async-source-"));
  const seen: string[] = [];
  const pool = new AccountPool({ path: join(root, "pool.sqlite3"), sourceAccount: "source", accounts: () => [f.source],
    policy: () => ({ enabled: false, accounts: [] }), now: () => now,
    forkParentAsync: async id => { seen.push(id); return { status: "unknown" }; } });
  const db = new Database(join(root, "pool.sqlite3"));
  try {
    db.query("INSERT INTO bindings VALUES (?,?,?,?,?,?,?)").run("source", parent, "other", "other", "source-identity", "fixture", now);
    const request = { ...f.input(child, opaque), historyPolicy: "authenticated-source" as const };
    request.headers.set("x-codex-turn-metadata", JSON.stringify({ thread_id: child, forked_from_thread_id: parent }));
    await expect(pool.assertSourceContinuationAsync(request)).rejects.toThrow("pool_source_continuation_mismatch");
    expect(seen).toEqual([child, parent]);
  } finally { db.close(); pool.close(); f.close(); rmSync(root, { recursive: true, force: true }); }
});
