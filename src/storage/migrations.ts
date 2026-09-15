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
    db.run(`CREATE TABLE IF NOT EXISTS model_notification_state (
      scope TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS reset_signals (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, published_ms INTEGER NOT NULL,
      payload TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0)`);
    db.run(`CREATE INDEX IF NOT EXISTS reset_signals_pending ON reset_signals(notified,published_ms)`);
    db.run(`CREATE TABLE IF NOT EXISTS reset_signal_source (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
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
      CREATE TABLE IF NOT EXISTS app_notification_capability (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        native_consumer INTEGER NOT NULL CHECK(native_consumer IN (0, 1)),
        updated_at_ms INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS app_notification_outbox (
        id TEXT PRIMARY KEY,
        delivery_key TEXT NOT NULL UNIQUE,
        alert_key TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        title_key TEXT,
        title_params_json TEXT,
        message_key TEXT,
        message_params_json TEXT,
        severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,
        claimed_token TEXT,
        completed_at_ms INTEGER,
        disposition TEXT CHECK(disposition IN ('scheduled', 'suppressed', 'expired', 'cancelled')),
        CHECK(
          (claimed_at_ms IS NULL AND claimed_token IS NULL)
          OR (claimed_at_ms IS NOT NULL AND claimed_token IS NOT NULL)
        ),
        CHECK(
          (completed_at_ms IS NULL AND disposition IS NULL)
          OR (completed_at_ms IS NOT NULL AND disposition IS NOT NULL)
        )
      )
    `);
    const notificationColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(app_notification_outbox)")
      .all();
    if (!notificationColumns.some((column) => column.name === "title_key")) {
      db.run("ALTER TABLE app_notification_outbox ADD COLUMN title_key TEXT");
    }
    if (!notificationColumns.some((column) => column.name === "title_params_json")) {
      db.run("ALTER TABLE app_notification_outbox ADD COLUMN title_params_json TEXT");
    }
    if (!notificationColumns.some((column) => column.name === "message_key")) {
      db.run("ALTER TABLE app_notification_outbox ADD COLUMN message_key TEXT");
    }
    if (!notificationColumns.some((column) => column.name === "message_params_json")) {
      db.run("ALTER TABLE app_notification_outbox ADD COLUMN message_params_json TEXT");
    }
    db.run(`
      CREATE INDEX IF NOT EXISTS app_notification_pending
      ON app_notification_outbox(completed_at_ms, created_at_ms, id)
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS app_notification_alert
      ON app_notification_outbox(alert_key, completed_at_ms)
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
    db.run(`
      CREATE TABLE IF NOT EXISTS resume_tasks (
        id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        project_label TEXT NOT NULL,
        bucket TEXT NOT NULL,
        registered_at_ms INTEGER NOT NULL,
        registered_remaining_percent REAL NOT NULL,
        expected_reset_at_ms INTEGER,
        state TEXT NOT NULL CHECK(state IN ('waiting', 'ready', 'approved', 'resumed', 'dismissed')),
        ready_at_ms INTEGER,
        approved_at_ms INTEGER,
        resumed_at_ms INTEGER,
        dismissed_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        error_detail TEXT
      )
    `);
    const resumeTaskColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(resume_tasks)")
      .all();
    if (!resumeTaskColumns.some((column) => column.name === "registered_remaining_percent")) {
      db.run(`
        ALTER TABLE resume_tasks
        ADD COLUMN registered_remaining_percent REAL NOT NULL DEFAULT 0
      `);
    }
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS resume_tasks_one_active_session
      ON resume_tasks(task_key)
      WHERE state IN ('waiting', 'ready', 'approved')
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS resume_tasks_recent
      ON resume_tasks(registered_at_ms DESC)
    `);
    // Opt-in execution jobs are independent of the session-opening resume model.
    // Their prompts/results belong only to this private database.
    db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        job_key TEXT NOT NULL UNIQUE,
        spec_json TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        account TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('waiting', 'ready', 'running', 'review', 'succeeded', 'failed', 'cancelled')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        blocked_at_ms INTEGER,
        not_before_ms INTEGER,
        reason TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        approved_at_ms INTEGER,
        imported_at_ms INTEGER,
        claim_token TEXT UNIQUE,
        lease_at_ms INTEGER,
        active_step_index INTEGER,
        CHECK((state = 'running' AND claim_token IS NOT NULL AND lease_at_ms IS NOT NULL AND active_step_index IS NOT NULL)
          OR (state != 'running' AND claim_token IS NULL AND lease_at_ms IS NULL AND active_step_index IS NULL))
      )
    `);
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_account
      ON jobs(provider, account) WHERE state = 'running'
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS job_steps (
        job_id TEXT NOT NULL REFERENCES jobs(id),
        step_index INTEGER NOT NULL,
        step_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'succeeded', 'blocked', 'failed', 'uncertain')),
        result TEXT,
        native_session_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(job_id, step_index),
        UNIQUE(job_id, step_key)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(created_at_ms DESC, id)`);
  }
