import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexForkParent } from "../src/account-pool-lineage";

function fixture(work: (f: { root: string; outside: string; id: string; parent: string; path: string; db: Database;
  write: (payload: Record<string, unknown>, suffix?: string) => void }) => void) {
  const temp = mkdtempSync(join(tmpdir(), "qp-lineage-"));
  const root = join(temp, "profile"), outside = join(temp, "outside.jsonl");
  mkdirSync(root);
  const id = randomUUID(), parent = randomUUID(), path = join(root, "rollout.jsonl");
  const db = new Database(join(root, "state_5.sqlite"));
  db.run("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
  db.query("INSERT INTO threads VALUES (?,?)").run(id, path);
  const write = (payload: Record<string, unknown>, suffix = "\n") =>
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, ...payload } }) + suffix);
  try { work({ root, outside, id, parent, path, db, write }); }
  finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
}

test("reads a fork parent from the source profile's first metadata record", () => fixture(({ root, id, parent, write }) => {
  write({ forked_from_id: parent, history_base: { thread_id: parent }, session_id: randomUUID() },
    '\n{"type":"response_item","payload":"not metadata"}\n');
  expect(readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

test("distinguishes a context-free agent's parent relation from inherited history", () => fixture(({ root, id, parent, write }) => {
  write({ parent_thread_id: parent });
  expect(readCodexForkParent(root, id)).toEqual({ status: "known", parentId: null });
  write({ history_base: { thread_id: parent } });
  expect(readCodexForkParent(root, id)).toEqual({ status: "known", parentId: null });
  write({ forked_from_id: parent, parent_thread_id: parent });
  expect(readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

test("rejects conflicting, self-referential, and malformed lineage", () => fixture(({ root, id, parent, write }) => {
  for (const payload of [
    { id: randomUUID(), forked_from_id: parent }, { forked_from_id: id },
    { forked_from_id: "invalid" }, { forked_from_id: parent, history_base: { thread_id: randomUUID() } },
  ]) {
    write(payload);
    expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  }
}));

test("does not cache a missing or incompletely flushed rollout", () => fixture(({ root, id, parent, path, write }) => {
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  write({ forked_from_id: parent }, "");
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  writeFileSync(path, '{"type":"session_meta","payload":');
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  write({ forked_from_id: parent });
  expect(readCodexForkParent(root, id)).toEqual({ status: "known", parentId: parent });
}));

test("rejects rollout paths or symlinks outside the source profile", () => fixture(({ root, id, parent, outside, path, db }) => {
  writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id, forked_from_id: parent } }) + "\n");
  db.query("UPDATE threads SET rollout_path=? WHERE id=?").run(outside, id);
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  symlinkSync(outside, path);
  db.query("UPDATE threads SET rollout_path=? WHERE id=?").run(path, id);
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
}));

test("reads the latest database version without falling back to stale rows", () => fixture(({ root, id, parent, write }) => {
  write({ forked_from_id: parent });
  const latest = new Database(join(root, "state_10.sqlite"));
  latest.run("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT)");
  latest.close();
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
}));

test("bounds metadata reads and ignores later metadata-looking conversation content", () => fixture(({ root, id, parent, path, write }) => {
  write({ forked_from_id: parent, base_instructions: "x".repeat(1024 * 1024) });
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
  writeFileSync(path, JSON.stringify({ type: "response_item", payload: {} }) + "\n" +
    JSON.stringify({ type: "session_meta", payload: { id, forked_from_id: parent } }) + "\n");
  expect(readCodexForkParent(root, id)).toEqual({ status: "unknown" });
}));

test("missing DB and malformed thread IDs remain unknown without creating files", () => fixture(({ root, id }) => {
  expect(readCodexForkParent(root, "../outside")).toEqual({ status: "unknown" });
  const empty = join(root, "empty"); mkdirSync(empty);
  expect(readCodexForkParent(empty, id)).toEqual({ status: "unknown" });
}));
