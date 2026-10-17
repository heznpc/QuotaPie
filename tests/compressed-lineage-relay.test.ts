// Offline synthetic fixture. Never reads real credentials, threads, or configuration.
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

import { test } from "bun:test";
import { readCodexForkParent } from "../src/account-pool-lineage";
import { AccountPool } from "../src/account-pool";
import { createCompactionHandler } from "../src/codex-compaction";

test("subscription relay reads compressed ancestors and still rejects corrupt or foreign ancestry before dispatch", async () => {
const root = mkdtempSync(join(tmpdir(), "quotapie-compressed-lineage-qa-"));
const child = randomUUID(), parent = randomUUID(), grandparent = randomUUID();
const parentPath = join(root, "parent.jsonl"), childPath = join(root, "child.jsonl");
const parentMetadata = JSON.stringify({ type: "session_meta", payload: { id: parent, model_provider: "openai", forked_from_id: grandparent } }) + "\n";
const db = new Database(join(root, "state_5.sqlite"));
db.run("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
db.query("INSERT INTO threads VALUES (?,?)").run(parent, parentPath);
db.query("INSERT INTO threads VALUES (?,?)").run(child, childPath);
const grandparentPath = join(root, "grandparent.jsonl");
db.query("INSERT INTO threads VALUES (?,?)").run(grandparent, grandparentPath);
writeFileSync(grandparentPath + ".zst", Bun.zstdCompressSync(JSON.stringify({
  type: "session_meta", payload: { id: grandparent } }) + "\n"));
writeFileSync(parentPath, parentMetadata);
writeFileSync(childPath, JSON.stringify({ type: "session_meta", payload: { id: child, forked_from_id: parent } }) + "\n");
const now = Date.now();
const account = { id: "fixture", label: "fixture", identity: "fixture-identity", accessToken: "synthetic-token",
  upstreamAccount: "synthetic-workspace", tokenExpiresAt: now + 3600000, models: ["gpt-6-astra"], remaining: 80, validUntil: now + 60000 };
const pool = new AccountPool({ path: join(root, "pool.sqlite3"), sourceAccount: account.id,
  accounts: () => [account], policy: () => ({ enabled: false, accounts: [] }), now: () => now,
  forkParentAsync: (id: string) => readCodexForkParent(root, id) });
let upstreamCalls = 0;
const ready = { version: 1 as const, ready: true, reason: "ready", checkedAtMs: now, account: "fixture", profileKey: "fixture", windows: [] };
const relay = createCompactionHandler({ accountPool: pool,
  subscriptionGuard: { intervalMs: 500, check: () => ready, checkIdentity: () => ready },
  fetchUpstream: async () => { upstreamCalls++; return Response.json({ id: "synthetic-response", object: "response", status: "completed", model: "gpt-6-astra", output: [] }); } });
async function request(): Promise<{ status: number; body: any }> {
  const response = await relay.fetch(new Request(`http://localhost${relay.prefix}/responses`, { method: "POST",
    headers: { authorization: "Bearer synthetic-token", "chatgpt-account-id": "synthetic-workspace", "thread-id": child, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", input: [{ role: "user", content: "synthetic fixture" }] }) }));
  return { status: response.status, body: await response.json() };
}
try {
  const plain = await request();
  assert.equal(plain.status, 200); assert.equal(upstreamCalls, 1);
  writeFileSync(parentPath + ".zst", Bun.zstdCompressSync(Buffer.from(parentMetadata)));
  unlinkSync(parentPath);
  const compressedRead = await readCodexForkParent(root, parent);
  assert.deepEqual(compressedRead, { status: "known", parentId: grandparent });
  const compressed = await request();
  assert.equal(compressed.status, 200); assert.equal(upstreamCalls, 2);
  // A later request must not reuse positive ancestry after its file changes.
  writeFileSync(parentPath + ".zst", "corrupt");
  const corrupt = await request();
  assert.equal(corrupt.status, 400);
  assert.equal(corrupt.body.error.code, "subscription_pool_lineage_unavailable");
  assert.match(corrupt.body.error.message, /parent conversation metadata could not be read/);
  assert.doesNotMatch(corrupt.body.error.message, /Subscription protection could not be verified/);
  assert.equal(upstreamCalls, 2);
  writeFileSync(parentPath, parentMetadata);
  const restored = await request();
  assert.equal(restored.status, 200); assert.equal(upstreamCalls, 3);
  // Persisted foreign ownership must still veto a fully readable compressed parent.
  writeFileSync(parentPath + ".zst", Bun.zstdCompressSync(Buffer.from(parentMetadata)));
  unlinkSync(parentPath);
  const bindings = new Database(join(root, "pool.sqlite3"));
  try {
    bindings.query("INSERT INTO bindings VALUES (?,?,?,?,?,?,?)")
      .run("fixture", parent, "other", "fixture-identity", "other-identity", "other", now);
    const foreign = await request();
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error.code, "subscription_pool_source_continuation_mismatch");
    assert.equal(upstreamCalls, 3);
    assert.equal(bindings.query<{ account: string }, [string]>("SELECT account FROM bindings WHERE thread=?").get(parent)?.account, "other");
  } finally { bindings.close(); }

} finally { pool.close(); db.close(); rmSync(root, { recursive: true, force: true }); }

});
