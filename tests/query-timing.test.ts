import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { instrumentQueryTiming, type SlowQueryTiming } from "../src/storage/query-timing";

describe("SQLite slow query diagnostics", () => {
  test("preserves native query caching, row results, bindings and transactions", () => {
    const db = new Database(":memory:", { strict: true });
    const reports: SlowQueryTiming[] = [];
    let clock = 0;
    instrumentQueryTiming(db, { now: () => clock += 300, report: row => reports.push(row) });
    try {
      db.run("CREATE TABLE records (id INTEGER PRIMARY KEY, secret TEXT)");
      const insert = db.query("INSERT INTO records(secret) VALUES (?)");
      expect(db.query("INSERT INTO records(secret) VALUES (?)")).toBe(insert);
      expect(insert.run("private-binding").changes).toBe(1);
      expect(db.prepare("SELECT secret FROM records WHERE id=?").get(1)).toEqual({ secret: "private-binding" });
      expect(db.query("SELECT secret FROM records").values()).toEqual([["private-binding"]]);
      expect(db.query("SELECT secret FROM records").all()).toEqual([{ secret: "private-binding" }]);
      expect(() => db.transaction(() => { insert.run("rolled-back"); throw new Error("rollback"); })()).toThrow("rollback");
      expect(db.query("SELECT COUNT(*) AS n FROM records").get()).toEqual({ n: 1 });
      expect(reports.length).toBeGreaterThan(4);
      for (const row of reports) {
        expect(row.queryId).toMatch(/^[a-f0-9]{16}$/);
        expect(row.durationMs).toBe(300);
        expect(Number.isFinite(Date.parse(row.at))).toBeTrue();
        expect(Object.keys(row).sort()).toEqual(["at", "durationMs", "method", "queryId"]);
      }
      expect(JSON.stringify(reports)).not.toContain("private-binding");
      expect(JSON.stringify(reports)).not.toContain("SELECT");
      const insertId = createHash("sha256").update("INSERT INTO records(secret) VALUES (?)").digest("hex").slice(0, 16);
      expect(reports.filter(row => row.method === "run" && row.queryId === insertId)).toHaveLength(2);
    } finally { db.close(); }
  });

  test("preserves native iterator early return and excludes consumer idle time", () => {
    const db = new Database(":memory:");
    const reports: SlowQueryTiming[] = [];
    let clock = 0;
    instrumentQueryTiming(db, { now: () => clock, report: row => reports.push(row) });
    try {
      const statement = db.query("SELECT 1 AS n UNION ALL SELECT 2 AS n");
      const iterator = statement.iterate();
      expect(iterator[Symbol.iterator]()).toBe(iterator);
      expect(iterator.next().value).toEqual({ n: 1 });
      clock += 60_000;
      expect(iterator.next().value).toEqual({ n: 2 });
      expect(iterator.next().done).toBeTrue();
      expect(reports).toHaveLength(0);
      for (const row of statement.iterate()) { expect(row).toEqual({ n: 1 }); break; }
      expect(statement.all()).toEqual([{ n: 1 }, { n: 2 }]);
      expect(statement.columnNames).toEqual(["n"]);
    } finally { db.close(); }
  });

  test("does not replace database errors when reporting fails", () => {
    const db = new Database(":memory:");
    let clock = 0;
    instrumentQueryTiming(db, { now: () => clock += 300, report: () => { throw new Error("logging failed"); } });
    try {
      db.run("CREATE TABLE unique_values (value TEXT UNIQUE)");
      const insert = db.prepare("INSERT INTO unique_values(value) VALUES (?)");
      expect(insert.run("private").changes).toBe(1);
      expect(() => insert.run("private")).toThrow("UNIQUE constraint failed");
      expect(db.query("SELECT COUNT(*) AS n FROM unique_values").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
