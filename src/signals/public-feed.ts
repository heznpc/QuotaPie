import { createHash } from "node:crypto";
import { classifyPost, type ResetSignal, type SignalState } from "./classify";
import { isWatched } from "./x-source";

export function parsePublicFeed(body: any, nowMs: number): ResetSignal[] {
  if (body?.version !== 1 || !Array.isArray(body.items) || body.items.length > 200) throw new Error("feed-invalid-response");
  const generated = Date.parse(body.generatedAt);
  if (!Number.isFinite(generated) || generated > nowMs + 300_000 || nowMs - generated > 3600_000) throw new Error("feed-stale");
  const signals: ResetSignal[] = [];
  for (const item of body.items) {
    if (typeof item.sourceUrl !== "string") continue;
    let url: URL; try { url = new URL(item.sourceUrl); } catch { continue; }
    const match = url.pathname.match(/^\/([a-zA-Z0-9_]+)\/status\/(\d{1,30})\/?$/);
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname) || !match || !isWatched(match[1]!)) continue;
    const at = Date.parse(item.sourcePublishedAt);
    if (!Number.isFinite(at) || at > nowMs + 300_000 || typeof item.classificationQuote !== "string") continue;
    let state: SignalState = item.withdrawn === true ? "withdrawn" : item.topic === "schedule" ? "announced"
      : item.topic === "action" ? "reported" : "possible";
    // This is the feed's classification, not a claim we fetched/verified X.
    const text = item.classificationQuote.slice(0, 3000);
    const local = classifyPost({ id: match[2]!, author: match[1]!, text, createdAtMs: at,
      conversationId: match[2]!, references: [] }, new Map());
    if (!item.withdrawn && item.topic === "action" && local?.state === "announced") state = "announced";
    const groupId = typeof item.eventId === "string" ? `feed:${item.eventId.slice(0, 120)}` : match[2]!;
    const fingerprint = createHash("sha256").update(JSON.stringify([groupId, match[2], state, text, item.targetAt])).digest("hex").slice(0, 24);
    const target = Date.parse(item.targetAt);
    signals.push({ id: match[2]!, groupId, fingerprint, author: match[1]!, sourceUrl: `https://x.com/${match[1]}/status/${match[2]}`,
      text, contextText: typeof item.withdrawnReason === "string" ? item.withdrawnReason.slice(0, 1000) : null,
      publishedAtMs: at, state, resetKind: /\bbanked\b|reset\s+(?:card|credit)/i.test(text) ? "banked" : "unknown",
      timeHint: item.topic === "schedule" ? text : null, scopeHint: null,
      observedVia: "public-feed", targetAtMs: Number.isFinite(target) ? target : null });
  }
  const rank = { possible: 0, announced: 1, reported: 2, updated: 3, withdrawn: 4 };
  const latest = new Map<string, ResetSignal>();
  for (const signal of signals) {
    const previous = latest.get(signal.id);
    if (!previous || rank[signal.state] > rank[previous.state]) latest.set(signal.id, signal);
  }
  return [...latest.values()];
}
export async function fetchPublicFeed(nowMs: number, fetcher: typeof fetch = fetch): Promise<ResetSignal[]> {
  const response = await fetcher("https://resetbeacon.com/api/alerts", { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`feed-http-${response.status}`);
  const reader = response.body?.getReader(); if (!reader) throw new Error("feed-empty-response");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 1_000_000) { await reader.cancel(); throw new Error("feed-response-too-large"); }
    chunks.push(value);
  }
  return parsePublicFeed(JSON.parse(Buffer.concat(chunks).toString("utf8")), nowMs);
}
