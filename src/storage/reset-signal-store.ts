import type { QuotaStorage } from "./database";
import type { ResetSignal } from "../signals/classify";

export interface SignalHealth {
  lastAttemptMs: number | null; lastSuccessMs: number | null; error: string | null;
  cursorMs: number | null; source: string;
}
export class ResetSignalStore {
  constructor(private storage: QuotaStorage) {}
  health(): SignalHealth {
    const row = this.storage.db.query<{ payload: string }, []>("SELECT payload FROM reset_signal_source WHERE id=1").get();
    return row ? JSON.parse(row.payload) : { lastAttemptMs: null, lastSuccessMs: null, error: null, cursorMs: null, source: "none" };
  }
  setHealth(health: SignalHealth) {
    this.storage.db.run("INSERT INTO reset_signal_source(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [JSON.stringify(health)]);
  }
  save(signals: ResetSignal[], nowMs: number) {
    this.storage.transaction(() => {
      for (const s of signals.sort((a,b) => a.publishedAtMs - b.publishedAtMs)) {
        const key = `${s.id}:${s.fingerprint}`;
        if (this.storage.db.query<{ id: string }, [string]>("SELECT id FROM reset_signals WHERE id=?").get(key)) {
          this.storage.db.run("UPDATE reset_signals SET rowid=(SELECT MAX(rowid)+1 FROM reset_signals) WHERE id=?", [key]);
          continue;
        }
        this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE json_extract(payload, '$.id')=?", [s.id]);
        this.storage.db.run(`INSERT OR IGNORE INTO reset_signals(id, fingerprint, published_ms, payload, notified)
          VALUES(?,?,?,?,?)`, [key, s.fingerprint, s.publishedAtMs, JSON.stringify(s), s.publishedAtMs < nowMs - 24 * 3600_000 ? 1 : 0]);
      }
      this.storage.db.run("DELETE FROM reset_signals WHERE published_ms < ?", [nowMs - 30 * 86400_000]);
    });
  }
  list(limit = 20): ResetSignal[] {
    return this.storage.db.query<{payload: string}, [number]>(`SELECT payload FROM reset_signals WHERE rowid IN
      (SELECT MAX(rowid) FROM reset_signals GROUP BY json_extract(payload, '$.id'))
      ORDER BY published_ms DESC, rowid DESC LIMIT ?`)
      .all(limit).map(row => JSON.parse(row.payload));
  }
  pending(nowMs: number): ResetSignal[] {
    const rows = this.storage.db.query<{payload: string}, [number]>("SELECT payload FROM reset_signals WHERE notified=0 AND published_ms >= ? ORDER BY published_ms ASC LIMIT 20")
      .all(nowMs - 24 * 3600_000).map(row => JSON.parse(row.payload) as ResetSignal);
    const latest = this.list(200);
    return rows.filter(s => (s.targetAtMs == null || s.targetAtMs > nowMs || s.state === "withdrawn") &&
      !latest.some(other => other.groupId === s.groupId && other.publishedAtMs > s.publishedAtMs));
  }
  delivered(fingerprint: string) {
    this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE fingerprint=?", [fingerprint]);
  }
}
