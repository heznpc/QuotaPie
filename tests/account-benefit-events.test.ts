import { describe, expect, test } from "bun:test";
import { classifyDelta } from "../src/classify";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { parseCodexRateLimits } from "../src/providers/codex-appserver";
import { planTriggers } from "../src/triggers";
import { AlertStore } from "../src/storage/alert-store";
import { migrate } from "../src/storage/migrations";
import type { QuotaEvent, QuotaObservation } from "../src/types";

const NOW = 1_800_000_000_000;
function snapshot(tickets: number, offset: number, primary = 20, weekly = 100): QuotaObservation[] {
  return parseCodexRateLimits({
    rateLimits: { limitId: "codex", planType: "pro",
      primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: NOW / 1000 + 18_000 },
      secondary: { usedPercent: weekly, windowDurationMins: 10_080, resetsAt: NOW / 1000 + 604_800 + offset },
    }, rateLimitResetCredits: { availableCount: tickets },
  }, NOW + offset * 1000);
}

describe("observed account benefits", () => {
  test("a ticket grant is counted and delivered once across all account windows", async () => {
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), new QuotaDatabase(":memory:"));
    try {
      service.ingestCodexSnapshot(snapshot(0, 0));
      const events = service.ingestCodexSnapshot(snapshot(2, 60));
      const grants = events.filter(e => e.kind === "banked_reset_added");
      expect(grants).toHaveLength(1);
      expect(grants[0]!.details).toMatchObject({ countBefore: 0, countAfter: 2, countAdded: 2 });
      const alerts = planTriggers([], service.alerts.pendingEvents(), DEFAULT_CONFIG, 0, NOW + 60_000);
      expect(alerts.filter(a => a.presentation?.message.key === "event.banked_reset_added")).toHaveLength(1);
      expect(alerts[0]!.presentation?.title.key).toBe("alert.event.title.resetCredits");
    } finally { await service.close(); }
  });

  test("a weekly recovery with a ticket decrease cannot be mistaken for an external grant", async () => {
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), new QuotaDatabase(":memory:"));
    try {
      service.ingestCodexSnapshot(snapshot(3, 0));
      // The account ticket count is attached to primary, whose usage is unchanged.
      const events = service.ingestCodexSnapshot(snapshot(2, 600, 20, 0));
      expect(events.map(e => e.kind)).toEqual(["banked_reset_consumed"]);
      expect(events[0]!.details).toMatchObject({ countBefore: 3, countAfter: 2, countUsed: 1, quotaRecovered: true });
      expect(service.alerts.pendingEvents().map(e => e.kind)).toEqual(["banked_reset_consumed"]);
      expect(planTriggers([], events, DEFAULT_CONFIG, 0, NOW + 600_000)).toHaveLength(1);
      // The context is a fact about one snapshot, not a permanent suppression.
      service.ingestCodexSnapshot(snapshot(2, 660, 20, 50));
      expect(service.ingestCodexSnapshot(snapshot(2, 1260, 20, 0)).map(e => e.kind)).toContain("external_relief");
    } finally { await service.close(); }
  });

  test("a ticket decrease without recovered quota keeps that distinction", () => {
    const events = classifyDelta(snapshot(3, 0)[0]!, snapshot(2, 60)[0]!, DEFAULT_CONFIG);
    expect(events.find(e => e.kind === "banked_reset_consumed")?.details.quotaRecovered).toBe(false);
  });

  test("credit and ticket changes remain visible when quota fields are unavailable", () => {
    const before = { ...snapshot(1, 0)[0]!, creditBalance: 10 };
    const after = { ...snapshot(3, 60)[0]!, creditBalance: 25, usedPercent: null, resetsAtMs: null };
    const events = classifyDelta(before, after, DEFAULT_CONFIG);
    expect(events.map(e => e.kind)).toEqual(["credit_topup", "banked_reset_added", "source_unknown"]);
    expect(events[0]!.details).toMatchObject({ balanceBefore: 10, balanceAfter: 25, balanceAdded: 15, billingVerified: false });
    expect(planTriggers([], events, DEFAULT_CONFIG, 0, NOW + 60_000)
      .find(a => a.presentation?.message.key === "event.credit_topup")?.presentation?.title.key).toBe("alert.event.title.creditAdded");
  });

  test("a scheduled provider reset is delivered and a ratio drop does not assert an allowance increase", () => {
    const before = snapshot(1, 0)[0]!;
    const after = { ...before, observedAtMs: before.resetsAtMs! + 1000,
      usedPercent: 0, resetsAtMs: before.resetsAtMs! + 18_000_000 };
    const reset = classifyDelta(before, after, DEFAULT_CONFIG);
    expect(reset.map(e => e.kind)).toEqual(["scheduled_reset"]);
    expect(planTriggers([], reset, DEFAULT_CONFIG, 0, after.observedAtMs)[0]?.presentation?.message.key).toBe("event.scheduled_reset");
    const ratioDrop = classifyDelta({ ...before, usedPercent: 90 }, { ...before, observedAtMs: NOW + 1000, usedPercent: 60 }, DEFAULT_CONFIG);
    expect(ratioDrop.map(e => e.kind)).toEqual(["allowance_relief"]);
    expect(ratioDrop[0]!.details).not.toHaveProperty("allowanceIncreasePercent");
  });

  test("upgrading does not replay historical resets and does not suppress subsequent resets", () => {
    const db = new QuotaDatabase(":memory:");
    const alerts = new AlertStore(db.storage);
    const add = (kind: QuotaEvent["kind"], time: number) => {
      const event: QuotaEvent = { provider: "codex", account: "default", bucket: "primary", kind,
        occurredAtMs: time, severity: "info", confidence: "high", displayText: "synthetic", details: {} };
      db.insertEvent(event);
      return event.id!;
    };
    try {
      db.db.run("DELETE FROM schema_migrations WHERE name='observed_reset_notifications_v1'");
      const historical = [add("scheduled_reset", NOW), add("banked_reset_consumed", NOW)];
      const other = add("credit_topup", NOW);
      migrate(db.db);
      expect(alerts.pendingEvents().map(e => e.id)).toEqual([other]);
      for (const id of historical) expect(db.db.query<{ disposition: string }, [number]>(
        "SELECT disposition FROM event_delivery WHERE event_id=?").get(id)?.disposition).toBe("preexisting");
      const recent = add("scheduled_reset", NOW + 1000);
      migrate(db.db);
      expect(alerts.pendingEvents().map(e => e.id)).toEqual([other, recent]);
    } finally { db.close(); }
  });
});
