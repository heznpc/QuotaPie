import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { classifyPost } from "../src/signals/classify";
import { recoveryEvidence } from "../src/signals/correlation";
import { classifyDelta } from "../src/classify";
import type { QuotaObservation } from "../src/types";

const now = Date.now();
const morning = now - 3 * 3600_000;
const before: QuotaObservation = { provider: "codex", account: "personal", bucket: "weekly", label: "Weekly",
  windowSeconds: 604800, usedPercent: 95, resetsAtMs: morning + 4 * 86400_000,
  observedAtMs: morning - 300_000, source: "codex-app-server", quality: "authoritative" };
const after = { ...before, observedAtMs: morning, usedPercent: 0, resetsAtMs: morning + 7 * 86400_000 };
const report = classifyPost({ id: "12345", author: "thsottiaux", text: "All reset for everyone. Enjoy the week with Astra.",
  createdAtMs: now, conversationId: "12345", references: [] }, new Map())!;
function config() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.dashboard.port = 0; c.collection.codexEnabled = false;
  c.accounts.codex = ["personal", "work", "empty"].map(id => ({ id, label: id, enabled: true, codexHome: `/tmp/quotapie-test-${id}` }));
  c.accounts.claude = [];
  c.resetSignals.enabled = true;
  return c;
}
function seed(s: QuotaPieService) {
  s.ingest([before, after, { ...after, observedAtMs: now - 300000 }, { ...after, observedAtMs: now, usedPercent: 1 }]);
  s.ingest([{ ...before, account: "work", observedAtMs: now - 300000 }, { ...before, account: "work", observedAtMs: now }]);
  for (const account of ["personal", "work"]) s.collection.recordAttempt("codex", account, "codex-appserver", now, null);
}

