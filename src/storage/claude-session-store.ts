import type { ClaudeSessionState } from "../domain/claude-consensus";
import type { QuotaObservation } from "../types";
import type { QuotaStorage } from "./database";

/// Rows in, rows out. Which of them wins is decided in
/// domain/claude-consensus.ts, not here.
export class ClaudeSessionStore {
  constructor(private readonly storage: QuotaStorage) {}

  upsertSessionRows(observations: QuotaObservation[]): void {
    for (const observation of observations) {
      this.storage.db
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
  }

  activeSessionRowsSince(sinceMs: number): ClaudeSessionState[] {
    return this.storage.db
      .query<ClaudeSessionState, [number]>(`
        SELECT account, session_hash, bucket, label, window_seconds,
               used_percent, resets_at_ms, observed_at_ms, value_changed_at_ms
        FROM claude_session_state WHERE observed_at_ms >= ?
      `)
      .all(sinceMs);
  }

  prune(cutoffMs: number): void {
    this.storage.db.query("DELETE FROM claude_session_state WHERE observed_at_ms < ?").run(cutoffMs);
  }
}
