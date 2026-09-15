import type { CompactionRequestEvent } from "./codex-compaction";
import type { TriggerDecision } from "./types";
import type { AppConfig } from "./config";
import { t, type Locale, type MessageKey } from "./i18n";
import { notificationAllowed } from "./notification-preferences";
import { AlertStore } from "./storage/alert-store";
import type { QuotaStorage } from "./storage/database";

interface RouteState {
  started: number;
  request: string;
  route: string;
  routed: boolean;
  phase: string;
  responseModel: string | null;
  failed: boolean;
}
const ongoing = (phase: string) => ["started", "response_headers"].includes(phase);
const short = (model: string) => model.replace(/^gpt-\d+(?:\.\d+)?-/, "");

/** Durable transition tracking shares the outbox transaction. No prompts or credentials. */
export class ModelNotifications {
  constructor(private storage: QuotaStorage, private alerts: AlertStore) {}

  observe(events: CompactionRequestEvent[], config: AppConfig, locale: Locale, now = Date.now()): void {
    this.storage.transaction(() => {
      for (const event of [...events].sort((a, b) =>
        (Date.parse(a.at) - a.durationMs) - (Date.parse(b.at) - b.durationMs) || Date.parse(a.at) - Date.parse(b.at))) {
        const at = Date.parse(event.at), started = at - event.durationMs;
        // A reopened app must not replay yesterday's history. Long-running live
        // requests still qualify when the relay supplies a fresh observation.
        if (at < now - 120_000 || at > now + 5_000) continue;
        const compact = event.kind === "compaction";
        if (compact ? !event.routed : !event.threadId || !event.savingsReason) continue;
        const scope = compact ? `compaction:${event.requestId}` : `savings:${event.threadId}`;
        const row = this.storage.db.query<{ payload: string }, [string]>(
          "SELECT payload FROM model_notification_state WHERE scope = ?").get(scope);
        const previous: RouteState | null = row ? JSON.parse(row.payload) : null;
        if (previous && started < previous.started) continue;
        const route = `${event.to}:${event.reasoningEffort}:${event.routed}`;
        const changed = !previous || previous.route !== route;
        const failed = ["failed", "cancelled", "unverified"].includes(event.phase);
        const state: RouteState = {
          started, request: event.requestId, route, routed: event.routed, phase: event.phase,
          responseModel: event.responseModel ?? (changed ? null : previous?.responseModel ?? null),
          failed: failed || (!changed && (previous?.failed ?? false)),
        };
        let key: MessageKey | null = null;
        if (compact) {
          if (!previous || ongoing(previous.phase) && !ongoing(event.phase)) {
            key = ongoing(event.phase) ? "model.notice.request" : failed ? "model.notice.failed" : "model.notice.completed";
          }
        } else if (changed && (event.routed || previous?.routed)) {
          key = failed ? "model.notice.failed" : event.responseModel ? "model.notice.confirmed" : "model.notice.request";
        } else if (event.routed && failed && !previous?.failed) {
          key = "model.notice.failed";
        } else if (event.routed && event.responseModel && event.responseModel !== previous?.responseModel) {
          key = "model.notice.confirmed";
        }
        if (key) {
          const titleKey = compact ? "model.notice.compaction" : event.routed ? "model.notice.savings" : "model.notice.original";
          const params = {
            fromLabel: `${short(event.from)} ${event.requestedEffort ?? "?"}`,
            toLabel: `${short(event.to)} ${event.reasoningEffort ?? "?"}`,
            label: event.responseModel ? short(event.responseModel) : "?",
            detail: String(Math.round(event.durationMs / 1000)),
          };
          const decision: TriggerDecision = {
            key: `model:${scope}:${event.requestId}:${key}`, title: t(titleKey, {}, locale),
            message: t(key, params, locale), severity: failed ? "warning" as const : "info" as const,
            presentation: { title: { key: titleKey, params: {} }, message: { key, params } },
          };
          if (config.alerts.macOSNotifications && notificationAllowed(decision, config.alerts)) {
            // Native-only, with a short TTL: model transitions should not later
            // appear as though an old request is still being routed.
            this.alerts.queueMacOSNotification(decision, decision.key, now, now + 120_000);
          }
        }
        // Muted observations are consumed too, so unmuting cannot replay them.
        this.storage.db.query(`INSERT INTO model_notification_state(scope, payload, updated_at_ms) VALUES (?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload, updated_at_ms=excluded.updated_at_ms`)
          .run(scope, JSON.stringify(state), at);
      }
      this.storage.db.query("DELETE FROM model_notification_state WHERE updated_at_ms < ?").run(now - 30 * 24 * 60 * 60_000);
    });
  }
}