describe("native recovery contract", () => {
  test("a changed login or plan cannot inherit the previous context's recent recovery", async () => {
    for (const kind of ["account_changed", "plan_changed"] as const) {
      const s = new QuotaPieService(config(), new QuotaDatabase(":memory:"));
      try {
        seed(s);
        expect(s.resetTracking(now).accounts[0]!.windows[0]!.recovery).not.toBeNull();
        s.db.insertEvent({ provider: "codex", account: "personal", bucket: "weekly", kind,
          severity: "info", confidence: "high", occurredAtMs: now, displayText: "context changed", details: {} });
        expect(s.resetTracking(now).accounts[0]!.windows[0]!.recovery).toBeNull();
        expect(s.recentEvents().some(event => event.kind === "external_relief")).toBe(true);
        // A subsequent real recovery belongs to the current context and remains visible.
        s.ingest([{ ...after, observedAtMs: now + 1000, usedPercent: 80 },
          { ...after, observedAtMs: now + 2000, usedPercent: 0, resetsAtMs: now + 7 * 86400000 }]);
        expect(s.resetTracking(now + 2000).accounts[0]!.windows[0]!.recovery).not.toBeNull();
      } finally { await s.close(); }
    }
  });
  test("all accounts stay visible, late news changes neither recovery nor observation; persistence survives restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-recovery-"));
    const path = join(dir, "test.sqlite3");
    let s = new QuotaPieService(config(), new QuotaDatabase(path));
    try {
      seed(s);
      const original = s.resetTracking(now);
      expect(original.accounts).toHaveLength(3);
      expect(original.accounts[0]!.windows[0]!.state).toBe("recovery-observed");
      expect(original.accounts[1]!.windows[0]!.state).toBe("no-recovery-observed");
      expect(original.accounts[2]!.windows).toEqual([]);
      s.resetSignals.save([report], now);
      const tracked = s.resetTracking(now);
      const recovery = tracked.accounts[0]!.windows[0]!.recovery!;
      expect(recovery.candidates).toHaveLength(1);
      expect(recovery.observedAfterMs).toBe(before.observedAtMs);
      expect(recovery.observedByMs).toBe(morning);
      expect(recovery.nextResetsAtMs).toBe(after.resetsAtMs);
      expect(s.resetTracking(now).accounts[1]!.windows[0]!.recovery).toBeNull();
      await s.close(); s = new QuotaPieService(config(), new QuotaDatabase(path));
      expect(s.resetTracking(now)).toEqual(tracked);
      s.collection.recordAttempt("codex", "personal", "codex-appserver", now + 1, "offline", "network");
      const failed = s.resetTracking(now + 1).accounts[0]!.windows[0]!;
      expect(failed.state).toBe("unavailable");
      s.collection.recordAttempt("codex", "personal", "other-source", now + 1, null);
      expect(s.resetTracking(now + 1).accounts[0]!.windows[0]!.state).toBe("unavailable");
      expect(failed.recovery).toEqual(recovery);
      expect(s.resetTracking(now + 601000).accounts[1]!.windows[0]!.state).toBe("unavailable");
    } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("insufficient, fallback, long-gap, source and window changes cannot claim a verified recovery", async () => {
    for (const change of [
      { source: "fallback" }, { quality: "fallback" as const }, { windowSeconds: 18000 },
      { observedAtMs: morning + 3600000 },
    ]) {
      const s = new QuotaPieService(config(), new QuotaDatabase(":memory:"));
      try {
        const next = { ...after, ...change };
        s.ingest([before, next]);
        s.collection.recordAttempt("codex", "personal", next.source === "codex-app-server" ? "codex-appserver" : next.source, next.observedAtMs, null);
        const row = s.resetTracking(next.observedAtMs).accounts[0]!.windows[0]!;
        expect(row.state).toBe("unavailable"); expect(row.recovery?.candidates).toEqual([]);
      } finally { await s.close(); }
    }
  });

  test("candidates require universal completed direct reset with compatible time and window", () => {
    const event = classifyDelta(before, after, DEFAULT_CONFIG)[0]!;
    expect(recoveryEvidence(event, [report], now).candidates).toHaveLength(1);
    for (const change of [
      { text: "All Pro accounts have now reset" }, { text: "We have reset usage" },
      { text: "All users have reset their five-hour limits" }, { state: "announced" as const },
      { resetKind: "banked" as const }, { resetKind: "unknown" as const },
      { targetAtMs: now + 86400000 }, { publishedAtMs: morning - 7 * 3600000 },
    ]) expect(recoveryEvidence(event, [{ ...report, ...change }], now).candidates).toEqual([]);
    expect(recoveryEvidence({ ...event, provider: "claude" }, [report], now).candidates).toEqual([]);
    for (const details of [{}, { ...event.details, resetCreditDecreased: true }]) {
      expect(recoveryEvidence({ ...event, details }, [report], now).candidates).toEqual([]);
    }
    const correction = { ...report, id: "999", state: "withdrawn" as const, publishedAtMs: now + 1 };
    expect(recoveryEvidence(event, [report, correction], now + 1).candidates).toEqual([]);
  });

  test("real trigger and public-notification paths do not requeue recovery after late news or service restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-notification-"));
    const path = join(dir, "test.sqlite3");
    let s = new QuotaPieService(config(), new QuotaDatabase(path));
    let server = startDashboard(s, s.config);
    let poll = spyOn(s.signalCollector, "poll").mockResolvedValue();
    try {
      s.claimNextAppNotification(); // Native consumer registration; real durable outbox.
      seed(s);
      await s.evaluateTriggers(now);
      const original = s.db.db.query<{ id: string; delivery_key: string }, []>("SELECT id, delivery_key FROM app_notification_outbox ORDER BY id").all();
      expect(original.some(row => row.delivery_key.startsWith("event:"))).toBeTrue();
      s.resetSignals.save([report], now);
      await s.collectResetSignals();
      await s.evaluateTriggers(now);
      const count = s.db.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM app_notification_outbox").get()!.n;
      expect(count).toBe(original.length + 1); // Exactly one public-news notification.
      const payload = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as any;
      expect(payload.resetTracking.accounts[0].windows[0].recovery.candidates).toHaveLength(1);
      poll.mockRestore(); server.stop(true); await s.close();
      s = new QuotaPieService(config(), new QuotaDatabase(path)); server = startDashboard(s, s.config);
      poll = spyOn(s.signalCollector, "poll").mockResolvedValue();
      s.resetSignals.save([report], now);
      await s.collectResetSignals(); await s.evaluateTriggers(now);
      expect(s.db.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM app_notification_outbox").get()!.n).toBe(count);
      expect(s.db.db.query<{ id: string; delivery_key: string }, []>("SELECT id, delivery_key FROM app_notification_outbox WHERE delivery_key LIKE 'event:%' ORDER BY id").all())
        .toEqual(original.filter(row => row.delivery_key.startsWith("event:")));
    } finally { poll.mockRestore(); server.stop(true); await s.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
