import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { ModelNotifications } from "../src/model-notifications";
import { notificationTopic } from "../src/notification-preferences";
import type { CompactionRequestEvent } from "../src/codex-compaction";

const now = Date.now();
const base = (patch: Partial<CompactionRequestEvent> = {}): CompactionRequestEvent => ({
  requestId: randomUUID(), threadId: randomUUID(), turnId: null, kind: "compaction", from: "gpt-6-astra", to: "gpt-5.6-sol",
  requestedEffort: "xhigh", reasoningEffort: "low", routed: true, phase: "started", status: 0, at: new Date(now).toISOString(), durationMs: 0, ...patch,
});
function setup() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.codexEnabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const observer = new ModelNotifications(service.storage, service.alerts);
  return { config, service, observer, pending: () => service.alerts.pendingAppNotifications(now) };
}

test("compaction start, headers, finish and restart deliver once with honest model evidence", async () => {
  const { config, service, observer, pending } = setup();
  try {
    const event = base();
    observer.observe([event], config, "ko", now);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.message).toContain("아직 미확인");
    expect(notificationTopic(pending()[0]!)).toBe("modelChanges");
    const headers = { ...event, phase: "response_headers" as const, status: 200, at: new Date(now + 1000).toISOString(), durationMs: 1000 };
    observer.observe([headers], config, "ko", now + 1000);
    expect(pending()).toHaveLength(1);
    const end = { ...headers, phase: "completed" as const, at: new Date(now + 3000).toISOString(), durationMs: 3000 };
    observer.observe([end], config, "ko", now + 3000);
    expect(pending()).toHaveLength(2);
    expect(pending()[1]?.message).toContain("응답 모델: 미확인");
    new ModelNotifications(service.storage, service.alerts).observe([end], config, "ko", now + 4000);
    expect(pending()).toHaveLength(2);
  } finally { await service.close(); }
});

test("savings coalesces tool continuations, confirms responses and notifies original-setting restoration", async () => {
  const { config, service, observer, pending } = setup();
  try {
    const event = base({ kind: "response", to: "gpt-5.6-luna", savingsReason: "simple_text_edit" });
    observer.observe([event], config, "ko", now);
    const complete = { ...event, phase: "completed" as const, responseModel: "gpt-5.6-luna", durationMs: 1000, at: new Date(now + 1000).toISOString() };
    observer.observe([complete], config, "ko", now + 1000);
    expect(pending()).toHaveLength(2);
    expect(pending()[1]?.message).toContain("응답 모델: luna");
    const continuation = { ...complete, requestId: randomUUID(), durationMs: 1000, at: new Date(now + 3000).toISOString() };
    observer.observe([complete, continuation], config, "ko", now + 3000);
    new ModelNotifications(service.storage, service.alerts).observe([continuation], config, "ko", now + 4000);
    expect(pending()).toHaveLength(2);
    const restored = { ...event, requestId: randomUUID(), routed: false, to: event.from, reasoningEffort: "xhigh", savingsReason: "disabled" as const, at: new Date(now + 5000).toISOString() };
    observer.observe([restored], config, "ko", now + 5000);
    expect(pending()).toHaveLength(3);
    expect(pending()[2]?.title).toContain("원래 설정");
  } finally { await service.close(); }
});

test("muted and historical observations never replay; failures never announce completion", async () => {
  const { config, service, observer, pending } = setup();
  try {
    config.alerts.topics.modelChanges = false;
    const event = base();
    observer.observe([event], config, "ko", now);
    config.alerts.topics.modelChanges = true;
    observer.observe([event, base({at: new Date(now - 121000).toISOString()})], config, "ko", now);
    expect(pending()).toHaveLength(0);
    observer.observe([{...event, phase: "failed", durationMs: 1000, at: new Date(now + 1000).toISOString()}], config, "ko", now + 1000);
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.severity).toBe("warning");
    expect(pending()[0]?.message).toContain("완료를 확인하지 못했습니다");
    service.applyNotificationPreferences({topics: {modelChanges: false}});
    expect(pending()).toHaveLength(0);
  } finally { await service.close(); }
});
