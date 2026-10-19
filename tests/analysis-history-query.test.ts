import { describe, expect, spyOn, test } from "bun:test";
import { QuotaDatabase } from "../src/db";

// Preserve the old query's sampling contract: the greatest insertion ID in
// each older time bucket, including late/out-of-order arrivals, plus every
// recent record. Equal observation times retain insertion order.
const referenceSQL = `SELECT source FROM snapshots current
  WHERE provider = ? AND account = ? AND bucket = ? AND observed_at_ms >= ?
    AND (observed_at_ms >= ? OR id IN (
      SELECT MAX(id) FROM snapshots
      WHERE provider = ? AND account = ? AND bucket = ?
        AND observed_at_ms >= ? AND observed_at_ms < ?
      GROUP BY CAST(observed_at_ms / ? AS INTEGER)))
  ORDER BY observed_at_ms ASC, id ASC`;

function fixture() {
  const database = new QuotaDatabase(":memory:");
  const insert = database.db.prepare(`INSERT INTO snapshots(
    provider,account,bucket,label,window_seconds,used_percent,resets_at_ms,
    observed_at_ms,source,quality,metadata_json) VALUES (?,?,?,'Window',18000,25,2000000,? ,?,'authoritative','{}')`);
  database.db.transaction(() => {
    for (let index = 0; index < 8_000; index++) {
      // Each timestamp appears eight times, with four interleaved accounts
      // and buckets. Inserts become older again after every 1,000 rows.
      insert.run("codex", "account-a", "window-a", index % 1_000 * 1_000, `row-${index}`);
      if (index % 100 === 0) {
        insert.run("codex", "account-b", "window-a", index % 1_000 * 1_000, `other-account-${index}`);
        insert.run("codex", "account-a", "window-b", index % 1_000 * 1_000, `other-window-${index}`);
        insert.run("claude", "account-a", "window-a", index % 1_000 * 1_000, `other-provider-${index}`);
      }
    }
    insert.run("codex", "account-a", "window-a", 7_777, "late-old-record");
    insert.run("codex", "account-a", "window-a", 500_000, "recent-boundary-record");
  })();
  return database;
}

describe("analysis history indexed selection", () => {
  test("matches the prior sampling and ordering for duplicate times, late arrivals and range boundaries", () => {
    const database = fixture();
    try {
      for (const [since, recent, bucket] of [
        [0, 500_000, 15_000], [7_777, 500_000, 15_000],
        [500_000, 500_000, 15_000], [500_000, 400_000, 15_000],
        [0, 2_000_000, 15_000], [2_000_000, 3_000_000, 15_000],
        [0, 500_000, 1_000],
      ] as const) {
        const expected = database.db.query<{ source: string }, any[]>(referenceSQL)
          .all("codex", "account-a", "window-a", since, recent,
            "codex", "account-a", "window-a", since, recent, bucket).map(row => row.source);
        const actual = database.analysisHistory("codex", "account-a", "window-a", since, recent, bucket);
        expect(actual.map(row => row.source)).toEqual(expected);
        expect(actual.every(row => row.provider === "codex" && row.account === "account-a" && row.bucket === "window-a")).toBeTrue();
      }
      expect(database.analysisHistory("codex", "account-a", "window-a", 0, 500_000, 15_000)[0]!.source).toBe("late-old-record");
      expect(database.analysisHistory("codex", "missing", "window-a", 0, 500_000)).toEqual([]);
    } finally { database.close(); }
  });

  test("materializes selected rows by primary key after covering-index selection", () => {
    const database = fixture();
    const original = database.db.query.bind(database.db);
    let historySQL = "";
    const spy = spyOn(database.db, "query").mockImplementation(((sql: string, ...args: unknown[]) => {
      if (sql.includes("UNION ALL")) historySQL = sql;
      return (original as any)(sql, ...args);
    }) as any);
    try {
      database.analysisHistory("codex", "account-a", "window-a", 0, 500_000, 15_000);
      expect(historySQL).not.toBe("");
      const plan = original<{ detail: string }, any[]>("EXPLAIN QUERY PLAN " + historySQL)
        .all("codex", "account-a", "window-a", 500_000, "codex", "account-a", "window-a", 0, 500_000, 15_000);
      expect(plan[0]!.detail).toContain("USING INTEGER PRIMARY KEY");
      expect(plan.filter(row => row.detail.includes("COVERING INDEX snapshots_lookup"))).toHaveLength(2);
      expect(plan.some(row => /SCAN (?:TABLE )?snapshots/.test(row.detail))).toBeFalse();
    } finally { spy.mockRestore(); database.close(); }
  });
});
