import { expect, spyOn, test } from "bun:test";
import { QuotaDatabase } from "../src/db";
import type { QuotaObservation } from "../src/types";

const window: QuotaObservation = { provider: "codex", account: "default", bucket: "codex:primary:300",
  label: "5h", windowSeconds: 18000, usedPercent: 10, resetsAtMs: 2_000_000,
  observedAtMs: 1000, source: "test", quality: "authoritative" };

test("latest quota selects each active bucket by observation time and then insertion id", () => {
  const db = new QuotaDatabase(":memory:");
  try {
    db.insertSnapshot(window);
    db.insertSnapshot({ ...window, observedAtMs: 3000, usedPercent: 30 });
    db.insertSnapshot({ ...window, observedAtMs: 3000, usedPercent: 40, source: "push" });
    db.insertSnapshot({ ...window, observedAtMs: 2000, usedPercent: 20 });
    db.insertSnapshot({ ...window, account: "second", usedPercent: 50 });
    db.insertSnapshot({ ...window, bucket: "retired" });
    db.db.run("UPDATE bucket_state SET active=0 WHERE bucket='retired'");
    expect(db.latestAll().map(item => [item.account, item.observedAtMs, item.usedPercent])).toEqual([
      ["default", 3000, 40], ["second", 1000, 50],
    ]);
  } finally { db.close(); }
});

test("latest quota uses indexed lookups per bucket instead of scanning the snapshot archive", () => {
  const db = new QuotaDatabase(":memory:");
  try {
    db.insertSnapshot(window);
    const query = spyOn(db.db, "query");
    db.latestAll();
    const sql = query.mock.calls[0]![0];
    query.mockRestore();
    const plan = db.db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN " + sql).all().map(row => row.detail);
    expect(plan.some(line => /SEARCH s USING INTEGER PRIMARY KEY/.test(line))).toBe(true);
    expect(plan.some(line => /^SCAN (s|snapshots)(?:\s|$)/.test(line))).toBe(false);
  } finally { db.close(); }
});
