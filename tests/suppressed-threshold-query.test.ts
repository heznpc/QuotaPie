import { describe, expect, spyOn, test } from "bun:test";
import { AlertStore } from "../src/storage/alert-store";
import { QuotaStorage } from "../src/storage/database";
import { migrate } from "../src/storage/migrations";

function fixture() {
  const storage = new QuotaStorage(":memory:");
  const insert = storage.db.prepare(`INSERT INTO app_notification_outbox(
    id,delivery_key,alert_key,title,message,severity,created_at_ms,expires_at_ms,completed_at_ms,disposition)
    VALUES (?, ?, ?, 'Title', 'Message', 'warning', ?, 999999999, ?, ?)`);
  let row = 0;
  const add = (key: string, disposition: string | null, prefix = "threshold:", atMs = 1_000) => {
    row++;
    insert.run(`id-${row}`, `${prefix}${key}:${row}`, key, atMs,
      disposition == null ? null : atMs + 1, disposition);
  };
  storage.transaction(() => {
    // Many old suppressions for one key used to scan the completed-time index
    // repeatedly because the insertion rowid was not a seekable range.
    for (let i = 0; i < 8_000; i++) add("long-history", "suppressed", "threshold:", 8_000 - i);
    add("long-history", "scheduled");
    add("suppressed", "suppressed");
    add("cancelled", "cancelled");
    add("expired", "expired");
    add("scheduled", "scheduled");
    add("pending", null);
    add("later-pending", "suppressed"); add("later-pending", null, "threshold:", 1);
    add("later-nonthreshold", "suppressed"); add("later-nonthreshold", "cancelled", "event:");
    add("later-expired", "suppressed"); add("later-expired", "expired");
    add("nonthreshold", "suppressed", "event:");
    add("case-insensitive-prefix", "suppressed", "THRESHOLD:");
    add("suppressed-after-cancelled", "cancelled"); add("suppressed-after-cancelled", "suppressed");
  });
  return storage;
}

describe("suppressed threshold indexed lookup", () => {
  test("latest insertion wins across dispositions, delivery types and out-of-order timestamps", () => {
    const storage = fixture(), alerts = new AlertStore(storage);
    try {
      expect(alerts.suppressedThresholdKeys().sort()).toEqual([
        "case-insensitive-prefix", "suppressed", "suppressed-after-cancelled",
      ]);
      expect(alerts.suppressedThresholdKeys(true).sort()).toEqual([
        "cancelled", "case-insensitive-prefix", "suppressed", "suppressed-after-cancelled",
      ]);
      const rowsBefore = storage.db.query("SELECT COUNT(*) AS n FROM app_notification_outbox").get();
      migrate(storage.db); // Reopening/upgrading retains the outbox and is idempotent.
      expect(storage.db.query("SELECT COUNT(*) AS n FROM app_notification_outbox").get()).toEqual(rowsBefore);
      expect(alerts.suppressedThresholdKeys(true).sort()).toEqual([
        "cancelled", "case-insensitive-prefix", "suppressed", "suppressed-after-cancelled",
      ]);
    } finally { storage.close(); }
  });

  test("both query variants use covering candidate lookup and a key/rowid range seek", () => {
    const storage = fixture(), alerts = new AlertStore(storage);
    const original = storage.db.query.bind(storage.db);
    const queries: string[] = [];
    const spy = spyOn(storage.db, "query").mockImplementation(((sql: string, ...args: unknown[]) => {
      if (sql.includes("SELECT n.alert_key")) queries.push(sql);
      return (original as any)(sql, ...args);
    }) as any);
    try {
      alerts.suppressedThresholdKeys(); alerts.suppressedThresholdKeys(true);
      expect(queries).toHaveLength(2);
      for (const sql of queries) {
        const plan = original<{ detail: string }, []>("EXPLAIN QUERY PLAN " + sql).all().map(row => row.detail);
        expect(plan.some(detail => detail.includes("COVERING INDEX app_notification_threshold_candidates (disposition=?"))).toBeTrue();
        expect(plan.some(detail => detail.includes("COVERING INDEX app_notification_latest (alert_key=? AND rowid>?"))).toBeTrue();
        expect(plan.some(detail => /SCAN (?:TABLE )?(?:n|newer)\b/.test(detail))).toBeFalse();
      }
    } finally { spy.mockRestore(); storage.close(); }
  });
});
