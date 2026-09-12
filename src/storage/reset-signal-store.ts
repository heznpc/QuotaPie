import type { QuotaStorage } from "./database";
import type { ResetSignal } from "../signals/classify";

export interface SignalHealth {
  lastAttemptMs: number | null; lastSuccessMs: number | null; error: string | null;
  cursorMs: number | null; source: string;
  sources?: SourceHealth[];
}
export interface SourceHealth {
  id: string; coverage: string; lastAttemptMs: number | null; lastSuccessMs: number | null;
  error: string | null; cursorMs: number | null; latestPublishedAtMs: number | null;
  lastEvidenceMs: number | null; newEvidenceCount: number; fingerprints: string[];
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
        const prior = this.list(200).find(other => other.id === s.id);
        const key = `${s.id}:${s.fingerprint}`;
        if (this.storage.db.query<{ id: string }, [string]>("SELECT id FROM reset_signals WHERE id=?").get(key)) {
          const priority = { "public-feed": 1, "codexreset": 2, "x-api": 3 };
          if (prior?.fingerprint === s.fingerprint && priority[s.observedVia] > (priority[prior.observedVia] ?? 0)) {
            this.storage.db.run("UPDATE reset_signals SET payload=? WHERE id=?",
              [JSON.stringify({ ...s, detectedAtMs: prior.detectedAtMs }), key]);
          }
          continue;
        }
        const sameEvidence = prior && prior.text.trim() === s.text.trim() && prior.targetAtMs === s.targetAtMs &&
          prior.contextText === s.contextText && (prior.state === s.state || s.observedVia !== "public-feed");
        const priorNotified = prior ? this.storage.db.query<{ notified: number }, [string]>(
          "SELECT notified FROM reset_signals WHERE fingerprint=?").get(prior.fingerprint)?.notified : 0;
        const payload = { ...s, detectedAtMs: nowMs };
        // A newly added relay can enrich years of history. That first sighting
        // establishes coverage, not a fresh announcement or revision time.
        const historicalImport = s.publishedAtMs < nowMs - 24 * 3600_000 && (!prior || prior.observedVia !== s.observedVia);
        this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE json_extract(payload, '$.id')=?", [s.id]);
        this.storage.db.run(`INSERT OR IGNORE INTO reset_signals(id, fingerprint, published_ms, payload, notified)
          VALUES(?,?,?,?,?)`, [key, s.fingerprint, s.publishedAtMs, JSON.stringify(payload),
            historicalImport ? 1 : sameEvidence ? priorNotified ?? 0 : 0]);
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
    const rows = this.storage.db.query<{payload: string}, [number]>("SELECT payload FROM reset_signals WHERE notified=0 AND COALESCE(json_extract(payload, '$.detectedAtMs'), published_ms) >= ? ORDER BY published_ms ASC LIMIT 20")
      .all(nowMs - 24 * 3600_000).map(row => JSON.parse(row.payload) as ResetSignal);
    const latest = this.list(200);
    return rows.filter(s => (s.targetAtMs == null || s.targetAtMs > nowMs || s.state === "withdrawn") &&
      !latest.some(other => other.groupId === s.groupId && other.publishedAtMs > s.publishedAtMs));
  }
  delivered(fingerprint: string) {
    this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE fingerprint=?", [fingerprint]);
  }
}
