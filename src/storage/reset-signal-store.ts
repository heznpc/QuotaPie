import { withAnnouncementTime } from "../signals/time";
import type { PostReview } from "../signals/post-review";
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
  saveReviews(reviews: PostReview[], nowMs: number) {
    this.storage.transaction(() => {
      for (const review of reviews) {
        this.storage.db.run(`INSERT INTO reset_post_reviews(source,post_id,payload,first_seen_ms,last_seen_ms)
          VALUES(?,?,?,?,?) ON CONFLICT(source,post_id) DO UPDATE SET payload=excluded.payload,last_seen_ms=excluded.last_seen_ms`,
          [review.source, review.id, JSON.stringify(review), nowMs, nowMs]);
      }
      this.storage.db.run("DELETE FROM reset_post_reviews WHERE last_seen_ms < ?", [nowMs - 30 * 86400_000]);
      this.storage.db.run(`DELETE FROM reset_post_reviews WHERE rowid NOT IN
        (SELECT rowid FROM reset_post_reviews ORDER BY last_seen_ms DESC,rowid DESC LIMIT 1000)`);
    });
  }
  excludedPosts(nowMs = Date.now()) {
    return this.storage.db.query<{payload: string; first_seen_ms: number; last_seen_ms: number}, [number]>(`
      SELECT payload,first_seen_ms,last_seen_ms FROM reset_post_reviews
      WHERE json_extract(payload,'$.reason') IS NOT NULL AND last_seen_ms >= ?
      ORDER BY json_extract(payload,'$.publishedAtMs') DESC,source,post_id LIMIT 50`)
      .all(nowMs - 30 * 86400_000).map(row => ({ ...JSON.parse(row.payload) as PostReview,
        firstSeenAtMs: row.first_seen_ms, lastSeenAtMs: row.last_seen_ms }));
  }
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
      !latest.some(other => other.publishedAtMs > s.publishedAtMs &&
        (other.groupId === s.groupId ||
          // Relays assign different event IDs to a vote and its completion.
          // Do not issue a late, untimed warning after a matching reset report.
          ["possible", "announced", "updated"].includes(s.state) && s.targetAtMs == null &&
          (s.benefitKind ?? "reset") === "reset" && s.resetKind !== "banked" &&
          other.state === "reported" && (other.benefitKind ?? "reset") === "reset" && other.resetKind !== "banked" &&
          (other.provider ?? "codex") === (s.provider ?? "codex") && other.scopeHint === s.scopeHint &&
          other.publishedAtMs - s.publishedAtMs <= 24 * 3600_000))).slice(0, 20);
  }
  delivered(fingerprint: string) {
    this.storage.db.run("UPDATE reset_signals SET notified=1 WHERE fingerprint=?", [fingerprint]);
  }
}
