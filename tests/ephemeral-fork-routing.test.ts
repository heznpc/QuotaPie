import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool, type PoolAccount } from "../src/account-pool";
import { readCodexForkParent } from "../src/account-pool-lineage";
import { startCompactionProxy } from "../src/codex-compaction";
import { codexRequestIdentity } from "../src/codex-request-identity";

const model = "gpt-6-astra";
const history = { model, stream: true, input: [
  { type: "compaction", encrypted_content: "synthetic-account-bound-history" },
  { type: "agent_message", author: "/root", recipient: "all", content: "synthetic" },
  { role: "user", content: "continue" },
] };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qp-ephemeral-"));
  const now = Date.now(), parent = randomUUID(), child = randomUUID();
  const state = new Database(join(root, "state_5.sqlite"));
  state.run("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
  const persist = (id: string, forked_from_id?: string) => {
    const path = join(root, id + ".jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, forked_from_id } }) + "\n");
    state.query("INSERT OR REPLACE INTO threads VALUES (?,?)").run(id, path);
  };
  persist(parent);
  const accounts: PoolAccount[] = ["a", "b"].map(id => ({ id, label: id, identity: id + "-identity",
    accessToken: id + "-token", upstreamAccount: id + "-remote", tokenExpiresAt: now + 3600_000,
    models: [model], remaining: 90, validUntil: now + 60_000, observedAtMs: now }));
  const policy = { enabled: true, accounts: ["a", "b"], reservePercent: { a: 0 } };
  const path = join(root, "pool.sqlite3");
  const options = { path, sourceAccount: "a", accounts: () => accounts, policy: () => policy,
    now: () => now, forkParentAsync: (id: string) => readCodexForkParent(root, id) };
  let pool = new AccountPool(options);
  const headers = (thread = child, ancestor = parent) => new Headers({
    authorization: "Bearer a-token", "chatgpt-account-id": "a-remote",
    "thread-id": thread, "session-id": parent,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, forked_from_thread_id: ancestor, turn_id: randomUUID() }),
  });
  await pool.selectAsync({ threadId: parent, requestId: randomUUID(), model,
    body: { model, input: [{ role: "user", content: "synthetic" }] },
    headers: new Headers({ authorization: "Bearer a-token", "chatgpt-account-id": "a-remote" }) });
  const db = new Database(path);
  return { root, parent, child, accounts, policy, state, db, persist, headers,
    get pool() { return pool; },
    select: (h = headers(), threadId = child) => pool.selectAsync({ threadId, requestId: randomUUID(), model, body: history, headers: h }),
    restart: () => { pool.close(); pool = new AccountPool(options); },
    childBinding: () => db.query("SELECT account FROM bindings WHERE thread=?").get(child),
    close: () => { pool.close(); state.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("real ephemeral fork metadata preserves opaque history on the corroborated source across restart", async () => {
  const f = await fixture();
  try {
    expect(await readCodexForkParent(f.root, f.child)).toEqual({ status: "missing" });
    const first = (await f.select())!;
    expect(first.route).toMatchObject({ account: "a", reason: "pinned" });
    expect(first.body).toEqual(history);
    expect(first.headers.get("authorization")).toBe("Bearer a-token");
    f.restart();
    expect((await f.select())?.body).toEqual(history);
    expect(f.childBinding()).toEqual({ account: "a" });
  } finally { f.close(); }
});

test("persisted forks still inherit their actual parent's binding and reject conflicting claims", async () => {
  const f = await fixture();
  try {
    f.persist(f.child, f.parent);
    await expect(f.select(f.headers(f.child, randomUUID()))).rejects.toThrow("pool_lineage_conflict");
    expect(f.childBinding()).toBeNull();
    expect((await f.select())?.route.account).toBe("a");
  } finally { f.close(); }
});

test("a parent claim needs both local parent metadata and a durable binding", async () => {
  const f = await fixture();
  try {
    await expect(f.select(f.headers(f.child, randomUUID()))).rejects.toThrow("pool_lineage_parent_unavailable");
    f.state.query("DELETE FROM threads WHERE id=?").run(f.parent);
    await expect(f.select()).rejects.toThrow("pool_lineage_parent_unavailable"); // a binding alone is insufficient
    f.persist(f.parent);
    f.db.query("DELETE FROM bindings WHERE thread=?").run(f.parent);
    await expect(f.select()).rejects.toThrow("pool_lineage_binding_unavailable");
    expect(f.childBinding()).toBeNull();
  } finally { f.close(); }
});

test("unreadable child metadata cannot be overridden by request claims", async () => {
  const f = await fixture();
  try {
    f.state.query("INSERT INTO threads VALUES (?,?)").run(f.child, join(f.root, "unwritten.jsonl"));
    await expect(f.select()).rejects.toThrow("pool_lineage_unavailable");
    expect(f.childBinding()).toBeNull();
  } finally { f.close(); }
});

test("ephemeral claims cannot choose foreign, changed, or differently scoped account bindings", async () => {
  const f = await fixture();
  try {
    f.db.query("UPDATE bindings SET account='b',identity='b-identity' WHERE thread=?").run(f.parent);
    await expect(f.select()).rejects.toThrow("pool_lineage_account_mismatch");
    f.db.query("UPDATE bindings SET account='a',identity='a-identity',source_identity='old-login' WHERE thread=?").run(f.parent);
    await expect(f.select()).rejects.toThrow("pool_lineage_account_mismatch");
    f.db.query("UPDATE bindings SET source='b' WHERE thread=?").run(f.parent);
    await expect(f.select()).rejects.toThrow("pool_lineage_binding_unavailable");
    expect(f.childBinding()).toBeNull();
  } finally { f.close(); }
});

test("corroborated ephemeral forks still enforce credentials, quota, reserves and cooldowns", async () => {
  const f = await fixture();
  try {
    for (const [name, value] of [["authorization", "Bearer wrong"], ["chatgpt-account-id", "b-remote"]]) {
      const h = f.headers(); h.set(name!, value!);
      await expect(f.select(h)).rejects.toThrow("pool_source_identity_mismatch");
    }
    f.accounts[0]!.remaining = 0; f.accounts[0]!.observedAtMs!++;
    await expect(f.select()).rejects.toThrow("pool_recovery_requires_full_history");
    f.policy.accounts = ["a"];
    await expect(f.select()).rejects.toThrow("pool_source_quota_exhausted");
    f.accounts[0]!.remaining = 20; f.accounts[0]!.observedAtMs!++;
    f.policy.reservePercent.a = 30;
    await expect(f.select()).rejects.toThrow("pool_reserve_reached");
    f.policy.reservePercent.a = 0;
    f.db.query("INSERT INTO cooldowns VALUES (?,?)").run("a-identity", Date.now() + 60_000);
    await expect(f.select()).rejects.toThrow("pool_account_cooldown");
    expect(f.childBinding()).toBeNull();
  } finally { f.close(); }
});

test("disabled new assignment still accepts verified same-account ephemeral continuations", async () => {
  const f = await fixture();
  try {
    f.policy.enabled = false;
    expect((await f.select())?.route).toMatchObject({ account: "a", reason: "pinned" });
  } finally { f.close(); }
});

test("absent, malformed, oversized, self-referential and conflicting request evidence fails closed", async () => {
  const f = await fixture();
  try {
    const absent = f.headers(); absent.delete("x-codex-turn-metadata");
    await expect(f.select(absent)).rejects.toThrow("pool_lineage_unavailable");
    for (const metadata of ["{", "[]", "x".repeat(4097),
      JSON.stringify({ thread_id: f.child, forked_from_thread_id: f.child }),
      JSON.stringify({ thread_id: randomUUID(), forked_from_thread_id: f.parent }),
      JSON.stringify({ thread_id: f.child, forked_from_thread_id: "invalid" }),
    ]) {
      const h = f.headers(); h.set("x-codex-turn-metadata", metadata);
      await expect(f.select(h)).rejects.toThrow("pool_lineage_invalid");
    }
    expect(f.childBinding()).toBeNull();
  } finally { f.close(); }
});

test("thread identity takes precedence over a fork's shared session identity", async () => {
  const f = await fixture();
  try {
    const h = f.headers(); h.set("session_id", f.parent);
    expect(codexRequestIdentity(h).threadId).toBe(f.child);
    h.delete("thread-id");
    expect(codexRequestIdentity(h).threadId).toBe(f.child);
    h.delete("x-codex-turn-metadata");
    expect(codexRequestIdentity(h).threadId).toBe(f.parent);
  } finally { f.close(); }
});

test("HTTP relay forwards compressed ephemeral history intact and rejects unproven parents before dispatch", async () => {
  const f = await fixture();
  let calls = 0;
  const events: unknown[] = [];
  const proxy = startCompactionProxy({ accountPool: f.pool, onRequest: e => events.push(e), fetchUpstream: async (_, init) => {
    calls++;
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer a-token");
    const bytes = init.body as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(bytes)))).toEqual(history);
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const headers = f.headers(); headers.set("content-encoding", "zstd");
    const body = new Uint8Array(Bun.zstdCompressSync(JSON.stringify(history)));
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers, body });
    expect(response.status).toBe(200); await response.text();
    const unknown = f.headers(randomUUID(), randomUUID()); unknown.set("content-encoding", "zstd");
    const rejected = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: unknown, body });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.code).toBe("pool_lineage_parent_unavailable");
    expect(calls).toBe(1);
    expect(JSON.stringify(events)).not.toContain("synthetic-account-bound-history");
  } finally { proxy.stop(); await Bun.sleep(10); f.close(); }
});
