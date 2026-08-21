import type { QuotaObservation } from "../types";

/// One row of what a single Claude window looked like to one session.
export interface ClaudeSessionState {
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

export interface AccountBucket {
  account: string;
  bucket: string;
}

/// Reconciles what several Claude sessions each believe about the same window.
///
/// This is a decision, not storage: which reset clock to trust when sessions
/// disagree, and which usage figure to adopt once they agree. It is pure so the
/// rules that matter — a stale window must never roll a usage figure backwards,
/// a rebase to an earlier reset is still legitimate, accounts never mix — can be
/// stated as facts about inputs rather than as facts about a database.
export function selectClaudeConsensus(
  rows: ClaudeSessionState[],
  affected: AccountBucket[],
  ttlMs: number,
  referenceMs: number,
): QuotaObservation[] {
  const active = rows.filter((row) => row.observed_at_ms >= referenceMs - ttlMs);
  const consensus: QuotaObservation[] = [];

  for (const { account, bucket } of affected) {
    const candidates = active.filter((row) => row.account === account && row.bucket === bucket);
    if (!candidates.length) continue;

    // The reset clock follows whichever session saw it change most recently,
    // which is what lets a legitimate rebase to an earlier time win over an
    // older session still holding the previous schedule.
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

    // Within one reset window the highest reading wins: a session that has been
    // idle reports an older, lower number, and adopting it would quietly undo
    // usage that actually happened.
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
}
