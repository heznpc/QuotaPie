import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveNotificationPreferences } from "../src/config";
import { DEFAULT_NOTIFICATION_TOPICS, notificationTopic } from "../src/notification-preferences";
import { deliverTrigger, planTriggers } from "../src/triggers";
import { signalDecision } from "../src/signals/presentation";
import type { ResetSignal, SignalState } from "../src/signals/classify";
import { ALERTABLE_EVENT_KINDS } from "../src/types";
import { QuotaPieService } from "../src/service";
import { QuotaDatabase } from "../src/db";
import { startDashboard } from "../src/server";

function signal(state: SignalState, id = state): ResetSignal {
  return { id, groupId: id, fingerprint: id + state, author: "thsottiaux", sourceUrl: "https://x.com/thsottiaux/status/123",
    text: `Synthetic Codex reset ${state}`, contextText: null, publishedAtMs: Date.now(), state,
    resetKind: "unknown", timeHint: null, scopeHint: null, observedVia: "public-feed", targetAtMs: null };
}

describe("notification topic preferences", () => {
  test("maps every alertable event and every public signal without confusing account recovery with reports", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const events = ALERTABLE_EVENT_KINDS.map((kind, id) => ({ id, provider: "codex" as const, account: "default", bucket: "primary",
      kind, severity: "info" as const, occurredAtMs: Date.now(), confidence: "high" as const, displayText: "", details: {} }));
    const decisions = planTriggers([], events, config, 0);
    expect(decisions.map(notificationTopic)).toEqual([
      "quotaRecovery", "quotaRecovery", "accountChanges", "payments", "payments", "accountChanges", "accountChanges", "accountChanges",
    ]);
    for (const [state, topic] of Object.entries({ possible: "resetPossible", announced: "resetAnnounced", updated: "resetUpdates", withdrawn: "resetUpdates", reported: "resetReported" } as const)) {
      expect(notificationTopic(signalDecision(signal(state as SignalState), "ko"))).toBe(topic);
    }
    for (const [key, topic] of Object.entries({ "codex:primary:remaining:10": "quotaWarnings", "codex:primary:rapid": "quotaWarnings",
      "codex:primary:pace": "quotaWarnings", "codex:primary:stale": "collectionIssues", "resume:123:ready": "resumeReady",
      "event:codex:primary:external_relief": "quotaRecovery" } as const)) expect(notificationTopic({ alertKey: key })).toBe(topic);
  });

  test("muted topics never call native or command delivery; re-enabling does not replay observed news", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.resetSignals.enabled = true;
    config.alerts.topics.resetPossible = false;
    // This command would fail and mark delivery incomplete if it were run.
    config.alerts.command = ["/usr/bin/false"];
    let nativeCalls = 0;
    const result = await deliverTrigger(signalDecision(signal("possible"), "en"), config, {
      queueMacOSNotification: () => { nativeCalls++; },
    });
    expect(result.complete).toBeTrue(); expect(result.suppressed).toBeTrue(); expect(nativeCalls).toBe(0);
    config.alerts.command = null;
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    service.setNativeNotificationTransportAvailable(true); service.alerts.setNativeNotificationConsumer(true);
    service.signalCollector.poll = async () => {};
    try {
      service.resetSignals.save([signal("possible"), signal("announced")], Date.now());
      await service.collectResetSignals();
      expect(service.alerts.pendingAppNotifications().map(n => notificationTopic(n))).toEqual(["resetAnnounced"]);
      expect(service.resetSignals.list()).toHaveLength(2);
      expect(service.resetSignals.pending(Date.now())).toHaveLength(0);
      service.applyNotificationPreferences({ topics: { ...config.alerts.topics, resetPossible: true } });
      await service.collectResetSignals();
      expect(service.alerts.pendingAppNotifications()).toHaveLength(1);
      config.alerts.enabled = false;
      service.resetSignals.save([signal("reported")], Date.now());
      await service.collectResetSignals();
      config.alerts.enabled = true;
      await service.collectResetSignals();
      expect(service.resetSignals.pending(Date.now())).toHaveLength(0);
      expect(service.resetSignals.list()).toHaveLength(3);
      expect(service.alerts.pendingAppNotifications()).toHaveLength(1);
    } finally { await service.close(); }
  });

  test("preference API persists partial patches, rejects invalid writes, and revokes already claimed topics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-preferences-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ profile: { locale: "ko" }, resetSignals: { enabled: true, tokenFile: "/private/token-path" }, custom: "preserved" }));
    const config = loadConfig(path); config.dashboard.port = 0; config.collection.codexEnabled = false;
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    const server = startDashboard(service, config, { preferencesPath: path, compactionRoot: dir });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const payload: any = await (await fetch(origin + "/api/status")).json();
      expect(payload.notificationPreferences.topics).toEqual(DEFAULT_NOTIFICATION_TOPICS);
      const headers = { "x-quotapie-action-token": payload.actionToken, "content-type": "application/json" };
      const post = (body: unknown, extra = {}) => fetch(origin + "/api/notifications/preferences", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      expect((await post({ topics: { resetPossible: false } }, { "x-quotapie-action-token": "wrong" })).status).toBe(403);
      expect((await post({ enabled: false }, { origin: "https://example.com" })).status).toBe(403);
      for (const invalid of [{ topics: { resetPossible: "false" } }, { topics: { invented: false } }, { command: ["bad"] }, []]) expect((await post(invalid)).status).toBe(400);
      const queued = service.alerts.queueMacOSNotification(signalDecision(signal("possible"), "en"), "old-possible");
      const claim = service.claimNextAppNotification()!;
      expect(claim.id).toBe(queued.id);
      service.alerts.queueMacOSNotification(signalDecision(signal("announced"), "en"), "kept-announcement");
      expect((await post({ topics: { resetPossible: false } })).status).toBe(200);
      expect(service.renewAppNotification(claim.id, claim.claimToken)).toBeFalse();
      expect(service.alerts.pendingAppNotifications().map(notificationTopic)).toEqual(["resetAnnounced"]);
      expect(service.claimNextAppNotification()?.deliveryKey).toBe("kept-announcement");
      expect(loadConfig(path).alerts.topics.resetPossible).toBeFalse();
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.custom).toBe("preserved"); expect(raw.profile.locale).toBe("ko");
      expect(raw.resetSignals.tokenFile).toBe("/private/token-path");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect((await post({ enabled: false })).status).toBe(200);
      expect(service.alerts.pendingAppNotifications()).toHaveLength(0);
      expect(loadConfig(path).alerts.topics.resetAnnounced).toBeTrue();
      expect((await post({ enabled: true })).status).toBe(200);
      expect(service.claimNextAppNotification()).toBeNull();
    } finally { server.stop(true); await service.close(); rmSync(dir, { recursive: true }); }
  });

  test("invalid config topic values fail instead of silently overriding defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "quotapie-invalid-preferences-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ alerts: { topics: { resetPossible: "no" } } }));
      expect(() => loadConfig(path)).toThrow();
      expect(() => saveNotificationPreferences({ topics: { invented: false } }, path)).toThrow();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
