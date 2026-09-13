import { randomUUID } from "node:crypto";
import { isMessageKey } from "../i18n";
import type { MessageParams } from "../i18n";
import { ALERTABLE_EVENT_KINDS, MACOS_NOTIFICATION_CHANNEL } from "../types";
import type {
  AppNotification,
  AppNotificationClaim,
  AppNotificationDisposition,
  QuotaEvent,
  TriggerDecision,
} from "../types";
import type { QuotaStorage } from "./database";

export const APP_NOTIFICATION_DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface AlertClaim {
  token: string;
  generation: number;
}

interface EventRow {
  id: number;
  provider: QuotaEvent["provider"];
  account: string;
  bucket: string;
  kind: QuotaEvent["kind"];
  severity: QuotaEvent["severity"];
  occurred_at_ms: number;
  confidence: QuotaEvent["confidence"];
  summary: string;
  details_json: string;
}

interface AppNotificationRow {
  id: string;
  delivery_key: string;
  alert_key: string;
  title: string;
  message: string;
  title_key: string | null;
  title_params_json: string | null;
  message_key: string | null;
  message_params_json: string | null;
  severity: AppNotification["severity"];
  created_at_ms: number;
  expires_at_ms: number;
}

interface AppNotificationClaimRow extends AppNotificationRow {
  claimed_at_ms: number;
  claimed_token: string;
}

function eventFromRow(row: EventRow): QuotaEvent {
  return {
    id: row.id,
    provider: row.provider,
    account: row.account,
    bucket: row.bucket,
    kind: row.kind,
    severity: row.severity,
    occurredAtMs: row.occurred_at_ms,
    confidence: row.confidence,
    displayText: row.summary,
    details: JSON.parse(row.details_json || "{}"),
  };
}

function isMessageParams(value: unknown): value is MessageParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) =>
    item == null ||
    typeof item === "string" ||
    typeof item === "boolean" ||
    (typeof item === "number" && Number.isFinite(item))
  );
}

