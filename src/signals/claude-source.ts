import { classifyPost, type ResetSignal } from "./classify";
import { isWatched, providerForAuthor } from "./x-source";

// These are independently curated records with primary links, not direct X
// retrieval. Forecasts, community reports and unlinked claims are excluded.
function postLink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value), m = u.pathname.match(/^\/([a-zA-Z0-9_]+)\/status\/(\d{1,30})\/?$/);
    if (u.protocol !== "https:" || u.hostname !== "x.com" || u.username || u.password || u.port || !m ||
        !isWatched(m[1]!) || providerForAuthor(m[1]!) !== "claude") return null;
    return { author: m[1]!, id: m[2]! };
  } catch { return null; }
}
export function parseClaudeNews(body: any, source: "claudereset" | "resetradar", nowMs: number): ResetSignal[] {
  if (!Array.isArray(body?.events) || body.events.length > 2000 ||
      (source === "claudereset" ? body.schema_version !== 1 : body.version !== "1.0.0"))
    throw new Error("monitor-schema-changed");
  return body.events.flatMap((row: any) => {
    if (source === "claudereset" && row.origin !== "official_post") return [];
    if (source === "resetradar" && (row.status !== "historic" || row.confidence !== "confirmed" || row.impact !== "positive")) return [];
    const link = source === "claudereset" ? postLink(row.url)
      : Array.isArray(row.sources) ? row.sources.map((s: any) => postLink(s?.url)).find(Boolean) : null;
    const at = Date.parse(source === "claudereset" ? row.ts : row.announced_date ?? row.date);
    const text = row.summary;
    if (!link || !Number.isFinite(at) || at > nowMs + 300_000 || at < nowMs - 30 * 86400_000 ||
        typeof text !== "string" || text.length > 12000) return [];
    const signal = classifyPost({ ...link, text, createdAtMs: at, conversationId: link.id, references: [] }, new Map());
    if (!signal) return [];
    return [{ ...signal, observedVia: source,
      ...(source === "claudereset" && row.kind === "banked" ? { resetKind: "banked" as const,
        ...(signal.benefitKind === "reset" ? { benefitKind: "resetCredits" as const } : {}) } : {}),
      scopeHint: typeof row.scope === "string" ? row.scope : signal.scopeHint }];
  });
}
export async function fetchClaudeNews(source: "claudereset" | "resetradar", nowMs: number, fetcher: typeof fetch = fetch) {
  const url = source === "claudereset" ? "https://claudereset.org/api/v1/timeline.json" : "https://resetradar.com/data/events.json";
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`monitor-http-${response.status}`);
  const reader = response.body?.getReader(); if (!reader) throw new Error("monitor-empty-response");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("monitor-response-too-large"); }
    chunks.push(value);
  }
  return parseClaudeNews(JSON.parse(Buffer.concat(chunks).toString("utf8")), source, nowMs);
}
