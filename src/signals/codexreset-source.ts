import { classifyPost, type ResetSignal } from "./classify";
import { isWatched, type PublicPost } from "./x-source";

// Read quoted post records only. Never evaluate the site's hydration script or
// treat its forecast score as evidence of a reset.
export function parseCodexResetPage(html: string, nowMs: number): ResetSignal[] {
  if (html.length > 2_000_000 || !html.includes('id="$tsr-stream-barrier"') || !html.includes("activeSignals:")) {
    throw new Error("monitor-invalid-response");
  }
  const literal = String.raw`("(?:[^"\\]|\\.)*")`;
  const pattern = new RegExp(String.raw`\{id:${literal},kind:${literal},score:\d+,text:${literal},createdAt:${literal},sourceUrl:${literal},author:\$R\[\d+\]=\{username:${literal}`, "g");
  const decode = (s: string): string => JSON.parse(s.replace(/\\(?:x([0-9a-f]{2})|.)/gi,
    (match, hex) => hex ? `\\u00${hex}` : match));
  const posts = new Map<string, PublicPost>();
  let recognized = 0;
  for (const match of html.matchAll(pattern)) {
    recognized++;
    const [id, , text, createdAt, sourceUrl, author] = match.slice(1).map(decode) as [string, string, string, string, string, string];
    const at = Date.parse(createdAt);
    if (!/^\d{1,30}$/.test(id) || !isWatched(author) || sourceUrl !== `https://x.com/${author}/status/${id}` ||
        !Number.isFinite(at) || at > nowMs + 300_000 || text.length > 12000) continue;
    posts.set(id, { id, author, text, createdAtMs: at, conversationId: id, references: [] });
  }
  if (!recognized) throw new Error("monitor-schema-changed");
  const context = new Map(posts);
  const replies = new RegExp(String.raw`replyTo:\$R\[\d+\]=\{author:${literal},handle:${literal},id:${literal},sourceUrl:${literal},status:"complete",text:${literal}\},sourceUrl:${literal},text:${literal}`, "g");
  for (const match of html.matchAll(replies)) {
    const [, handle, parentId, , parentText, childUrl] = match.slice(1).map(decode);
    const childId = childUrl?.match(/^https:\/\/x\.com\/[a-zA-Z0-9_]+\/status\/(\d{1,30})$/)?.[1];
    const child = childId ? posts.get(childId) : null;
    if (!child || childUrl !== `https://x.com/${child.author}/status/${child.id}` ||
        !parentId || !/^\d{1,30}$/.test(parentId) || !handle?.match(/^@[a-zA-Z0-9_]+$/) || !parentText || parentText.length > 12000) continue;
    if (!context.has(parentId)) context.set(parentId, { id: parentId, author: handle.slice(1), text: parentText,
      createdAtMs: child.createdAtMs, conversationId: parentId, references: [] });
    child.references = [{ id: parentId, type: "replied_to" }];
    child.conversationId = parentId;
  }
  return [...posts.values()].flatMap(post => {
    const signal = classifyPost(post, context);
    return signal ? [{ ...signal, observedVia: "codexreset" as const }] : [];
  });
}

export async function fetchCodexReset(nowMs: number, fetcher: typeof fetch = fetch): Promise<ResetSignal[]> {
  const response = await fetcher("https://codexreset.org/", { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`monitor-http-${response.status}`);
  const reader = response.body?.getReader(); if (!reader) throw new Error("monitor-empty-response");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("monitor-response-too-large"); }
    chunks.push(value);
  }
  return parseCodexResetPage(Buffer.concat(chunks).toString("utf8"), nowMs);
}
