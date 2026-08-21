import type { Database } from "bun:sqlite";

/// The single owner of the schema.
///
/// Every table lives here, including ones no runtime repository exposes any
/// more: an old shape that only exists so an existing database keeps opening is
/// a migration concern, not an API. Stores below assume this has already run.
/// Migrations run before QuotaStorage exists, so they carry their own minimal
/// transaction helper rather than reaching back into it.
function inTransaction(db: Database, work: () => void): void {
  db.run("BEGIN IMMEDIATE");
  try {
    work();
    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original SQLite error.
    }
    throw error;
  }
}

export function migrate(db: Database): void {
    db.run(`
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
    db.run(`
      CREATE INDEX IF NOT EXISTS snapshots_lookup
      ON snapshots(provider, account, bucket, observed_at_ms DESC)
    `);
    db.run(`
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
    const bucketColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(bucket_state)")
      .all();
    if (!bucketColumns.some((column) => column.name === "retired_at_ms")) {
      db.run("ALTER TABLE bucket_state ADD COLUMN retired_at_ms INTEGER");
    }
    db.run(`
      INSERT OR IGNORE INTO bucket_state(provider, account, bucket, active, last_seen_ms, missing_full_reads)
      SELECT provider, account, bucket, 1, MAX(observed_at_ms), 0
      FROM snapshots GROUP BY provider, account, bucket
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS provider_sync_state (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        last_full_read_ms INTEGER NOT NULL,
        PRIMARY KEY(provider, account)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS collection_state (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        last_attempt_ms INTEGER,
        last_success_ms INTEGER,
        last_error TEXT,
        PRIMARY KEY(provider, account)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS collection_source_state (
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        source TEXT NOT NULL,
        last_attempt_ms INTEGER,
        last_success_ms INTEGER,
        last_error TEXT,
        last_error_category TEXT,
        PRIMARY KEY(provider, account, source)
      )
    `);
    // Move history that was only recorded per account onto per-source rows.
    // The original source is unknowable, so attribute it to the provider's
    // primary source name.
    db.run(`
      INSERT OR IGNORE INTO collection_source_state(
        provider, account, source, last_attempt_ms, last_success_ms, last_error, last_error_category
      )
      SELECT provider, account,
             CASE provider WHEN 'codex' THEN 'codex-appserver' ELSE 'claude-statusline' END,
             last_attempt_ms, last_success_ms, last_error, NULL
      FROM collection_state
    `);
    db.run(`
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
    db.run(`
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
    const alertColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(alert_state)")
      .all();
    if (!alertColumns.some((column) => column.name === "claimed_at_ms")) {
      db.run("ALTER TABLE alert_state ADD COLUMN claimed_at_ms INTEGER");
    }
    if (!alertColumns.some((column) => column.name === "claimed_token")) {
      db.run("ALTER TABLE alert_state ADD COLUMN claimed_token TEXT");
    }
    if (!alertColumns.some((column) => column.name === "generation")) {
      db.run("ALTER TABLE alert_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    }
    if (!alertColumns.some((column) => column.name === "occurrence_open")) {
      db.run("ALTER TABLE alert_state ADD COLUMN occurrence_open INTEGER NOT NULL DEFAULT 0");
    }
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS event_delivery (
        event_id INTEGER PRIMARY KEY,
        claimed_at_ms INTEGER,
        claimed_token TEXT,
        delivered_at_ms INTEGER,
        disposition TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      )
    `);
    const deliveryColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(event_delivery)")
      .all();
    if (!deliveryColumns.some((column) => column.name === "claimed_token")) {
      db.run("ALTER TABLE event_delivery ADD COLUMN claimed_token TEXT");
    }
    inTransaction(db, () => {
      const initialized = db
        .query<{ name: string }, [string]>("SELECT name FROM schema_migrations WHERE name = ?")
        .get("event_delivery_v1");
      if (initialized) return;
      db.run(`
        INSERT OR IGNORE INTO event_delivery(
          event_id, claimed_at_ms, claimed_token, delivered_at_ms, disposition, attempts
        )
        SELECT id, NULL, NULL, occurred_at_ms, 'preexisting', 0 FROM events
      `);
      db
        .query("INSERT INTO schema_migrations(name, applied_at_ms) VALUES (?, ?)")
        .run("event_delivery_v1", Date.now());
    });
    db.run(`
      CREATE TABLE IF NOT EXISTS alert_channel_delivery (
        delivery_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        delivered_at_ms INTEGER NOT NULL,
        PRIMARY KEY(delivery_key, channel)
      )
    `);
    db.run(`
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
    const claudeColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(claude_session_state)")
      .all();
    if (!claudeColumns.some((column) => column.name === "value_changed_at_ms")) {
      db.run("ALTER TABLE claude_session_state ADD COLUMN value_changed_at_ms INTEGER");
    }
    db.run("UPDATE claude_session_state SET value_changed_at_ms = observed_at_ms WHERE value_changed_at_ms IS NULL");
    db.run(`
      CREATE INDEX IF NOT EXISTS claude_session_recent
      ON claude_session_state(observed_at_ms DESC)
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS maintenance_state (
        key TEXT PRIMARY KEY,
        value_ms INTEGER NOT NULL
      )
    `);
  }
