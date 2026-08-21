import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { classifyDelta } from "./classify";
import { QuotaStorage } from "./storage/database";
import type { AppConfig } from "./config";
import { dataDirectory } from "./config";
import type {
  CollectionErrorCategory,
  CollectionSourceStateRow,
  CollectionStateRow,
  Provider,
  QuotaEvent,
  QuotaObservation,
} from "./types";
import { ALERTABLE_EVENT_KINDS } from "./types";

interface SnapshotRow {
  provider: Provider;
  account: string;
  bucket: string;
  label: string;
  window_seconds: number | null;
  used_percent: number | null;
  resets_at_ms: number | null;
  observed_at_ms: number;
  source: string;
  quality: QuotaObservation["quality"];
  credit_balance: number | null;
  reset_credits_available: number | null;
  metadata_json: string;
}

interface EventRow {
  id: number;
  provider: Provider;
  account: string;
  bucket: string;
  kind: QuotaEvent["kind"];
  severity: QuotaEvent["severity"];
  occurred_at_ms: number;
  confidence: QuotaEvent["confidence"];
  summary: string;
  details_json: string;
}

interface ClaudeSessionRow {
  account: string;
  session_hash: string;
  bucket: string;
  label: string;
  window_seconds: number | null;
  used_percent: number | null;
  resets_at_ms: number | null;
  observed_at_ms: number;
  value_changed_at_ms: number;
}

export interface AlertClaim {
  token: string;
  generation: number;
}

