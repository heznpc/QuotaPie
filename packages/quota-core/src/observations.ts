import type { CompactionRequestEvent } from "./events.js";
const ongoing = (phase: string) => phase === "started" || phase === "response_headers";

/** Metadata only; active IDs must come from a fresh host health observation. */
export function summarizeRequestEvents(all: readonly CompactionRequestEvent[], activeIds: ReadonlySet<string>, nowMs = Date.now()) {
    // Parse timestamps once and index by thread. Looking for each compaction's
    // follow-up must not rescan and reparse every generation's entire history.
    const timed = all.map(item => {
      const at = Date.parse(item.at);
      return {item, at, start: at - item.durationMs};
    });
    type Timed = typeof timed[number];
    const byThread = new Map<string, {compactions: Timed[]; responses: Timed[]}>();
    for (const entry of timed) {
      if (!entry.item.threadId) continue;
      let group = byThread.get(entry.item.threadId);
      if (!group) byThread.set(entry.item.threadId, group = {compactions: [], responses: []});
      (entry.item.kind === "compaction" ? group.compactions : group.responses).push(entry);
    }
    for (const group of byThread.values()) group.responses.sort((a,b) => a.start - b.start);
    timed.sort((a,b) => b.at - a.at);
    const notificationEvidence = timed.slice(0, 200).map(entry => entry.item);
    const compactions = timed.filter(entry => entry.item.kind === "compaction").slice(0, 50);
    const retained = new Map<string, CompactionRequestEvent>();
    const records = compactions.map(({item, at: end}) => {
      retained.set(item.requestId, item);
      const active = ongoing(item.phase) && activeIds.has(item.requestId);
      const group = item.threadId ? byThread.get(item.threadId) : undefined;
      const nextCompaction = group?.compactions.reduce((next, entry) =>
        entry.item.requestId !== item.requestId && entry.start >= end ? Math.min(next, entry.start) : next, Infinity) ?? Infinity;
      // Match actual requests, never saved composer settings. A different turn,
      // an overlapping request or another task cannot establish continuation.
      const followup = item.threadId && !ongoing(item.phase) && item.phase !== "unverified"
        ? group?.responses.find(entry => (!item.turnId || entry.item.turnId === item.turnId) &&
            entry.start >= end && entry.start < nextCompaction)?.item : undefined;
      if (followup) retained.set(followup.requestId, followup);
      return { ...item, phase: ongoing(item.phase) && !active ? "unverified" : item.phase,
        ...(ongoing(item.phase) && !active ? { errorCode: "relay_state_unavailable" } : {}),
        active, startedAtMs: end - item.durationMs,
        finishedAtMs: ongoing(item.phase) ? null : end,
        elapsedMs: active ? Math.max(item.durationMs, nowMs - end + item.durationMs) : item.durationMs,
        followup: followup ? { requestId: followup.requestId, model: followup.to, effort: followup.reasoningEffort,
          startedAtMs: Date.parse(followup.at) - followup.durationMs } : null };
    });
    const savingsRecords = timed.filter(({item})=>item.kind === "response" && item.savingsReason && item.savingsReason !== "disabled")
      .slice(0,50).map(({item})=> {
        retained.set(item.requestId,item);
        const active=ongoing(item.phase) && activeIds.has(item.requestId);
        return {...item,active,phase:ongoing(item.phase) && !active ? "unverified" : item.phase};
      });
    return { records, savingsRecords, retained, notificationEvidence };
}
