import { withAnnouncementTime } from "../signals/time";
import type { QuotaStorage } from "./database";
import { expandBenefitSignals, supportsSignal, type ResetSignal } from "../signals/classify";

export interface SignalHealth {
  lastAttemptMs: number | null; lastSuccessMs: number | null; error: string | null;
  cursorMs: number | null; source: string;
  sources?: SourceHealth[];
}
export interface SourceHealth {
  id: string; coverage: string; lastAttemptMs: number | null; lastSuccessMs: number | null;
  error: string | null; cursorMs: number | null; latestPublishedAtMs: number | null;
  lastEvidenceMs: number | null; newEvidenceCount: number; fingerprints: string[];
  examinedPosts?: number; latestPostAtMs?: number | null;
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
      const previous = new Map(this.list(200).map(signal => [signal.id, signal]));
      const notified = new Map(this.storage.db.query<{ fingerprint: string; notified: number }, []>(
        "SELECT fingerprint, notified FROM reset_signals").all().map(row => [row.fingerprint, row.notified]));
      for (const s of signals.flatMap(expandBenefitSignals).sort((a,b) => a.publishedAtMs - b.publishedAtMs)) {
        const prior = previous.get(s.id)
          ?? (s.sourcePostId ? previous.get(s.sourcePostId) : undefined);
        const key = `${s.id}:${s.fingerprint}`;
        if (this.storage.db.query<{ id: string }, [string]>("SELECT id FROM reset_signals WHERE id=?").get(key)) {
          const priority = { "public-feed": 1, "resetradar": 1, "claudereset": 2, "codexreset": 2, "x-api": 3 };
          if (prior?.fingerprint === s.fingerprint && priority[s.observedVia] >= (priority[prior.observedVia] ?? 0)) {
            this.storage.db.run("UPDATE reset_signals SET payload=? WHERE id=?",
              [JSON.stringify({ ...s, detectedAtMs: prior.detectedAtMs }), key]);
            previous.set(s.id, { ...s, detectedAtMs: prior.detectedAtMs });
          }
          continue;
        }
        const sameEvidence = prior && prior.text.trim() === s.text.trim() && prior.targetAtMs === s.targetAtMs &&
          prior.contextText === s.contextText && (prior.state === s.state || s.observedVia !== "public-feed");
        const priorNotified = prior ? notified.get(prior.fingerprint) ?? 0 : 0;
        const payload = { ...s, detectedAtMs: nowMs };
        // A newly added relay can enrich years of history. That first sighting
        // establishes coverage, not a fresh announcement or revision time.
        const historicalImport = s.publishedAtMs < nowMs - 24 * 3600_000 && (!prior || prior.observedVia !== s.observedVia);
        this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE json_extract(payload, '$.id')=?", [s.id]);
        if (s.sourcePostId) this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE json_extract(payload, '$.id')=?", [s.sourcePostId]);
        const alreadyNotified = historicalImport ? 1 : sameEvidence ? priorNotified : 0;
        this.storage.db.run(`INSERT OR IGNORE INTO reset_signals(id, fingerprint, published_ms, payload, notified)
          VALUES(?,?,?,?,?)`, [key, s.fingerprint, s.publishedAtMs, JSON.stringify(payload),
            alreadyNotified]);
        previous.set(s.id, payload);
        notified.set(s.fingerprint, alreadyNotified);
      }
      this.storage.db.run("DELETE FROM reset_signals WHERE published_ms < ?", [nowMs - 30 * 86400_000]);
    });
  }
  list(limit = 20): ResetSignal[] {
    const records: ResetSignal[] = [];
    const expandedPosts = new Set(this.storage.db.query<{ source_id: string }, []>(
      "SELECT DISTINCT json_extract(payload, '$.sourcePostId') AS source_id FROM reset_signals WHERE json_extract(payload, '$.sourcePostId') IS NOT NULL")
      .all().map(row => row.source_id));
    for (const row of this.storage.db.query<{payload: string}, []>(`SELECT payload FROM reset_signals WHERE rowid IN
      (SELECT MAX(rowid) FROM reset_signals GROUP BY json_extract(payload, '$.id'))
      ORDER BY published_ms DESC, rowid DESC`).iterate()) {
      const signal: ResetSignal = JSON.parse(row.payload);
      if (!expandedPosts.has(signal.id) && supportsSignal(signal)) records.push(withAnnouncementTime(signal));
      if (records.length >= limit) break;
    }
    return records;
  }
  pending(nowMs: number): ResetSignal[] {
    const rows = this.storage.db.query<{payload: string}, [number]>("SELECT payload FROM reset_signals WHERE notified=0 AND COALESCE(json_extract(payload, '$.detectedAtMs'), published_ms) >= ? ORDER BY published_ms ASC")
      .all(nowMs - 24 * 3600_000).map(row => JSON.parse(row.payload) as ResetSignal).filter(supportsSignal).map(withAnnouncementTime);
    const latest = this.list(200);
    return rows.filter(s => (s.targetAtMs == null || s.targetAtMs > nowMs || s.state === "reported" || s.state === "withdrawn") &&
      !latest.some(other => other.groupId === s.groupId && other.publishedAtMs > s.publishedAtMs)).slice(0, 20);
  }
  delivered(fingerprint: string) {
    this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE fingerprint=?", [fingerprint]);
  }
}
