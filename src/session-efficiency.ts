import type { CompactionRequestEvent } from "./codex-compaction";

export interface SessionEfficiencyInsight {
  id: string; threadId: string; kind: "repeated-failure" | "repeated-compaction";
  count: number; firstAtMs: number; lastAtMs: number; observedDurationMs: number;
  requestIds: string[]; origin: "provider" | "relay" | "client" | "transport" | "unknown";
  suggestion: "review-provider-error" | "review-relay-error" | "review-disconnect" | "review-compaction" | "review-connection" | "review-error";
  savingsApplied: boolean;
}

/** Bounded, metadata-only evidence. Duration/tokens alone never label a task as
 * wasteful. A later successful response clears the current repeated-failure hint.
 * No transcript, model call, skill creation or automatic settings change. */
export function sessionEfficiencyInsights(events: readonly CompactionRequestEvent[], nowMs: number): SessionEfficiencyInsight[] {
  const unique = new Map<string, CompactionRequestEvent>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!event.threadId || !Number.isFinite(at) || at > nowMs || at < nowMs - 30 * 60_000) continue;
    const previous = unique.get(event.requestId);
    if (!previous || Date.parse(previous.at) <= at) unique.set(event.requestId, event);
  }
  const groups = new Map<string, CompactionRequestEvent[]>();
  for (const event of unique.values()) {
    const group = groups.get(event.threadId!) ?? [];
    group.push(event); groups.set(event.threadId!, group);
  }
  const result: SessionEfficiencyInsight[] = [];
  for (const [threadId, group] of groups) {
    group.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const lastSuccess = group.reduce((at, e) => e.kind === "response" && e.phase === "completed" ? Math.max(at, Date.parse(e.at)) : at, -Infinity);
    const unresolved = group.filter(e => Date.parse(e.at) > lastSuccess);
    const failures = new Map<string, CompactionRequestEvent[]>();
    for (const e of unresolved) {
      if (e.phase !== "failed" || !e.errorCode) continue;
      const key = `${e.kind}:${e.errorCode}:${e.failureOrigin ?? "unknown"}`;
      const list = failures.get(key) ?? []; list.push(e); failures.set(key, list);
    }
    const add = (kind: SessionEfficiencyInsight["kind"], list: CompactionRequestEvent[]) => {
      if (list.length < 3) return;
      const last = list.at(-1)!;
      const origin = last.failureOrigin?.startsWith("provider_") ? "provider" : ["relay", "client", "transport"].includes(last.failureOrigin ?? "")
        ? last.failureOrigin as SessionEfficiencyInsight["origin"] : "unknown";
      result.push({ id: `${threadId}:${kind}:${last.requestId}`, threadId, kind, count: list.length,
        firstAtMs: Date.parse(list[0]!.at), lastAtMs: Date.parse(last.at),
        observedDurationMs: list.reduce((sum, e) => sum + Math.max(0, e.durationMs), 0),
        requestIds: list.map(e => e.requestId), origin,
        suggestion: kind === "repeated-compaction" ? "review-compaction" : origin === "relay" ? "review-relay-error"
          : origin === "client" ? "review-disconnect" : origin === "transport" ? "review-connection"
          : origin === "provider" ? "review-provider-error" : "review-error",
        savingsApplied: list.some(e => e.kind === "response" && e.routed),
      });
    };
    for (const failuresOfKind of failures.values()) add("repeated-failure", failuresOfKind);
    // Failed compactions already have a more specific error diagnosis.
    add("repeated-compaction", unresolved.filter(e => e.kind === "compaction" && e.phase === "completed"));
  }
  return result.sort((a, b) => b.lastAtMs - a.lastAtMs).slice(0, 20);
}
