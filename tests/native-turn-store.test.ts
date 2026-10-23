import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTurnStore } from "../src/native-turn-store";

function fixture(run: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "qp-native-turn-"));
  try { run(join(root, "manual.sqlite3")); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const record = { choice: '{"account":"b"}', requestId: "request-1", sourceContinuation: false, inheritedFromThreadId: null };

test("legacy manual preferences survive the additive turn-store migration", () => fixture(path => {
  const db = new Database(path);
  db.run("CREATE TABLE manual_targets (source TEXT NOT NULL,thread TEXT NOT NULL,payload TEXT NOT NULL,selected_ms INTEGER NOT NULL,PRIMARY KEY(source,thread))");
  db.run("INSERT INTO manual_targets VALUES('a','thread','legacy-choice',123)");
  const store = new NativeTurnStore(path, "a");
  expect(store.read("thread", "turn")).toBeNull();
  store.begin("thread", "turn", record);
  expect(db.query("SELECT payload,selected_ms FROM manual_targets").get()).toEqual({ payload: "legacy-choice", selected_ms: 123 });
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  db.close();
}));

test("late completions cannot authorize a different request on the same turn", () => fixture(path => {
  const first = new NativeTurnStore(path, "a"), second = new NativeTurnStore(path, "a");
  first.begin("thread", "turn", record);
  second.begin("thread", "turn", { ...record, requestId: "request-2" });
  first.finish("thread", "turn", "request-1", true);
  expect(second.read("thread", "turn")).toMatchObject({ requestId: "request-2", completed: false });
  second.finish("thread", "turn", "request-2", true);
  expect(new NativeTurnStore(path, "a").read("thread", "turn")?.completed).toBe(true);
  expect(new NativeTurnStore(path, "other-source").read("thread", "turn")).toBeNull();
  expect(first.read("thread", "other-turn")).toBeNull();
}));

test("a newer unsupported registry is never silently overwritten", () => fixture(path => {
  const db = new Database(path); db.run("PRAGMA user_version=2");
  const store = new NativeTurnStore(path, "a");
  expect(() => store.begin("thread", "turn", record)).toThrow("unsupported_native_turn_schema");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 }); db.close();
}));
