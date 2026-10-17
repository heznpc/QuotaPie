import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexForkParent } from "../src/account-pool-lineage";

async function fixture(work: (f: { root: string; outside: string; id: string; parent: string; path: string; db: Database;
  write: (payload: Record<string, unknown>, suffix?: string) => void }) => Promise<void>) {
  const temp = mkdtempSync(join(tmpdir(), "qp-lineage-"));
  const root = join(temp, "profile"), outside = join(temp, "outside.jsonl");
  mkdirSync(root);
  const id = randomUUID(), parent = randomUUID(), path = join(root, "rollout.jsonl");
  const db = new Database(join(root, "state_5.sqlite"));
  db.run("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
  db.query("INSERT INTO threads VALUES (?,?)").run(id, path);
  const write = (payload: Record<string, unknown>, suffix = "\n") =>
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, ...payload } }) + suffix);
  try { await work({ root, outside, id, parent, path, db, write }); }
  finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
}

test("reads a fork parent from the source profile's first metadata record", () => fixture(async ({ root, id, parent, write }) => {
  write({ forked_from_id: parent, history_base: { thread_id: parent }, session_id: randomUUID() },
    '\n{"type":"response_item","payload":"not metadata"}\n');
  expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

test("distinguishes a context-free agent's parent relation from inherited history", () => fixture(async ({ root, id, parent, write }) => {
  write({ parent_thread_id: parent });
  expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: null });
  write({ history_base: { thread_id: parent } });
  expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: null });
  write({ forked_from_id: parent, parent_thread_id: parent });
  expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

test("rejects conflicting, self-referential, and malformed lineage", () => fixture(async ({ root, id, parent, write }) => {
  for (const payload of [
    { id: randomUUID(), forked_from_id: parent }, { forked_from_id: id },
    { forked_from_id: "invalid" },
  ]) {
    write(payload);
    expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  }
}));

test("does not cache a missing or incompletely flushed rollout", () => fixture(async ({ root, id, parent, path, write }) => {
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  write({ forked_from_id: parent }, "");
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  writeFileSync(path, '{"type":"session_meta","payload":');
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  write({ forked_from_id: parent });
  expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

test("rejects rollout paths or symlinks outside the source profile", () => fixture(async ({ root, id, parent, outside, path, db }) => {
  writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id, forked_from_id: parent } }) + "\n");
  db.query("UPDATE threads SET rollout_path=? WHERE id=?").run(outside, id);
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  symlinkSync(outside, path);
  db.query("UPDATE threads SET rollout_path=? WHERE id=?").run(path, id);
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
}));

test("reads the latest database version without falling back to stale rows", () => fixture(async ({ root, id, parent, write }) => {
  write({ forked_from_id: parent });
  const latest = new Database(join(root, "state_10.sqlite"));
  latest.run("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
  latest.close();
  expect(await readCodexForkParent(root, id)).toEqual({ status: "missing" });
}));

test("distinguishes absent in-memory threads from unreadable persisted metadata", () => fixture(async ({ root, id, db }) => {
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  db.query("DELETE FROM threads WHERE id=?").run(id);
  expect(await readCodexForkParent(root, id)).toEqual({ status: "missing" });
}));

test("bounds metadata reads and ignores later metadata-looking conversation content", () => fixture(async ({ root, id, parent, path, write }) => {
  write({ forked_from_id: parent, base_instructions: "x".repeat(1024 * 1024) });
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  writeFileSync(path, JSON.stringify({ type: "response_item", payload: {} }) + "\n" +
    JSON.stringify({ type: "session_meta", payload: { id, forked_from_id: parent } }) + "\n");
  expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
}));

test("missing DB and malformed thread IDs remain unknown without creating files", () => fixture(async ({ root, id }) => {
  expect(await readCodexForkParent(root, "../outside")).toEqual({ status: "unknown" });
  const empty = join(root, "empty"); mkdirSync(empty);
  expect(await readCodexForkParent(empty, id)).toEqual({ status: "unknown" });
}));

test("forks from paginated history follow the logical parent, not the storage shard", () => fixture(async ({ root, id, parent, write }) => {
  const shard = randomUUID();
  write({ forked_from_id: parent, history_base: { thread_id: shard, end_ordinal_exclusive: 1493, end_byte_offset: 6716003 } });
  expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

for (const direct of [false, true]) test(`reads bounded zstd metadata (${direct ? "stored compressed path" : "compressed sibling"})`, () =>
  fixture(async ({ root, id, parent, path, db }) => {
    const header = JSON.stringify({ type: "session_meta", payload: { id, forked_from_id: parent } }) + "\n";
    // Large later history must not require whole-file decompression or parsing.
    writeFileSync(path + ".zst", Bun.zstdCompressSync(header + "x".repeat(4 * 1024 * 1024)));
    if (direct) db.query("UPDATE threads SET rollout_path=? WHERE id=?").run(path + ".zst", id);
    expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
  }));

test("compressed metadata fails closed for corrupt, partial, oversized, or mismatched first records", () =>
  fixture(async ({ root, id, parent, path }) => {
    const meta = (payload: object) => JSON.stringify({ type: "session_meta", payload });
    for (const content of [
      meta({ id, forked_from_id: parent }),
      meta({ id, forked_from_id: parent, text: "x".repeat(1024 * 1024) }) + "\n",
      meta({ id: randomUUID(), forked_from_id: parent }) + "\n",
      '{"type":"response_item"}\n' + meta({ id, forked_from_id: parent }) + "\n",
    ]) {
      writeFileSync(path + ".zst", Bun.zstdCompressSync(content));
      expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
    }
    writeFileSync(path + ".zst", "not zstd");
    expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
    writeFileSync(path + ".zst", Bun.zstdCompressSync(meta({ id }) + "\n").subarray(0, 8));
    expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  }));

test("compressed fallback cannot escape the profile or override a present incomplete plain rollout", () =>
  fixture(async ({ root, id, outside, path, write }) => {
    const bytes = Bun.zstdCompressSync(JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
    writeFileSync(outside, bytes);
    symlinkSync(outside, path + ".zst");
    expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
    unlinkSync(path + ".zst"); writeFileSync(path + ".zst", bytes);
    write({}, "");
    expect(await readCodexForkParent(root, id)).toEqual({ status: "unknown" });
    unlinkSync(path);
    expect(await readCodexForkParent(root, id)).toEqual({ status: "known", parentId: null });
  }));
