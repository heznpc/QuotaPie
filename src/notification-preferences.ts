import type { AppConfig } from "./config";
import type { NotificationPresentation } from "./types";

export const DEFAULT_NOTIFICATION_TOPICS = {
  modelChanges: true, quotaWarnings: true, collectionIssues: true, quotaRecovery: true,
  accountChanges: true, payments: true, resumeReady: true,
  resetPossible: true, resetAnnounced: true, resetUpdates: true, resetReported: true,
};
export type NotificationTopic = keyof typeof DEFAULT_NOTIFICATION_TOPICS;
export type NotificationTopics = Record<NotificationTopic, boolean>;
export interface NotificationPreferences { enabled: boolean; topics: NotificationTopics }
export interface NotificationPreferencesPatch { enabled?: boolean; topics?: Partial<NotificationTopics> }

// Use semantic keys, never translated display text. The alert key is a fallback
// for durable notifications queued before semantic presentation was introduced.
export function notificationTopic(input: {
  key?: string; alertKey?: string; presentation?: NotificationPresentation | null;
}): NotificationTopic | null {
  const title = input.presentation?.title.key ?? "";
  const message = input.presentation?.message.key ?? "";
  const key = input.key ?? input.alertKey ?? "";
  if (key.startsWith("model:") || title.startsWith("model.notice.")) return "modelChanges";
  if (title === "signal.possible") return "resetPossible";
  if (title === "signal.announced") return "resetAnnounced";
  if (title === "signal.updated" || title === "signal.withdrawn") return "resetUpdates";
  if (title === "signal.reported") return "resetReported";
  if (key.startsWith("signal:")) return "resetAnnounced";
  if (title.startsWith("alert.resume.") || key.startsWith("resume:") || title.startsWith("alert.jobs.") || key.startsWith("jobs:")) return "resumeReady";
  if (title.startsWith("alert.stale.") || key.endsWith(":stale")) return "collectionIssues";
  if (title.startsWith("alert.remaining.") || title.startsWith("alert.rapid.") || title.startsWith("alert.pace.")
    || /:(remaining:\d+|rapid|pace)$/.test(key)) return "quotaWarnings";
  const event = message.startsWith("event.") ? message.slice(6) : key.startsWith("event:") ? key.split(":").at(-1) : "";
  if (["external_relief", "allowance_relief", "scheduled_reset"].includes(event ?? "")) return "quotaRecovery";
  if (["paid_usage", "credit_topup"].includes(event ?? "")) return "payments";
  if (["schedule_rebased", "window_changed", "account_changed", "plan_changed"].includes(event ?? "")) return "accountChanges";
  return null; // Explicit test alerts and third-party integrations have no topic.
}

export function notificationAllowed(input: Parameters<typeof notificationTopic>[0], alerts: AppConfig["alerts"]): boolean {
  const topic = notificationTopic(input);
  return alerts.enabled && (topic == null || alerts.topics[topic]);
}

export function validateNotificationPatch(input: unknown): asserts input is NotificationPreferencesPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid preferences");
  const patch = input as Record<string, unknown>;
  if (!Object.keys(patch).length || Object.keys(patch).some(k => !["enabled", "topics"].includes(k))) throw new Error("invalid preferences");
  if ("enabled" in patch && typeof patch.enabled !== "boolean") throw new Error("invalid enabled");
  if ("topics" in patch) {
    if (!patch.topics || typeof patch.topics !== "object" || Array.isArray(patch.topics)) throw new Error("invalid topics");
    for (const [key, value] of Object.entries(patch.topics)) {
      if (!Object.hasOwn(DEFAULT_NOTIFICATION_TOPICS, key) || typeof value !== "boolean") throw new Error("invalid topic");
    }
  }
}
