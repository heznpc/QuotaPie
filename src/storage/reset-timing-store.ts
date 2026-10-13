import type { QuotaStorage } from "./database";
import type { ResetSignal } from "../signals/classify";
import type { Provider, QuotaEvent } from "../types";
import { isTimingAnnouncement, timingEvaluation, timingForecast, timingObservation, type ResetTimingCase } from "../signals/timing-history";
const DAY = 86_400_000;

/** Durable local evidence survives the public-feed retention window. No model,
 * notification, quota policy or conversation is invoked by this store. */
export class ResetTimingStore {
  constructor(private storage: QuotaStorage) {}
  list(): ResetTimingCase[] {
    return this.storage.db.query<{ payload: string }, []>("SELECT payload FROM reset_timing_cases ORDER BY published_ms DESC").all()
      .map(r => JSON.parse(r.payload));
  }
  sync(signals: ResetSignal[], events: QuotaEvent[], accounts: { provider: Provider; account: string; contextAtMs?: number }[], now: number) {
    this.storage.transaction(() => {
      const rows = this.list();
      const prior = new Map(rows.map(r => [JSON.stringify([r.provider,r.account,r.signalId]), JSON.stringify(r)]));
      for (const s of signals.filter(isTimingAnnouncement)) for (const a of accounts) {
        if (a.provider !== (s.provider ?? "codex") || s.publishedAtMs > now || now - s.publishedAtMs > 365 * DAY) continue;
        const id = s.sourcePostId ?? s.id;
        if (!rows.some(r => r.signalId === id && r.provider === a.provider && r.account === a.account)) rows.push({
          ...a, signalId: id, author: s.author, sourceUrl: s.sourceUrl, originalText: s.change?.evidence ?? s.timeHint ?? s.text,
          publishedAtMs: s.publishedAtMs, firstSeenAtMs: s.detectedAtMs ?? now, forecast: null, observation: null, status: "pending",
        });
      }
      for (const row of rows) {
        const context = accounts.find(a=>a.provider===row.provider&&a.account===row.account)?.contextAtMs ?? 0;
        if (context > (row.contextAtMs ?? 0) && context >= row.publishedAtMs) row.status = "context-changed";
        if (["withdrawn", "context-changed"].includes(row.status)) continue;
        const signal = signals.find(s => (s.sourcePostId ?? s.id) === row.signalId);
        const withdrawn = signals.some(s => s.state === "withdrawn" && (s.provider ?? "codex") === row.provider &&
          s.publishedAtMs <= now && (s.sourcePostId === row.signalId || s.id === row.signalId ||
            signal != null && s.groupId === signal.groupId));
        if (withdrawn) { row.status = "withdrawn"; continue; }
        if (!row.observation) {
          const observations = events.filter(e => e.occurredAtMs <= now).flatMap(e => {
            const o = timingObservation(e, row); return o ? [o] : [];
          }).sort((a,b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0) || a.byMs - b.byMs);
          row.observation = observations[0] ?? null;
        }
        row.status = row.observation ? "observed" : now > row.publishedAtMs + DAY ? "unobserved" : "pending";
      }
      for (const row of rows) {
        // Never manufacture a prediction for a reset already observed, or after
        // its historical estimated interval has passed. First issue is frozen.
        if (!row.forecast && row.status === "pending") {
          const forecast = timingForecast(rows, row, now);
          if (forecast && forecast.latestMs > now) row.forecast = forecast;
        }
      }
      for (const row of rows) {
        if (prior.get(JSON.stringify([row.provider,row.account,row.signalId])) === JSON.stringify(row)) continue;
        this.storage.db.run(`INSERT INTO reset_timing_cases(provider,account,signal_id,published_ms,payload)
        VALUES(?,?,?,?,?) ON CONFLICT(provider,account,signal_id) DO UPDATE SET payload=excluded.payload`,
        [row.provider,row.account,row.signalId,row.publishedAtMs,JSON.stringify(row)]);
      }
      this.storage.db.run("DELETE FROM reset_timing_cases WHERE published_ms < ?", [now - 365 * DAY]);
    });
  }
  summary() {
    const cases = this.list();
    const evaluated = cases.filter(r => r.status === "observed").flatMap(r => {
      const e = timingEvaluation(r); return e ? [e] : [];
    });
    return { cases: cases.map(r => ({ ...r, evaluation: timingEvaluation(r) })),
      evaluation: { issuedCount: cases.filter(r => r.forecast).length, evaluatedCount: evaluated.length,
        overlapCount: evaluated.filter(e => e.overlaps).length,
        meanGapMs: evaluated.length ? evaluated.reduce((sum,e) => sum+e.gapMs,0)/evaluated.length : null,
        unobservedCount: cases.filter(r => r.status === "unobserved").length } };
  }
}