function snapshotFromRow(row: SnapshotRow): QuotaObservation {
  return {
    provider: row.provider,
    account: row.account,
    bucket: row.bucket,
    label: row.label,
    windowSeconds: row.window_seconds,
    usedPercent: row.used_percent,
    resetsAtMs: row.resets_at_ms,
    observedAtMs: row.observed_at_ms,
    source: row.source,
    quality: row.quality,
    creditBalance: row.credit_balance,
    resetCreditsAvailable: row.reset_credits_available,
    metadata: JSON.parse(row.metadata_json || "{}"),
  };
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

/// Snapshot, bucket, and event ingestion.
///
/// classifyDelta, the snapshot insert, the bucket-state update, and the event
/// insert are one unit of work, so they stay together behind one transaction.
/// The alert, collection, and Claude-session subsystems are separate
/// collaborators that share this connection.
export class QuotaDatabase {
  readonly storage: QuotaStorage;

  constructor(pathOrStorage: string | QuotaStorage = resolve(dataDirectory(), "quotapie.sqlite3")) {
    this.storage = typeof pathOrStorage === "string" ? new QuotaStorage(pathOrStorage) : pathOrStorage;
  }

  get db(): Database {
    return this.storage.db;
  }

  private transaction<T>(work: () => T): T {
    return this.storage.transaction(work);
  }

  latest(provider: Provider, account: string, bucket: string): QuotaObservation | null {
    const row = this.db
      .query<SnapshotRow, [Provider, string, string]>(`
        SELECT s.provider, s.account, s.bucket, s.label, s.window_seconds, s.used_percent,
               s.resets_at_ms, s.observed_at_ms, s.source, s.quality, s.credit_balance,
               s.reset_credits_available, s.metadata_json
        FROM snapshots s
        INNER JOIN bucket_state b
          ON b.provider = s.provider AND b.account = s.account AND b.bucket = s.bucket
        WHERE s.provider = ? AND s.account = ? AND s.bucket = ? AND b.active = 1
        ORDER BY s.observed_at_ms DESC, s.id DESC
        LIMIT 1
      `)
      .get(provider, account, bucket);
    return row ? snapshotFromRow(row) : null;
  }

  insertSnapshot(observation: QuotaObservation): boolean {
    const result = this.db
      .query(`
        INSERT OR IGNORE INTO snapshots (
          provider, account, bucket, label, window_seconds, used_percent,
          resets_at_ms, observed_at_ms, source, quality, credit_balance,
          reset_credits_available, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        observation.provider,
        observation.account,
        observation.bucket,
        observation.label,
        observation.windowSeconds,
        observation.usedPercent,
        observation.resetsAtMs,
        observation.observedAtMs,
        observation.source,
        observation.quality,
        observation.creditBalance ?? null,
        observation.resetCreditsAvailable ?? null,
        JSON.stringify(observation.metadata ?? {}),
      );
    if (result.changes > 0) {
      this.db
        .query(`
          INSERT INTO bucket_state(
            provider, account, bucket, active, last_seen_ms, missing_full_reads, retired_at_ms
          ) VALUES (?, ?, ?, 1, ?, 0, NULL)
          ON CONFLICT(provider, account, bucket) DO UPDATE SET
            active = 1,
            last_seen_ms = MAX(bucket_state.last_seen_ms, excluded.last_seen_ms),
            missing_full_reads = 0,
            retired_at_ms = NULL
        `)
        .run(observation.provider, observation.account, observation.bucket, observation.observedAtMs);
    }
    return result.changes > 0;
  }

  ingestObservation(observation: QuotaObservation, config: AppConfig): QuotaEvent[] {
    return this.transaction(() => this.ingestObservationUnlocked(observation, config));
  }

  private ingestObservationUnlocked(observation: QuotaObservation, config: AppConfig): QuotaEvent[] {
    const state = this.db
      .query<{ active: number; retired_at_ms: number | null }, [Provider, string, string]>(`
        SELECT active, retired_at_ms FROM bucket_state
        WHERE provider = ? AND account = ? AND bucket = ?
      `)
      .get(observation.provider, observation.account, observation.bucket);
    if (state?.active === 0 && state.retired_at_ms != null && observation.observedAtMs <= state.retired_at_ms) {
      const stored = this.latestStored(observation.provider, observation.account, observation.bucket);
      if (!stored) return [];
      const events = classifyDelta(
        { ...stored, observedAtMs: state.retired_at_ms },
        observation,
        config,
      );
      return events.filter((value) => this.insertEvent(value));
    }
    const previous = this.latest(observation.provider, observation.account, observation.bucket);
    const events = classifyDelta(previous, observation, config);
    if (previous && observation.observedAtMs < previous.observedAtMs) {
      return events.filter((value) => this.insertEvent(value));
    }
    if (!this.insertSnapshot(observation)) return [];
    return events.filter((value) => this.insertEvent(value));
  }

  private latestStored(provider: Provider, account: string, bucket: string): QuotaObservation | null {
    const row = this.db
      .query<SnapshotRow, [Provider, string, string]>(`
        SELECT provider, account, bucket, label, window_seconds, used_percent,
               resets_at_ms, observed_at_ms, source, quality, credit_balance,
               reset_credits_available, metadata_json
        FROM snapshots
        WHERE provider = ? AND account = ? AND bucket = ?
        ORDER BY observed_at_ms DESC, id DESC LIMIT 1
      `)
      .get(provider, account, bucket);
    return row ? snapshotFromRow(row) : null;
  }

  history(
    provider: Provider,
    account: string,
    bucket: string,
    sinceMs = 0,
    limit = 20_000,
  ): QuotaObservation[] {
    const rows = this.db
      .query<SnapshotRow, [Provider, string, string, number, number]>(`
        SELECT * FROM (
          SELECT provider, account, bucket, label, window_seconds, used_percent,
                 resets_at_ms, observed_at_ms, source, quality, credit_balance,
                 reset_credits_available, metadata_json
          FROM snapshots
          WHERE provider = ? AND account = ? AND bucket = ? AND observed_at_ms >= ?
          ORDER BY observed_at_ms DESC, id DESC
          LIMIT ?
        ) recent
        ORDER BY observed_at_ms ASC
      `)
      .all(provider, account, bucket, sinceMs, limit);
    return rows.map(snapshotFromRow);
  }

  analysisHistory(
    provider: Provider,
    account: string,
    bucket: string,
    sinceMs: number,
    recentRawSinceMs: number,
    olderBucketMs = 15 * 60_000,
  ): QuotaObservation[] {
    const rows = this.db
      .query<
        SnapshotRow,
        [Provider, string, string, number, number, Provider, string, string, number, number, number]
      >(`
        SELECT provider, account, bucket, label, window_seconds, used_percent,
               resets_at_ms, observed_at_ms, source, quality, credit_balance,
               reset_credits_available, metadata_json
        FROM snapshots current
        WHERE provider = ? AND account = ? AND bucket = ? AND observed_at_ms >= ?
          AND (
            observed_at_ms >= ?
            OR id IN (
              SELECT MAX(id)
              FROM snapshots
              WHERE provider = ? AND account = ? AND bucket = ?
                AND observed_at_ms >= ? AND observed_at_ms < ?
              GROUP BY CAST(observed_at_ms / ? AS INTEGER)
            )
          )
        ORDER BY observed_at_ms ASC, id ASC
      `)
      .all(
        provider,
        account,
        bucket,
        sinceMs,
        recentRawSinceMs,
        provider,
        account,
        bucket,
        sinceMs,
        recentRawSinceMs,
        olderBucketMs,
      );
    return rows.map(snapshotFromRow);
  }

  latestAll(): QuotaObservation[] {
    const rows = this.db
      .query<SnapshotRow, []>(`
        SELECT s.provider, s.account, s.bucket, s.label, s.window_seconds,
               s.used_percent, s.resets_at_ms, s.observed_at_ms, s.source,
               s.quality, s.credit_balance, s.reset_credits_available,
               s.metadata_json
        FROM snapshots s
        INNER JOIN bucket_state b
          ON b.provider = s.provider AND b.account = s.account AND b.bucket = s.bucket
        WHERE b.active = 1 AND s.id = (
          SELECT s2.id FROM snapshots s2
          WHERE s2.provider = s.provider AND s2.account = s.account AND s2.bucket = s.bucket
          ORDER BY s2.observed_at_ms DESC, s2.id DESC LIMIT 1
        )
        ORDER BY s.provider, s.window_seconds, s.bucket
      `)
      .all();
    return rows.map(snapshotFromRow);
  }

  private syncActiveBucketsUnlocked(
    provider: Provider,
    account: string,
    currentBuckets: string[],
    observedAtMs: number,
    missesBeforeRetire = 2,
  ): QuotaObservation[] {
    if (!currentBuckets.length) return [];
    const current = new Set(currentBuckets);
    const states = this.db
      .query<{ bucket: string }, [Provider, string]>(`
        SELECT bucket FROM bucket_state WHERE provider = ? AND account = ? AND active = 1
      `)
      .all(provider, account);
    for (const { bucket } of states) {
      if (current.has(bucket)) {
        this.db
          .query(`
            UPDATE bucket_state SET
              missing_full_reads = 0,
              last_seen_ms = MAX(last_seen_ms, ?),
              retired_at_ms = NULL
            WHERE provider = ? AND account = ? AND bucket = ?
          `)
          .run(observedAtMs, provider, account, bucket);
      } else {
        this.db
          .query(`
            UPDATE bucket_state SET missing_full_reads = missing_full_reads + 1
            WHERE provider = ? AND account = ? AND bucket = ? AND active = 1
          `)
          .run(provider, account, bucket);
      }
    }
    const retiring = this.db
      .query<{ bucket: string }, [Provider, string, number]>(`
        SELECT bucket FROM bucket_state
        WHERE provider = ? AND account = ? AND active = 1 AND missing_full_reads >= ?
      `)
      .all(provider, account, missesBeforeRetire);
    const observations = retiring
      .map(({ bucket }) => this.latest(provider, account, bucket))
      .filter((value): value is QuotaObservation => value != null);
    for (const { bucket } of retiring) {
      this.db
        .query(`
          UPDATE bucket_state SET active = 0, retired_at_ms = ?
          WHERE provider = ? AND account = ? AND bucket = ?
        `)
        .run(observedAtMs, provider, account, bucket);
    }
    return observations;
  }

  ingestFullSnapshot(
    provider: Provider,
    account: string,
    observations: QuotaObservation[],
    config: AppConfig,
    missesBeforeRetire = 2,
  ): { accepted: boolean; events: QuotaEvent[]; retired: QuotaObservation[] } {
    const matching = observations.filter(
      (item) => item.provider === provider && item.account === account,
    );
    if (!matching.length) return { accepted: false, events: [], retired: [] };
    const observedAtMs = Math.max(...matching.map((item) => item.observedAtMs));
    const current = matching.filter((item) => item.observedAtMs === observedAtMs);
    return this.transaction(() => {
      const watermark = this.db
        .query<{ last_full_read_ms: number }, [Provider, string]>(`
          SELECT last_full_read_ms FROM provider_sync_state WHERE provider = ? AND account = ?
        `)
        .get(provider, account);
      if (watermark && observedAtMs <= watermark.last_full_read_ms) {
        return { accepted: false, events: [], retired: [] };
      }
      this.db
        .query(`
          INSERT INTO provider_sync_state(provider, account, last_full_read_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(provider, account) DO UPDATE SET last_full_read_ms = excluded.last_full_read_ms
        `)
        .run(provider, account, observedAtMs);
      const events = current.flatMap((observation) => this.ingestObservationUnlocked(observation, config));
      const retired = this.syncActiveBucketsUnlocked(
        provider,
        account,
        current.map((item) => item.bucket),
        observedAtMs,
        missesBeforeRetire,
      );
      return { accepted: true, events, retired };
    });
  }

  insertEvent(value: QuotaEvent): boolean {
    const fingerprint = [
      value.provider,
      value.account,
      value.bucket,
      value.kind,
      value.occurredAtMs,
      JSON.stringify(value.details),
    ].join("|");
    const result = this.db
      .query(`
        INSERT OR IGNORE INTO events (
          fingerprint, provider, account, bucket, kind, severity,
          occurred_at_ms, confidence, summary, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        fingerprint,
        value.provider,
        value.account,
        value.bucket,
        value.kind,
        value.severity,
        value.occurredAtMs,
        value.confidence,
        value.summary,
        JSON.stringify(value.details),
      );
    if (result.changes > 0) value.id = Number(result.lastInsertRowid);
    return result.changes > 0;
  }

  recentEvents(limit = 50): QuotaEvent[] {
    const rows = this.db
      .query<EventRow, [number]>(`
        SELECT id, provider, account, bucket, kind, severity, occurred_at_ms,
               confidence, summary, details_json
        FROM events ORDER BY occurred_at_ms DESC, id DESC LIMIT ?
      `)
      .all(limit);
    return rows.map(eventFromRow);
  }

  maybePrune(nowMs: number, historyDays: number, force = false): boolean {
    const previous = this.db
      .query<{ value_ms: number }, [string]>("SELECT value_ms FROM maintenance_state WHERE key = ?")
      .get("last_prune");
    if (!force && previous && nowMs - previous.value_ms < 6 * 3_600_000) return false;
    const snapshotCutoff = nowMs - Math.max(1, historyDays + 1) * 86_400_000;
    const eventCutoff = nowMs - 180 * 86_400_000;
    const sessionCutoff = nowMs - 7 * 86_400_000;
    this.transaction(() => {
      this.db
        .query(`
          DELETE FROM snapshots
          WHERE observed_at_ms < ?
            AND id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY provider, account, bucket)
        `)
        .run(snapshotCutoff);
      this.db
        .query(`
          DELETE FROM alert_channel_delivery
          WHERE delivery_key IN (
            SELECT 'event:' || id FROM events WHERE occurred_at_ms < ?
          )
        `)
        .run(eventCutoff);
      this.db
        .query("DELETE FROM event_delivery WHERE event_id IN (SELECT id FROM events WHERE occurred_at_ms < ?)")
        .run(eventCutoff);
      this.db.query("DELETE FROM events WHERE occurred_at_ms < ?").run(eventCutoff);
      this.db.query("DELETE FROM claude_session_state WHERE observed_at_ms < ?").run(sessionCutoff);
      this.db
        .query(`
          INSERT INTO maintenance_state(key, value_ms) VALUES ('last_prune', ?)
          ON CONFLICT(key) DO UPDATE SET value_ms = excluded.value_ms
        `)
        .run(nowMs);
    });
    this.db.run("PRAGMA wal_checkpoint(PASSIVE)");
    this.storage.secureFiles();
    return true;
  }

  close(): void {
    this.storage.secureFiles();
    this.db.close();
    this.storage.secureFiles();
  }
}
