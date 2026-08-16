import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { classifyDelta } from "./classify";
import type { AppConfig } from "./config";
import { dataDirectory } from "./config";
import type { CollectionStateRow, Provider, QuotaEvent, QuotaObservation } from "./types";

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

export class QuotaDatabase {
  readonly db: Database;
  private readonly storagePath: string;

  constructor(path = resolve(dataDirectory(), "timequota.sqlite3")) {
    this.storagePath = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.migrate();
    this.secureStorageFiles();
  }

  private secureStorageFiles(): void {
    if (this.storagePath === ":memory:") return;
    chmodSync(dirname(this.storagePath), 0o700);
    for (const path of [
      this.storagePath,
      `${this.storagePath}-wal`,
      `${this.storagePath}-shm`,
      resolve(dirname(this.storagePath), "service.log"),
      resolve(dirname(this.storagePath), "service.error.log"),
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.run("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.run("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        // Preserve the original SQLite error.
      }
      throw error;
    }
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        bucket TEXT NOT NULL,
        label TEXT NOT NULL,
        window_seconds INTEGER,
        used_percent REAL,
        resets_at_ms INTEGER,
        observed_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL,
        credit_balance REAL,
        reset_credits_available INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(provider, account, bucket, observed_at_ms, source)
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS snapshots_lookup
      ON snapshots(provider, account, bucket, observed_at_ms DESC)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bucket_state (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        bucket TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        last_seen_ms INTEGER NOT NULL,
        missing_full_reads INTEGER NOT NULL DEFAULT 0,
        retired_at_ms INTEGER,
        PRIMARY KEY(provider, account, bucket)
      )
    `);
    const bucketColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(bucket_state)")
      .all();
    if (!bucketColumns.some((column) => column.name === "retired_at_ms")) {
      this.db.run("ALTER TABLE bucket_state ADD COLUMN retired_at_ms INTEGER");
    }
    this.db.run(`
      INSERT OR IGNORE INTO bucket_state(provider, account, bucket, active, last_seen_ms, missing_full_reads)
      SELECT provider, account, bucket, 1, MAX(observed_at_ms), 0
      FROM snapshots GROUP BY provider, account, bucket
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS provider_sync_state (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        last_full_read_ms INTEGER NOT NULL,
        PRIMARY KEY(provider, account)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS collection_state (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        last_attempt_ms INTEGER,
        last_success_ms INTEGER,
        last_error TEXT,
        PRIMARY KEY(provider, account)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        bucket TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        confidence TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_state (
        key TEXT PRIMARY KEY,
        last_fired_at_ms INTEGER NOT NULL,
        armed INTEGER NOT NULL DEFAULT 0,
        claimed_at_ms INTEGER,
        claimed_token TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        occurrence_open INTEGER NOT NULL DEFAULT 0
      )
    `);
    const alertColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(alert_state)")
      .all();
    if (!alertColumns.some((column) => column.name === "claimed_at_ms")) {
      this.db.run("ALTER TABLE alert_state ADD COLUMN claimed_at_ms INTEGER");
    }
    if (!alertColumns.some((column) => column.name === "claimed_token")) {
      this.db.run("ALTER TABLE alert_state ADD COLUMN claimed_token TEXT");
    }
    if (!alertColumns.some((column) => column.name === "generation")) {
      this.db.run("ALTER TABLE alert_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    }
    if (!alertColumns.some((column) => column.name === "occurrence_open")) {
      this.db.run("ALTER TABLE alert_state ADD COLUMN occurrence_open INTEGER NOT NULL DEFAULT 0");
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS event_delivery (
        event_id INTEGER PRIMARY KEY,
        claimed_at_ms INTEGER,
        claimed_token TEXT,
        delivered_at_ms INTEGER,
        disposition TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      )
    `);
    const deliveryColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(event_delivery)")
      .all();
    if (!deliveryColumns.some((column) => column.name === "claimed_token")) {
      this.db.run("ALTER TABLE event_delivery ADD COLUMN claimed_token TEXT");
    }
    this.transaction(() => {
      const initialized = this.db
        .query<{ name: string }, [string]>("SELECT name FROM schema_migrations WHERE name = ?")
        .get("event_delivery_v1");
      if (initialized) return;
      this.db.run(`
        INSERT OR IGNORE INTO event_delivery(
          event_id, claimed_at_ms, claimed_token, delivered_at_ms, disposition, attempts
        )
        SELECT id, NULL, NULL, occurred_at_ms, 'preexisting', 0 FROM events
      `);
      this.db
        .query("INSERT INTO schema_migrations(name, applied_at_ms) VALUES (?, ?)")
        .run("event_delivery_v1", Date.now());
    });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_channel_delivery (
        delivery_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        delivered_at_ms INTEGER NOT NULL,
        PRIMARY KEY(delivery_key, channel)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS claude_session_state (
        account TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        bucket TEXT NOT NULL,
        label TEXT NOT NULL,
        window_seconds INTEGER,
        used_percent REAL,
        resets_at_ms INTEGER,
        observed_at_ms INTEGER NOT NULL,
        value_changed_at_ms INTEGER NOT NULL,
        PRIMARY KEY(account, session_hash, bucket)
      )
    `);
    const claudeColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(claude_session_state)")
      .all();
    if (!claudeColumns.some((column) => column.name === "value_changed_at_ms")) {
      this.db.run("ALTER TABLE claude_session_state ADD COLUMN value_changed_at_ms INTEGER");
    }
    this.db.run("UPDATE claude_session_state SET value_changed_at_ms = observed_at_ms WHERE value_changed_at_ms IS NULL");
    this.db.run(`
      CREATE INDEX IF NOT EXISTS claude_session_recent
      ON claude_session_state(observed_at_ms DESC)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS maintenance_state (
        key TEXT PRIMARY KEY,
        value_ms INTEGER NOT NULL
      )
    `);
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

  recordCollectionAttempt(provider: Provider, account: string, atMs: number, error: string | null): void {
    this.db
      .query(`
        INSERT INTO collection_state(provider, account, last_attempt_ms, last_success_ms, last_error)
        VALUES (?1, ?2, ?3, CASE WHEN ?4 IS NULL THEN ?3 ELSE NULL END, ?4)
        ON CONFLICT(provider, account) DO UPDATE SET
          last_attempt_ms = ?3,
          last_success_ms = CASE WHEN ?4 IS NULL THEN ?3 ELSE collection_state.last_success_ms END,
          last_error = ?4
      `)
      .run(provider, account, atMs, error);
  }

  collectionStates(): CollectionStateRow[] {
    return this.db
      .query<{
        provider: Provider;
        account: string;
        last_attempt_ms: number | null;
        last_success_ms: number | null;
        last_error: string | null;
      }, []>("SELECT provider, account, last_attempt_ms, last_success_ms, last_error FROM collection_state")
      .all()
      .map((row) => ({
        provider: row.provider,
        account: row.account,
        lastAttemptMs: row.last_attempt_ms,
        lastSuccessMs: row.last_success_ms,
        lastError: row.last_error,
      }));
  }

  upsertClaudeSessions(observations: QuotaObservation[], ttlMs: number): QuotaObservation[] {
    const valid = observations.filter(
      (observation) =>
        observation.provider === "claude" &&
        typeof observation.metadata?.sessionHash === "string",
    );
    if (!valid.length) return [];
    const referenceMs = Math.max(...valid.map((observation) => observation.observedAtMs));
    const affected = new Set(valid.map((observation) => `${observation.account}\u0000${observation.bucket}`));
    return this.transaction(() => {
      for (const observation of valid) {
        this.db
          .query(`
            INSERT INTO claude_session_state(
              account, session_hash, bucket, label, window_seconds,
              used_percent, resets_at_ms, observed_at_ms, value_changed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account, session_hash, bucket) DO UPDATE SET
              label = excluded.label,
              window_seconds = excluded.window_seconds,
              value_changed_at_ms = CASE
                WHEN excluded.resets_at_ms IS NOT claude_session_state.resets_at_ms
                THEN excluded.observed_at_ms
                ELSE claude_session_state.value_changed_at_ms
              END,
              used_percent = excluded.used_percent,
              resets_at_ms = excluded.resets_at_ms,
              observed_at_ms = excluded.observed_at_ms
            WHERE excluded.observed_at_ms >= claude_session_state.observed_at_ms
          `)
          .run(
            observation.account,
            String(observation.metadata?.sessionHash),
            observation.bucket,
            observation.label,
            observation.windowSeconds,
            observation.usedPercent,
            observation.resetsAtMs,
            observation.observedAtMs,
            observation.observedAtMs,
          );
      }

      const active = this.db
        .query<ClaudeSessionRow, [number]>(`
          SELECT account, session_hash, bucket, label, window_seconds,
                 used_percent, resets_at_ms, observed_at_ms, value_changed_at_ms
          FROM claude_session_state WHERE observed_at_ms >= ?
        `)
        .all(referenceMs - ttlMs);
      const consensus: QuotaObservation[] = [];
      for (const key of affected) {
        const [account = "default", bucket = "unknown"] = key.split("\u0000");
        const candidates = active.filter((row) => row.account === account && row.bucket === bucket);
        if (!candidates.length) continue;
        const resetCandidates = candidates.some((row) => row.resets_at_ms != null)
          ? candidates.filter((row) => row.resets_at_ms != null)
          : candidates;
        const resetLeader = [...resetCandidates].sort(
          (a, b) => b.value_changed_at_ms - a.value_changed_at_ms || b.observed_at_ms - a.observed_at_ms,
        )[0];
        if (!resetLeader) continue;
        const targetReset = resetLeader.resets_at_ms;
        const matchingReset = targetReset == null
          ? candidates
          : candidates.filter(
              (row) => row.resets_at_ms != null && Math.abs(row.resets_at_ms - targetReset) <= 2 * 60_000,
            );
        const pool = matchingReset.length ? matchingReset : candidates;
        const template = [...pool].sort((a, b) => b.observed_at_ms - a.observed_at_ms)[0];
        if (!template) continue;
        const usedValues = pool
          .map((row) => row.used_percent)
          .filter((value): value is number => value != null);
        consensus.push({
          provider: "claude",
          account,
          bucket,
          label: template.label,
          windowSeconds: template.window_seconds,
          usedPercent: usedValues.length ? Math.max(...usedValues) : null,
          resetsAtMs: targetReset,
          observedAtMs: Math.max(...pool.map((row) => row.observed_at_ms)),
          source: "claude-statusline-consensus",
          quality: "derived",
          metadata: {
            activeSessions: new Set(pool.map((row) => row.session_hash)).size,
            consensusTtlSeconds: Math.round(ttlMs / 1_000),
            conflictingResetWindows: new Set(
              candidates.map((row) => row.resets_at_ms == null ? "unknown" : Math.round(row.resets_at_ms / 120_000)),
            ).size,
          },
        });
      }
      return consensus;
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

  pendingAlertEvents(limit = 500): QuotaEvent[] {
    const rows = this.db
      .query<EventRow, [number]>(`
        SELECT e.id, e.provider, e.account, e.bucket, e.kind, e.severity,
               e.occurred_at_ms, e.confidence, e.summary, e.details_json
        FROM events e
        LEFT JOIN event_delivery d ON d.event_id = e.id
        WHERE d.delivered_at_ms IS NULL
          AND e.kind IN ('external_relief', 'allowance_relief', 'schedule_rebased', 'paid_usage', 'credit_topup')
        ORDER BY e.id ASC LIMIT ?
      `)
      .all(limit);
    return rows.map(eventFromRow);
  }

  alertState(key: string): { lastFiredAtMs: number; armed: boolean } | null {
    const row = this.db
      .query<{ last_fired_at_ms: number; armed: number }, [string]>(
        "SELECT last_fired_at_ms, armed FROM alert_state WHERE key = ?",
      )
      .get(key);
    return row ? { lastFiredAtMs: row.last_fired_at_ms, armed: row.armed === 1 } : null;
  }

  setAlertState(key: string, lastFiredAtMs: number, armed: boolean): void {
    this.db
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
      this.db
        .query(`
          DELETE FROM alert_channel_delivery
          WHERE delivery_key = ? OR substr(delivery_key, 1, ?) = ?
        `)
        .run(`threshold:${key}`, prefix.length, prefix);
    }
  }

  claimAlert(key: string, nowMs: number, cooldownMs: number, leaseMs = 5 * 60_000): AlertClaim | null {
    const token = randomUUID();
    const row = this.db
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

  completeAlertClaim(key: string, token: string, nowMs: number): boolean {
    const result = this.db
      .query(`
        UPDATE alert_state SET
          last_fired_at_ms = ?, armed = 0, claimed_at_ms = NULL, claimed_token = NULL
        WHERE key = ? AND claimed_token = ?
      `)
      .run(nowMs, key, token);
    return result.changes > 0;
  }

  releaseAlertClaim(key: string, token: string): boolean {
    const result = this.db
      .query(`
        UPDATE alert_state SET armed = 1, claimed_at_ms = NULL, claimed_token = NULL
        WHERE key = ? AND claimed_token = ?
      `)
      .run(key, token);
    return result.changes > 0;
  }

  claimEventAlert(
    eventId: number,
    categoryKey: string,
    nowMs: number,
    cooldownMs: number,
    leaseMs = 5 * 60_000,
  ): string | null {
    return this.transaction(() => {
      const eventExists = this.db.query<{ id: number }, [number]>("SELECT id FROM events WHERE id = ?").get(eventId);
      if (!eventExists) return null;
      const delivery = this.db
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

      const category = this.db
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
        this.db
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
      this.db
        .query(`
          INSERT INTO alert_state(key, last_fired_at_ms, armed, claimed_at_ms, claimed_token)
          VALUES (?, 0, 1, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            claimed_at_ms = excluded.claimed_at_ms,
            claimed_token = excluded.claimed_token
        `)
        .run(categoryKey, nowMs, token);
      this.db
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

  completeEventAlert(eventId: number, categoryKey: string, token: string, nowMs: number): boolean {
    return this.transaction(() => {
      const ownsEvent = this.db
        .query<{ event_id: number }, [number, string]>(`
          SELECT event_id FROM event_delivery WHERE event_id = ? AND claimed_token = ?
        `)
        .get(eventId, token);
      const ownsCategory = this.db
        .query<{ key: string }, [string, string]>(`
          SELECT key FROM alert_state WHERE key = ? AND claimed_token = ?
        `)
        .get(categoryKey, token);
      if (!ownsEvent || !ownsCategory) return false;
      this.db
        .query(`
          UPDATE event_delivery
          SET claimed_at_ms = NULL, claimed_token = NULL,
              delivered_at_ms = ?, disposition = 'delivered'
          WHERE event_id = ? AND claimed_token = ?
        `)
        .run(nowMs, eventId, token);
      this.db
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

  releaseEventAlert(eventId: number, categoryKey: string, token: string): boolean {
    return this.transaction(() => {
      const result = this.db
        .query(`
          UPDATE event_delivery SET claimed_at_ms = NULL, claimed_token = NULL
          WHERE event_id = ? AND delivered_at_ms IS NULL AND claimed_token = ?
        `)
        .run(eventId, token);
      this.db
        .query(`
          UPDATE alert_state SET claimed_at_ms = NULL, claimed_token = NULL
          WHERE key = ? AND claimed_token = ?
        `)
        .run(categoryKey, token);
      return result.changes > 0;
    });
  }

  deliveredChannels(deliveryKey: string): string[] {
    return this.db
      .query<{ channel: string }, [string]>(`
        SELECT channel FROM alert_channel_delivery WHERE delivery_key = ?
      `)
      .all(deliveryKey)
      .map((row) => row.channel);
  }

  markChannelDelivered(deliveryKey: string, channel: string, nowMs: number): void {
    this.db
      .query(`
        INSERT INTO alert_channel_delivery(delivery_key, channel, delivered_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(delivery_key, channel) DO UPDATE SET
          delivered_at_ms = excluded.delivered_at_ms
      `)
      .run(deliveryKey, channel, nowMs);
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
    this.secureStorageFiles();
    return true;
  }

  close(): void {
    this.secureStorageFiles();
    this.db.close();
    this.secureStorageFiles();
  }
}
