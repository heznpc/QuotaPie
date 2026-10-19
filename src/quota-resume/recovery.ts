import type { QuotaStorage } from "../storage/database";
import type { WindowAnalysis } from "../types";
import type { WorkBaseline } from "../work/types";

interface Checkpoint {
  windows: Record<string, { remaining: number; resetAtMs: number; observedAtMs: number; latestObservedAtMs?: number; allowed?: boolean }>;
  recoveredAtMs?: number;
}

/** A new poll is not new capacity. Each failed automatic turn must wait for a
 * separately observed recovery before another single-use execution is allowed. */
export class QuotaRecoveryStore {
  constructor(private readonly storage: QuotaStorage) {
    storage.db.exec("CREATE TABLE IF NOT EXISTS quota_recovery_checkpoints (id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  }
  recovered(id: string, failedAtMs: number, baselines: Record<string, WorkBaseline>, windows: WindowAnalysis[], nowMs: number): boolean {
    if(!id || !Number.isFinite(failedAtMs) || !Number.isFinite(nowMs) || failedAtMs<0 || nowMs<failedAtMs) return false;
    return this.storage.transaction(() => {
      const row = this.storage.db.query<{value:string}, [string]>("SELECT value FROM quota_recovery_checkpoints WHERE id=?").get(id);
      const state: Checkpoint = row ? JSON.parse(row.value) : { windows: {} };
      if (state.recoveredAtMs !== undefined) return true;
      const previous = JSON.stringify(state);
      for (const w of windows) {
        if (w.quality !== "authoritative" || w.freshness !== "fresh" || w.remainingPercent === null ||
            !Number.isFinite(w.remainingPercent) || w.remainingPercent<0 || w.remainingPercent>100 ||
            w.resetsAtMs === null || !Number.isFinite(w.resetsAtMs) || w.resetsAtMs<=nowMs ||
            !Number.isFinite(w.observedAtMs) || w.observedAtMs <= failedAtMs || w.observedAtMs > nowMs) continue;
        const baseline = baselines[w.bucket];
        const reset = Number(baseline?.epoch);
        let prior = state.windows[w.bucket];
        if (!prior && baseline && Number.isFinite(reset) && reset > 0 &&
            Number.isFinite(baseline.atMs) && baseline.atMs>=0 && baseline.atMs <= failedAtMs &&
            Number.isFinite(baseline.remainingPercent) && baseline.remainingPercent>=0 && baseline.remainingPercent<=100) {
          prior = state.windows[w.bucket] = {remaining:baseline.remainingPercent, resetAtMs:reset, observedAtMs:baseline.atMs};
        }
        // An older low sample must not manufacture a recovery when the same
        // newer sample is read again after a restart or out-of-order response.
        if(prior && w.observedAtMs<=(prior.latestObservedAtMs??prior.observedAtMs)) continue;
        const allowed = typeof w.metadata?.ordinaryUsageAllowed === "boolean" ? w.metadata.ordinaryUsageAllowed : undefined;
        if (prior && w.observedAtMs > prior.observedAtMs && (
          (prior.observedAtMs >= failedAtMs && w.remainingPercent > prior.remaining) ||
          // Relative reset headers can jitter by a second. A future timestamp
          // changing is not proof of reset. A boundary that already passed
          // during the failed turn cannot authorize its next continuation.
          (prior.resetAtMs >= failedAtMs && w.observedAtMs >= prior.resetAtMs && w.resetsAtMs >= prior.resetAtMs + 60_000) ||
          (prior.observedAtMs >= failedAtMs && prior.allowed === false && allowed === true)
        )) state.recoveredAtMs = w.observedAtMs;
        // An increase since dispatch may have occurred while the failed turn
        // was still running. Seed the first post-failure percentage instead.
        if (!prior || prior.observedAtMs < failedAtMs || w.remainingPercent < prior.remaining || allowed === false && prior.allowed !== false) {
          state.windows[w.bucket] = {remaining:w.remainingPercent, resetAtMs:w.resetsAtMs, observedAtMs:w.observedAtMs,latestObservedAtMs:w.observedAtMs,
            ...(allowed === undefined ? {} : {allowed})};
        } else {
          // A provider can correct its next reset prediction before that
          // boundary arrives. Keep the new prediction without discarding the
          // post-failure minimum; the old predicted time proves no reset.
          if(w.observedAtMs<prior.resetAtMs) prior.resetAtMs=w.resetsAtMs;
          prior.latestObservedAtMs=w.observedAtMs;
        }
      }
      if (!row || previous !== JSON.stringify(state)) this.storage.db.query(
        "INSERT INTO quota_recovery_checkpoints(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value"
      ).run(id, JSON.stringify(state));
      return state.recoveredAtMs !== undefined;
    });
  }
}
