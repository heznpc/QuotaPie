import { describe, expect, test } from "bun:test";
import { analyzeWindow, buildHeadline } from "../src/analytics";
import { DEFAULT_CONFIG } from "../src/config";
import { planTriggers } from "../src/triggers";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import type { QuotaObservation } from "../src/types";

const NOW = Date.UTC(2026, 8, 12, 20); // 05:00 KST, outside the legacy schedule.
const MIN = 60_000;
function point(minutes: number, used: number, epoch = "session-a"): QuotaObservation {
  return { provider: "codex", account: "default", bucket: "codex:primary:10080", label: "Codex weekly",
    windowSeconds: 604800, source: "codex-appserver", quality: "authoritative", observedAtMs: NOW + minutes * MIN,
    usedPercent: used, resetsAtMs: NOW + 3 * 86400000, metadata: { collectorEpoch: epoch } };
}

describe("observed quota regressions", () => {
  test("overnight rapid consumption alerts while more than 20% remains", () => {
    const history = [point(-9, 10), point(-5, 16), point(0, 24)];
    const a = analyzeWindow(history[2]!, history, DEFAULT_CONFIG, NOW);
    expect(a.recentBurnPerHour).toBeCloseTo(14 / 9 * 60);
    const alerts = planTriggers([a], [], DEFAULT_CONFIG, 0, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.key).toEndWith(":rapid");
    expect(alerts[0]?.presentation?.message.params).toMatchObject({ drop: 14, minutes: 9, percent: 76 });
  });

  test("does not throw away very fast genuine consumption", () => {
    const history = [point(-1, 10), point(0, 25)];
    const a = analyzeWindow(history[1]!, history, DEFAULT_CONFIG, NOW);
    expect(a.recentBurnPerHour).toBe(900);
    expect(planTriggers([a], [], DEFAULT_CONFIG, 0, NOW).some(x => x.key.endsWith(":rapid"))).toBeTrue();
  });

  test("a reset clears prior burn even if the provider keeps the reset clock", () => {
    const history = [point(-9, 40), point(-5, 70), point(0, 0)];
    const a = analyzeWindow(history[2]!, history, DEFAULT_CONFIG, NOW);
    expect(a.remainingPercent).toBe(100);
    expect(a.recentBurnPerHour).toBeNull();
    expect(a.personalBurnPerHour).toBeNull();
    expect(a.exhaustsAtMs).toBeNull();
    expect(a.riskLevel).toBe("none");
    expect(planTriggers([a], [], DEFAULT_CONFIG, 0, NOW)).toEqual([]);
  });

  test("an account change cannot count the new account's higher usage as a spike", () => {
    const history = [point(-9, 10), point(-5, 30), point(0, 75, "session-b")];
    const a = analyzeWindow(history[2]!, history, DEFAULT_CONFIG, NOW);
    expect(a.recentBurnPerHour).toBeNull();
    expect(a.rapidDropPercent).toBe(0);
    expect(planTriggers([a], [], DEFAULT_CONFIG, 0, NOW)).toEqual([]);
  });

  test("a burst ages out and stale readings cannot send consumption alerts", () => {
    const history = [point(-20, 0), point(-15, 30), point(0, 30)];
    const a = analyzeWindow(history[2]!, history, DEFAULT_CONFIG, NOW);
    expect(a.rapidDropPercent).toBe(0);
    expect(planTriggers([{ ...a, freshness: "stale", rapidDropPercent: 20 }], [], DEFAULT_CONFIG, 0, NOW)
      .filter(x => x.key.endsWith(":rapid") || x.key.includes(":remaining:"))).toEqual([]);
  });

  test("full quota remains numeric even beside an unrelated stale provider", () => {
    const a = analyzeWindow(point(0, 0), [point(0, 0)], DEFAULT_CONFIG, NOW);
    const state = { provider: "codex" as const, account: "default", accountLabel: "Main", enabled: true,
      windows: [a], bottleneckBucket: a.bucket, updatedAtMs: NOW,
      collection: { health: "recent-success" as const, activeSource: a.source, lastSuccessAtMs: NOW,
        errorCategory: null, errorDetail: null, sources: [] } };
    const headline = buildHeadline([state, { ...state, provider: "claude", windows: [],
      collection: { ...state.collection, health: "stale-success" } }], NOW, "ko");
    expect(headline.displayText).toBe("Codex 주간 100% 남음");
  });
});