function appNotificationFromRow(row: AppNotificationRow): AppNotification {
  const presentation = (() => {
    if (!isMessageKey(row.title_key) || !isMessageKey(row.message_key)) return null;
    try {
      const titleParams: unknown = JSON.parse(row.title_params_json ?? "{}");
      const messageParams: unknown = JSON.parse(row.message_params_json ?? "{}");
      if (!isMessageParams(titleParams) || !isMessageParams(messageParams)) return null;
      return {
        title: { key: row.title_key, params: titleParams },
        message: { key: row.message_key, params: messageParams },
      };
    } catch {
      // Rows queued by an older or interrupted migration retain their finished
      // strings and remain deliverable instead of poisoning the whole outbox.
      return null;
    }
  })();
  return {
    id: row.id,
    deliveryKey: row.delivery_key,
    alertKey: row.alert_key,
    title: row.title,
    message: row.message,
    presentation,
    severity: row.severity,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

function appNotificationClaimFromRow(row: AppNotificationClaimRow): AppNotificationClaim {
  return {
    ...appNotificationFromRow(row),
    claimToken: row.claimed_token,
    claimedAtMs: row.claimed_at_ms,
  };
}

/// The alert subsystem as one aggregate.
///
/// alert_state, event_delivery, alert_channel_delivery, and the native outbox
/// implement a single feature — claim, lease, complete, and remember which
/// channels already succeeded — so one owner holds them together. Splitting
/// them by table would put a transaction boundary through the middle of a
/// delivery, which is the one place it must not go.
export class AlertStore {
  constructor(private readonly storage: QuotaStorage) {}

  suppressedThresholdKeys(): string[] {
    return this.storage.db.query<{ alert_key: string }, []>(`
      SELECT n.alert_key FROM app_notification_outbox n
      WHERE n.disposition = 'suppressed' AND n.delivery_key LIKE 'threshold:%'
        AND NOT EXISTS (
          SELECT 1 FROM app_notification_outbox newer
          WHERE newer.alert_key = n.alert_key AND newer.rowid > n.rowid
        )
    `).all().map((row) => row.alert_key);
  }

  pendingEvents(limit = 500): QuotaEvent[] {
    const rows = this.storage.db
      .query<EventRow, [number]>(`
        SELECT e.id, e.provider, e.account, e.bucket, e.kind, e.severity,
               e.occurred_at_ms, e.confidence, e.summary, e.details_json
        FROM events e
        LEFT JOIN event_delivery d ON d.event_id = e.id
        WHERE d.delivered_at_ms IS NULL
          AND e.kind IN (${ALERTABLE_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ")})
        ORDER BY e.id ASC LIMIT ?
      `)
      .all(limit);
    return rows.map(eventFromRow);
  }

  state(key: string): { lastFiredAtMs: number; armed: boolean } | null {
    const row = this.storage.db
      .query<{ last_fired_at_ms: number; armed: number }, [string]>(
        "SELECT last_fired_at_ms, armed FROM alert_state WHERE key = ?",
      )
      .get(key);
    return row ? { lastFiredAtMs: row.last_fired_at_ms, armed: row.armed === 1 } : null;
  }

  setState(key: string, lastFiredAtMs: number, armed: boolean, nowMs = Date.now()): void {
    this.storage.transaction(() => {
      this.storage.db
        .query(`
          INSERT INTO alert_state(
            key, last_fired_at_ms, armed, claimed_at_ms, claimed_token, generation, occurrence_open
          ) VALUES (?, ?, ?, NULL, NULL, 0, 0)
          ON CONFLICT(key) DO UPDATE SET
            last_fired_at_ms = excluded.last_fired_at_ms,
            armed = excluded.armed,
            claimed_at_ms = NULL,
            claimed_token = NULL,
            occurrence_open = 0
        `)
        .run(key, lastFiredAtMs, armed ? 1 : 0);
      if (armed) {
        this.cancelAppNotificationsForAlert(key, nowMs);
        const prefix = `threshold:${key}:`;
        this.storage.db
          .query(`
            DELETE FROM alert_channel_delivery
            WHERE delivery_key = ? OR substr(delivery_key, 1, ?) = ?
          `)
          .run(`threshold:${key}`, prefix.length, prefix);
      }
    });
  }

  claim(key: string, nowMs: number, cooldownMs: number, leaseMs = 5 * 60_000): AlertClaim | null {
    const token = randomUUID();
    const row = this.storage.db
      .query<{ key: string; generation: number }, [string, number, string, number, number]>(`
        INSERT INTO alert_state(
          key, last_fired_at_ms, armed, claimed_at_ms, claimed_token, generation, occurrence_open
        ) VALUES (?, 0, 0, ?, ?, 1, 1)
        ON CONFLICT(key) DO UPDATE SET
          armed = 0,
          claimed_at_ms = excluded.claimed_at_ms,
          claimed_token = excluded.claimed_token,
          generation = CASE
            WHEN alert_state.occurrence_open = 0 THEN alert_state.generation + 1
            ELSE alert_state.generation
          END,
          occurrence_open = 1
        WHERE (
          alert_state.armed = 1
          OR (
            alert_state.armed = 0
            AND alert_state.claimed_at_ms IS NOT NULL
            AND excluded.claimed_at_ms - alert_state.claimed_at_ms >= ?
          )
        ) AND excluded.claimed_at_ms - alert_state.last_fired_at_ms >= ?
        RETURNING key, generation
      `)
      .get(key, nowMs, token, leaseMs, cooldownMs);
    return row ? { token, generation: row.generation } : null;
  }

  completeClaim(key: string, token: string, nowMs: number, disposition: "delivered" | "suppressed" = "delivered"): boolean {
    const result = this.storage.db
      .query(`
        UPDATE alert_state SET
          last_fired_at_ms = CASE WHEN ? = 'delivered' THEN ? ELSE last_fired_at_ms END,
          armed = 0, claimed_at_ms = NULL, claimed_token = NULL
        WHERE key = ? AND claimed_token = ?
      `)
      .run(disposition, nowMs, key, token);
    return result.changes > 0;
  }

  releaseClaim(key: string, token: string): boolean {
    const result = this.storage.db
      .query(`
        UPDATE alert_state SET armed = 1, claimed_at_ms = NULL, claimed_token = NULL
        WHERE key = ? AND claimed_token = ?
      `)
      .run(key, token);
    return result.changes > 0;
  }

  claimEvent(
    eventId: number,
    categoryKey: string,
    nowMs: number,
    cooldownMs: number,
    leaseMs = 5 * 60_000,
  ): string | null {
    return this.storage.transaction(() => {
      const eventExists = this.storage.db.query<{ id: number }, [number]>("SELECT id FROM events WHERE id = ?").get(eventId);
      if (!eventExists) return null;
      const delivery = this.storage.db
        .query<{
          claimed_at_ms: number | null;
          claimed_token: string | null;
          delivered_at_ms: number | null;
        }, [number]>(`
          SELECT claimed_at_ms, claimed_token, delivered_at_ms FROM event_delivery WHERE event_id = ?
        `)
        .get(eventId);
      if (delivery?.delivered_at_ms != null) return null;
      if (delivery?.claimed_at_ms != null && nowMs - delivery.claimed_at_ms < leaseMs) return null;

      const category = this.storage.db
        .query<{
          last_fired_at_ms: number;
          claimed_at_ms: number | null;
        }, [string]>(`
          SELECT last_fired_at_ms, claimed_at_ms FROM alert_state WHERE key = ?
        `)
        .get(categoryKey);
      if (category?.claimed_at_ms != null && nowMs - category.claimed_at_ms < leaseMs) return null;
      if (
        category &&
        category.last_fired_at_ms > 0 &&
        nowMs - category.last_fired_at_ms < cooldownMs
      ) {
        this.storage.db
          .query(`
            INSERT INTO event_delivery(
              event_id, claimed_at_ms, claimed_token, delivered_at_ms, disposition, attempts
            ) VALUES (?, NULL, NULL, ?, 'coalesced', 0)
            ON CONFLICT(event_id) DO UPDATE SET
              claimed_at_ms = NULL,
              claimed_token = NULL,
              delivered_at_ms = excluded.delivered_at_ms,
              disposition = excluded.disposition
          `)
          .run(eventId, nowMs);
        return null;
      }

      const token = randomUUID();
      this.storage.db
        .query(`
          INSERT INTO alert_state(key, last_fired_at_ms, armed, claimed_at_ms, claimed_token)
          VALUES (?, 0, 1, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            claimed_at_ms = excluded.claimed_at_ms,
            claimed_token = excluded.claimed_token
        `)
        .run(categoryKey, nowMs, token);
      this.storage.db
        .query(`
          INSERT INTO event_delivery(
            event_id, claimed_at_ms, claimed_token, delivered_at_ms, disposition, attempts
          ) VALUES (?, ?, ?, NULL, NULL, 1)
          ON CONFLICT(event_id) DO UPDATE SET
            claimed_at_ms = excluded.claimed_at_ms,
            claimed_token = excluded.claimed_token,
            delivered_at_ms = NULL,
            disposition = NULL,
            attempts = event_delivery.attempts + 1
        `)
        .run(eventId, nowMs, token);
      return token;
    });
  }

  completeEvent(eventId: number, categoryKey: string, token: string, nowMs: number,
    disposition: "delivered" | "suppressed" = "delivered"): boolean {
    return this.storage.transaction(() => {
      const ownsEvent = this.storage.db
        .query<{ event_id: number }, [number, string]>(`
          SELECT event_id FROM event_delivery WHERE event_id = ? AND claimed_token = ?
        `)
        .get(eventId, token);
      const ownsCategory = this.storage.db
        .query<{ key: string }, [string, string]>(`
          SELECT key FROM alert_state WHERE key = ? AND claimed_token = ?
        `)
        .get(categoryKey, token);
      if (!ownsEvent || !ownsCategory) return false;
      this.storage.db
        .query(`
          UPDATE event_delivery
          SET claimed_at_ms = NULL, claimed_token = NULL,
              delivered_at_ms = ?, disposition = ?
          WHERE event_id = ? AND claimed_token = ?
        `)
        .run(nowMs, disposition, eventId, token);
      // Muted occurrences are consumed, but only a delivery starts a cooldown.
      // Preserve a prior real delivery rather than clearing its cooldown.
      this.storage.db
        .query(`
          UPDATE alert_state SET
            last_fired_at_ms = CASE WHEN ? = 'delivered' THEN ? ELSE last_fired_at_ms END, armed = 1,
            claimed_at_ms = NULL, claimed_token = NULL
          WHERE key = ? AND claimed_token = ?
        `)
        .run(disposition, nowMs, categoryKey, token);
      return true;
    });
  }

  releaseEvent(eventId: number, categoryKey: string, token: string): boolean {
    return this.storage.transaction(() => {
      const result = this.storage.db
        .query(`
          UPDATE event_delivery SET claimed_at_ms = NULL, claimed_token = NULL
          WHERE event_id = ? AND delivered_at_ms IS NULL AND claimed_token = ?
        `)
        .run(eventId, token);
      this.storage.db
        .query(`
          UPDATE alert_state SET claimed_at_ms = NULL, claimed_token = NULL
          WHERE key = ? AND claimed_token = ?
        `)
        .run(categoryKey, token);
      return result.changes > 0;
    });
  }

  setNativeNotificationConsumer(available: boolean, nowMs = Date.now()): void {
    this.storage.db
      .query(`
        INSERT INTO app_notification_capability(singleton, native_consumer, updated_at_ms)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          native_consumer = excluded.native_consumer,
          updated_at_ms = excluded.updated_at_ms
      `)
      .run(available ? 1 : 0, nowMs);
  }

  hasNativeNotificationConsumer(): boolean {
    // This is intentionally a migration capability, not a liveness heartbeat.
    // Falling back to osascript after the user denied QuotaPie permission would
    // bypass that choice under a different sender. Once proven, native delivery
    // therefore stays durable and waits for the app instead of silently
    // changing identity when the app is temporarily absent.
    const row = this.storage.db
      .query<{ native_consumer: number }, []>(`
        SELECT native_consumer FROM app_notification_capability WHERE singleton = 1
      `)
      .get();
    return row?.native_consumer === 1;
  }

  queueMacOSNotification(
    decision: TriggerDecision,
    deliveryKey: string,
    nowMs = Date.now(),
    expiresAtMs = nowMs + APP_NOTIFICATION_DEFAULT_TTL_MS,
  ): AppNotification {
    return this.storage.transaction(() => {
      const id = randomUUID();
      this.storage.db
        .query(`
          INSERT OR IGNORE INTO app_notification_outbox(
            id, delivery_key, alert_key, title, message,
            title_key, title_params_json, message_key, message_params_json, severity,
            created_at_ms, expires_at_ms, claimed_at_ms, claimed_token,
            completed_at_ms, disposition
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
        `)
        .run(
          id,
          deliveryKey,
          decision.key,
          decision.title,
          decision.message,
          decision.presentation?.title.key ?? null,
          decision.presentation ? JSON.stringify(decision.presentation.title.params) : null,
          decision.presentation?.message.key ?? null,
          decision.presentation ? JSON.stringify(decision.presentation.message.params) : null,
          decision.severity,
          nowMs,
          expiresAtMs,
        );
      const row = this.storage.db
        .query<AppNotificationRow, [string]>(`
          SELECT id, delivery_key, alert_key, title, message,
                 title_key, title_params_json, message_key, message_params_json, severity,
                 created_at_ms, expires_at_ms
          FROM app_notification_outbox WHERE delivery_key = ?
        `)
        .get(deliveryKey);
      if (!row) throw new Error(`Failed to queue native notification: ${deliveryKey}`);

      // The durable enqueue is the macOS delivery. Keeping this write in the
      // same transaction prevents a crash from leaving either a duplicate
      // notification or a channel success with no native work to consume.
      this.markChannelDelivered(deliveryKey, MACOS_NOTIFICATION_CHANNEL, nowMs);
      return appNotificationFromRow(row);
    });
  }

  claimNextAppNotification(
    nowMs = Date.now(),
    leaseMs = 5 * 60_000,
  ): AppNotificationClaim | null {
    return this.storage.transaction(() => {
      // Calling the native endpoint is itself proof that this installation can
      // consume the outbox, even when there is currently nothing to claim.
      this.setNativeNotificationConsumer(true, nowMs);
      this.storage.db
        .query(`
          UPDATE app_notification_outbox SET
            completed_at_ms = ?, disposition = 'expired'
          WHERE completed_at_ms IS NULL AND expires_at_ms <= ?
        `)
        .run(nowMs, nowMs);

      const token = randomUUID();
      const row = this.storage.db
        .query<AppNotificationClaimRow, [number, string, number, number, number]>(`
          UPDATE app_notification_outbox SET
            claimed_at_ms = ?, claimed_token = ?
          WHERE id = (
            SELECT id FROM app_notification_outbox
            WHERE completed_at_ms IS NULL
              AND expires_at_ms > ?
              AND (
                claimed_at_ms IS NULL
                OR ? - claimed_at_ms >= ?
              )
            ORDER BY created_at_ms ASC, id ASC
            LIMIT 1
          )
          RETURNING id, delivery_key, alert_key, title, message,
                    title_key, title_params_json, message_key, message_params_json, severity,
                    created_at_ms, expires_at_ms, claimed_at_ms, claimed_token
        `)
        .get(nowMs, token, nowMs, nowMs, Math.max(0, leaseMs));
      return row ? appNotificationClaimFromRow(row) : null;
    });
  }

  completeAppNotification(
    id: string,
    claimToken: string,
    disposition: AppNotificationDisposition,
    nowMs = Date.now(),
  ): boolean {
    const result = this.storage.db
      .query(`
        UPDATE app_notification_outbox SET
          completed_at_ms = ?, disposition = ?
        WHERE id = ? AND claimed_token = ? AND completed_at_ms IS NULL
      `)
      .run(nowMs, disposition, id, claimToken);
    if (result.changes > 0) return true;

    // The app can lose the HTTP response after scheduling a notification. A
    // retry of that same receipt is success, while a stale lease or a changed
    // disposition remains a failed compare-and-swap.
    const completed = this.storage.db
      .query<{ claimed_token: string | null; disposition: string | null }, [string]>(`
        SELECT claimed_token, disposition FROM app_notification_outbox WHERE id = ?
      `)
      .get(id);
    return completed?.claimed_token === claimToken && completed.disposition === disposition;
  }

  releaseAppNotification(id: string, claimToken: string): boolean {
    const result = this.storage.db
      .query(`
        UPDATE app_notification_outbox SET claimed_at_ms = NULL, claimed_token = NULL
        WHERE id = ? AND claimed_token = ? AND completed_at_ms IS NULL
      `)
      .run(id, claimToken);
    return result.changes > 0;
  }

  renewAppNotification(id: string, claimToken: string, nowMs = Date.now()): boolean {
    const result = this.storage.db
      .query(`
        UPDATE app_notification_outbox SET claimed_at_ms = ?
        WHERE id = ? AND claimed_token = ? AND completed_at_ms IS NULL
      `)
      .run(nowMs, id, claimToken);
    return result.changes > 0;
  }

  cancelAppNotificationsForAlert(alertKey: string, nowMs = Date.now()): number {
    const result = this.storage.db
      .query(`
        UPDATE app_notification_outbox SET
          completed_at_ms = ?, disposition = 'cancelled'
        WHERE alert_key = ? AND completed_at_ms IS NULL
      `)
      .run(nowMs, alertKey);
    return result.changes;
  }

  cancelAppNotificationsWhere(predicate: (item: AppNotification) => boolean, nowMs = Date.now()): void {
    const rows = this.storage.db.query<AppNotificationRow, []>(`
      SELECT * FROM app_notification_outbox WHERE completed_at_ms IS NULL
    `).all();
    const cancel = this.storage.db.query(`UPDATE app_notification_outbox
      SET completed_at_ms = ?, disposition = 'cancelled' WHERE id = ? AND completed_at_ms IS NULL`);
    this.storage.transaction(() => {
      for (const row of rows) if (predicate(appNotificationFromRow(row))) cancel.run(nowMs, row.id);
    });
  }

  cancelAllAppNotifications(nowMs = Date.now()): number {
    const result = this.storage.db
      .query(`
        UPDATE app_notification_outbox SET
          completed_at_ms = ?, disposition = 'cancelled'
        WHERE completed_at_ms IS NULL
      `)
      .run(nowMs);
    return result.changes;
  }

  pendingAppNotifications(limit = 100): AppNotification[] {
    const boundedLimit = Math.max(0, Math.min(500, Math.trunc(limit)));
    return this.storage.db
      .query<AppNotificationRow, [number]>(`
        SELECT id, delivery_key, alert_key, title, message,
               title_key, title_params_json, message_key, message_params_json, severity,
               created_at_ms, expires_at_ms
        FROM app_notification_outbox
        WHERE completed_at_ms IS NULL
        ORDER BY created_at_ms ASC, id ASC
        LIMIT ?
      `)
      .all(boundedLimit)
      .map(appNotificationFromRow);
  }

  deliveredChannels(deliveryKey: string): string[] {
    return this.storage.db
      .query<{ channel: string }, [string]>(`
        SELECT channel FROM alert_channel_delivery WHERE delivery_key = ?
      `)
      .all(deliveryKey)
      .map((row) => row.channel);
  }

  markChannelDelivered(deliveryKey: string, channel: string, nowMs: number): void {
    this.storage.db
      .query(`
        INSERT INTO alert_channel_delivery(delivery_key, channel, delivered_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(delivery_key, channel) DO UPDATE SET
          delivered_at_ms = excluded.delivered_at_ms
      `)
      .run(deliveryKey, channel, nowMs);
  }
}
