import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { classifyPost, type ResetSignal } from "../src/signals/classify";
import { benefitChangeText, signalDecision } from "../src/signals/presentation";
import { notificationTopic } from "../src/notification-preferences";

function post(text: string, id = "9101") {
  return { id, author: "thsottiaux", text, createdAtMs: Date.now(), conversationId: id, references: [] };
}

test("allowance news quotes the announced increase and keeps it distinct from measured account quota", () => {
  const signal = classifyPost(post("Codex users get 50% more usage starting today."), new Map())!;
  expect(signal).not.toBeNull();
  const ko = signalDecision(signal, "ko", "Asia/Seoul");
  expect(notificationTopic(ko)).toBe("limitChanges");
  expect(ko.message).toContain("기존 대비 +50% (기존의 1.5배)");
  expect(ko.message).toContain("발표 수치");
  expect(ko.message).not.toContain("내 계정");
  expect(benefitChangeText(signal, "en")).toContain("+50% (1.5× previous allowance)");
});

test("stored banked-reset announcements use the reset ticket topic without claiming an executed reset", () => {
  const signal: ResetSignal = { id: "9102", groupId: "9102", fingerprint: "banked", author: "thsottiaux",
    sourceUrl: "https://x.com/thsottiaux/status/9102", text: "Everyone is getting another banked reset today.",
    contextText: null, publishedAtMs: Date.now(), state: "reported", resetKind: "banked", benefitKind: "reset",
    timeHint: null, scopeHint: null, observedVia: "public-feed", targetAtMs: null };
  const decision = signalDecision(signal, "ko");
  expect(notificationTopic(decision)).toBe("resetCredits");
  expect(decision.title).toContain("리셋권 추가");
  expect(decision.title).not.toContain("리셋 시행");
});

test("a mixed announcement delivers each enabled benefit once and never replays muted benefits", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.codexEnabled = false;
  config.resetSignals.enabled = true;
  config.alerts.topics.resetCredits = false;
  config.alerts.command = null;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  service.signalCollector.poll = async () => {};
  service.setNativeNotificationTransportAvailable(true);
  service.alerts.setNativeNotificationConsumer(true);
  try {
    const signal = classifyPost(post("Everyone gets another banked reset today. We added 100000 tokens to every account. Codex users get 50% more usage."), new Map())!;
    service.resetSignals.save([signal], Date.now());
    await service.collectResetSignals();
    const queued = service.alerts.pendingAppNotifications();
    expect(queued.map(notificationTopic).sort()).toEqual(["creditGrants", "limitChanges"]);
    expect(service.resetSignals.list()).toHaveLength(3);
    expect(queued.map(n => n.message).join(" ")).toContain("100,000");
    expect(service.resetSignals.pending(Date.now())).toHaveLength(0);
    service.applyNotificationPreferences({ topics: { resetCredits: true } });
    await service.collectResetSignals();
    expect(service.alerts.pendingAppNotifications()).toHaveLength(2);
  } finally { await service.close(); }
});

test("an unrelated student offer does not mute an explicitly universal allowance increase", async () => {
  const signal = classifyPost(post("We increased usage limits by 50% for everyone. Students can get free credits."), new Map())!;
  const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), new QuotaDatabase(":memory:"));
  try {
    service.resetSignals.save([signal], Date.now());
    const topics = service.resetSignals.list().map(s => notificationTopic(signalDecision(s, "en")));
    expect(topics).toContain("limitChanges");
    expect(topics).toContain("studentBenefits");
  } finally { await service.close(); }
});
