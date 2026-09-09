import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { classifyDelta } from "../src/classify";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { classifyPost } from "../src/signals/classify";
import { correlateRecoveries } from "../src/signals/correlation";
import type { QuotaObservation } from "../src/types";

// Synthetic reproduction, not a claim about the user's historical account.
const morning = Date.parse("2026-09-08T10:00:00+09:00");
const afternoon = Date.parse("2026-09-08T13:05:00+09:00");
const before: QuotaObservation = {
  provider: "codex", account: "personal", bucket: "weekly", label: "Weekly", windowSeconds: 604800,
  usedPercent: 95, resetsAtMs: morning + 4 * 86400_000,
  observedAtMs: morning - 300_000, source: "codex-appserver", quality: "authoritative",
};
const after = { ...before, observedAtMs: morning, usedPercent: 0, resetsAtMs: morning + 7 * 86400_000 };
const announcement = classifyPost({
  id: "2097174560412246215", author: "thsottiaux", text: "All reset for everyone. Enjoy the week with Astra.",
  createdAtMs: afternoon, conversationId: "2097174560412246215", references: [],
}, new Map())!;
const events = () => classifyDelta(before, after, DEFAULT_CONFIG);

describe("reset evidence correlation", () => {
  test("a later publication is a candidate, not a second or precisely timed recovery", () => {
    expect(announcement.state).toBe("reported");
    expect(announcement.resetKind).toBe("direct");
    const rows = correlateRecoveries(events(), [announcement], afternoon);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observedBetween).toEqual({ afterMs: morning - 300_000, byMs: morning });
    expect(rows[0]!.remainingBefore).toBe(5);
    expect(rows[0]!.remainingAfter).toBe(100);
    expect(rows[0]!.candidates[0]!.publicationAfterObservation).toBe(true);
    expect(rows[0]!.candidates[0]!.relation).toBe("candidate");
    expect(rows[0]!.nextResetsAtMs).toBe(after.resetsAtMs);
    expect(correlateRecoveries([], [announcement], afternoon)).toEqual([]);
    expect(correlateRecoveries(events(), [announcement], morning)[0]!.candidates).toEqual([]);
  });

  test("accounts, providers and windows remain independent", () => {
    const rows = correlateRecoveries([
      ...events(),
      ...classifyDelta({ ...before, account: "work" }, { ...after, account: "work", usedPercent: 96 }, DEFAULT_CONFIG),
      ...classifyDelta({ ...before, provider: "claude" }, { ...after, provider: "claude" }, DEFAULT_CONFIG),
    ], [announcement], afternoon);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.account).toBe("personal");
    expect(rows[1]!.provider).toBe("claude");
    expect(rows[1]!.candidates).toEqual([]);
  });

  test("unknown intervals, long gaps, source changes, reset credit decreases and scheduled resets do not match", () => {
    const base = events()[0]!;
    const cases = [
      { ...base, details: {} },
      { ...base, details: { ...base.details, previousObservedAtMs: morning - 3600_000 } },
      { ...base, details: { ...base.details, previousSource: "fallback" } },
      { ...base, details: { ...base.details, resetCreditDecreased: true } },
      { ...base, kind: "scheduled_reset" as const },
    ];
    expect(correlateRecoveries(cases, [announcement], afternoon).map(r => [r.reason, r.candidates.length])).toEqual([
      ["insufficient-evidence", 0], ["observation-gap", 0], ["source-changed", 0],
      ["reset-credit-decreased", 0], ["scheduled", 0],
    ]);
  });

  test("banked, withdrawn, corrected, possible and distant posts cannot supply attribution", () => {
    for (const signal of [
      { ...announcement, resetKind: "banked" as const },
      { ...announcement, state: "possible" as const },
      { ...announcement, state: "withdrawn" as const },
      { ...announcement, publishedAtMs: morning + 8 * 3600_000 },
    ]) expect(correlateRecoveries(events(), [signal], morning + 9 * 3600_000)[0]!.candidates).toEqual([]);
    for (const state of ["withdrawn", "updated"] as const) {
      expect(correlateRecoveries(events(), [announcement, { ...announcement, id: "200", state,
        publishedAtMs: afternoon + 1 }], afternoon + 1)[0]!.candidates).toEqual([]);
    }
  });

  test("API uses persisted evidence; repeat collection and reads do not create events or notifications", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.dashboard.port = 0;
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(config, db);
    const server = startDashboard(service, config);
    try {
      service.ingest([before, after]);
      const count = db.recentEvents(100).length;
      service.resetSignals.save([announcement], afternoon);
      service.resetSignals.save([announcement], afternoon);
      const origin = `http://127.0.0.1:${server.port}`;
      const payload = await (await fetch(`${origin}/api/reset-tracking`)).json() as any;
      expect(payload.attribution).toBe("unconfirmed");
      expect(payload.recoveries).toHaveLength(1);
      expect(payload.recoveries[0].candidates).toHaveLength(1);
      const status = await (await fetch(`${origin}/api/status`)).json() as any;
      expect(status.resetTracking.recoveries).toEqual(payload.recoveries);
      expect(db.recentEvents(100)).toHaveLength(count);
      expect(db.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM app_notification_outbox").get()!.count).toBe(0);
      expect(db.latest("codex", "personal", "weekly")?.resetsAtMs).toBe(after.resetsAtMs);
    } finally { server.stop(true); service.close(); }
  });
});
