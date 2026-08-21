import { randomUUID } from "node:crypto";
import { ALERTABLE_EVENT_KINDS } from "../types";
import type { QuotaEvent } from "../types";
import type { QuotaStorage } from "./database";

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
    summary: row.summary,
    details: JSON.parse(row.details_json || "{}"),
  };
}

/// The alert subsystem as one aggregate.
///
/// alert_state, event_delivery, and alert_channel_delivery implement a single
/// feature — claim, lease, complete, and remember which channels already
/// succeeded — so one owner holds all three. Splitting them by table would put
/// a transaction boundary through the middle of a claim, which is the one place
/// it must not go.
export class AlertStore {
  constructor(private readonly storage: QuotaStorage) {}

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

  setState(key: string, lastFiredAtMs: number, armed: boolean): void {
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
      const prefix = `threshold:${key}:`;
      this.storage.db
        .query(`
          DELETE FROM alert_channel_delivery
          WHERE delivery_key = ? OR substr(delivery_key, 1, ?) = ?
        `)
        .run(`threshold:${key}`, prefix.length, prefix);
    }
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

  completeClaim(key: string, token: string, nowMs: number): boolean {
    const result = this.storage.db
      .query(`
        UPDATE alert_state SET
          last_fired_at_ms = ?, armed = 0, claimed_at_ms = NULL, claimed_token = NULL
        WHERE key = ? AND claimed_token = ?
      `)
      .run(nowMs, key, token);
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

  completeEvent(eventId: number, categoryKey: string, token: string, nowMs: number): boolean {
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
              delivered_at_ms = ?, disposition = 'delivered'
          WHERE event_id = ? AND claimed_token = ?
        `)
        .run(nowMs, eventId, token);
      this.storage.db
        .query(`
          UPDATE alert_state SET
            last_fired_at_ms = ?, armed = 1,
            claimed_at_ms = NULL, claimed_token = NULL
          WHERE key = ? AND claimed_token = ?
        `)
        .run(nowMs, categoryKey, token);
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