describe("suppressed native alerts", () => {
  test("permission recovery re-evaluates current thresholds once, without replaying old messages", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.claude = [];
    config.alerts.command = null;
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    service.setNativeNotificationTransportAvailable(true);
    service.alerts.setNativeNotificationConsumer(true);
    const now = Date.now();
    const low = { ...point(0, 82), observedAtMs: now, resetsAtMs: now + 86400000 };
    service.ingest([low]);
    try {
      await service.evaluateTriggers(now);
      const old = service.claimNextAppNotification(now)!;
      expect(old).not.toBeNull();
      service.completeAppNotification(old.id, old.claimToken, "suppressed", now);
      await service.retrySuppressedNotifications(now + 1);
      const retry = service.claimNextAppNotification(now + 2)!;
      expect(retry).not.toBeNull();
      expect(retry.id).not.toBe(old.id);
      service.completeAppNotification(retry.id, retry.claimToken, "scheduled", now + 3);
      await service.retrySuppressedNotifications(now + 4);
      expect(service.claimNextAppNotification(now + 5)).toBeNull();
    } finally { await service.close(); }
  });

  test("a refill does not replay a formerly suppressed low-quota alert", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.claude = [];
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    service.setNativeNotificationTransportAvailable(true);
    service.alerts.setNativeNotificationConsumer(true);
    const now = Date.now();
    const low = { ...point(0, 82), observedAtMs: now, resetsAtMs: now + 86400000 };
    service.ingest([low]);
    try {
      await service.evaluateTriggers(now);
      const old = service.claimNextAppNotification(now)!;
      service.completeAppNotification(old.id, old.claimToken, "suppressed", now);
      service.ingest([{ ...low, observedAtMs: now + 1000, usedPercent: 0 }]);
      await service.retrySuppressedNotifications(now + 1001);
      expect(service.claimNextAppNotification(now + 1002)).toBeNull();
    } finally { await service.close(); }
  });
});

test("a new login immediately excludes old-only windows without deleting history", async () => {
  const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), new QuotaDatabase(":memory:"));
  try {
    const first = point(-2, 90);
    const oldOnly = { ...first, bucket: "codex:secondary:300", usedPercent: 100 };
    service.ingestCodexSnapshot([first, oldOnly]);
    service.ingestCodexSnapshot([point(0, 0, "session-b")]);
    expect(service.analyses(NOW, "codex").map(x => x.bucket)).toEqual([first.bucket]);
    expect(service.db.history("codex", "default", oldOnly.bucket)).toHaveLength(1);
    expect(service.recentEvents().filter(x => ["external_relief", "allowance_relief"].includes(x.kind))).toEqual([]);
  } finally { await service.close(); }
});

test("a refill re-arms low-quota warnings without waiting out the previous cooldown", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.claude = [];
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  service.setNativeNotificationTransportAvailable(true);
  service.alerts.setNativeNotificationConsumer(true);
  const now = Date.now();
  const low = { ...point(0, 82), observedAtMs: now, resetsAtMs: now + 86400000 };
  try {
    service.ingest([low]);
    await service.evaluateTriggers(now);
    const first = service.claimNextAppNotification(now)!;
    service.completeAppNotification(first.id, first.claimToken, "scheduled", now);
    service.ingest([{ ...low, observedAtMs: now + 1000, usedPercent: 0 }]);
    await service.evaluateTriggers(now + 1000);
    service.ingest([{ ...low, observedAtMs: now + 2000, usedPercent: 82 }]);
    const decisions = await service.evaluateTriggers(now + 2000);
    expect(decisions.some(x => x.key.endsWith(":remaining:20"))).toBeTrue();
  } finally { await service.close(); }
});


test("a collector restart does not re-send a low-quota warning already shown", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.claude = [];
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  service.setNativeNotificationTransportAvailable(true);
  service.alerts.setNativeNotificationConsumer(true);
  const now = Date.now();
  const low = { ...point(0, 82), observedAtMs: now, resetsAtMs: now + 86400000 };
  try {
    service.ingestCodexSnapshot([low]);
    await service.evaluateTriggers(now);
    const first = service.claimNextAppNotification(now)!;
    service.completeAppNotification(first.id, first.claimToken, "scheduled", now);
    service.ingestCodexSnapshot([{ ...low, observedAtMs: now + 1000, metadata: { collectorEpoch: "new-process" } }]);
    await service.evaluateTriggers(now + 1000);
    expect(service.claimNextAppNotification(now + 1001)).toBeNull();
  } finally { await service.close(); }
});

test("fast provider push updates retain a rapid drop even inside ten seconds", () => {
  const history = [point(-0.05, 10), point(0, 25)];
  const analysis = analyzeWindow(history[1]!, history, DEFAULT_CONFIG, NOW);
  expect(analysis.rapidDropPercent).toBe(15);
  const rapid = planTriggers([analysis], [], DEFAULT_CONFIG, 0, NOW).find(x => x.key.endsWith(":rapid"));
  expect(rapid?.presentation?.message.params).toMatchObject({ minutes: 1, drop: 15, percent: 75 });
});
