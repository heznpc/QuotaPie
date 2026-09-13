import { classifyPost, type ResetSignal } from "./classify";
import { isWatched, type PublicPost } from "./x-source";
import { hydrationArrays } from "./hydration-data";

// Read quoted post records only. Never evaluate the site's hydration script or
// treat its forecast score as evidence of a reset.
export function parseCodexResetPage(html: string, nowMs: number): ResetSignal[] {
  return parseCodexResetSnapshot(html, nowMs).signals;
}

export function parseCodexResetSnapshot(html: string, nowMs: number) {
  if (html.length > 2_000_000 || !html.includes('id="$tsr-stream-barrier"') || !html.includes("activeSignals:")) {
    throw new Error("monitor-invalid-response");
  }
  const arrays = hydrationArrays(html.slice(html.indexOf('id="$tsr-stream-barrier"')), ["activeSignals", "monitoredPosts"]);
  if (!arrays.has("activeSignals")) throw new Error("monitor-schema-changed");
  const selected = arrays.get("activeSignals")!;
  const monitored = arrays.get("monitoredPosts");
  const literal = String.raw`("(?:[^"\\]|\\.)*")`;
  const decode = (s: string): string => JSON.parse(s.replace(/\\(?:x([0-9a-f]{2})|.)/gi,
    (match, hex) => hex ? `\\u00${hex}` : match));
  const posts = new Map<string, PublicPost>();
  const context = new Map<string, PublicPost>();
  for (const raw of [...selected, ...(monitored ?? [])]) {
    const row = raw as any;
    const { id, text, createdAt, sourceUrl } = row ?? {};
    const author = typeof row?.handle === "string" ? row.handle.replace(/^@/, "") : row?.author?.username;
    if (typeof id !== "string" || typeof text !== "string" || typeof createdAt !== "string" ||
        typeof sourceUrl !== "string" || typeof author !== "string") throw new Error("monitor-schema-changed");
    const at = Date.parse(createdAt);
    if (typeof id !== "string" || !/^\d{1,30}$/.test(id) || typeof author !== "string" || !isWatched(author) ||
        sourceUrl !== `https://x.com/${author}/status/${id}` || typeof text !== "string" ||
        !Number.isFinite(at) || at > nowMs + 300_000 || text.length > 12000) continue;
    const post: PublicPost = { id, author, text, createdAtMs: at, conversationId: id, references: [] };
    const parent = row.replyTo;
    if (parent?.status === "complete" && typeof parent.id === "string" && /^\d{1,30}$/.test(parent.id) &&
        typeof parent.handle === "string" && /^@[a-zA-Z0-9_]+$/.test(parent.handle) &&
        [ `https://x.com/i/web/status/${parent.id}`, `https://x.com/${parent.handle.slice(1)}/status/${parent.id}` ].includes(parent.sourceUrl) &&
        typeof parent.text === "string" && parent.text.length <= 12000) {
      context.set(parent.id, { id: parent.id, author: parent.handle.slice(1), text: parent.text,
        createdAtMs: at, conversationId: parent.id, references: [] });
      post.references = [{ id: parent.id, type: "replied_to" }];
      post.conversationId = parent.id;
    }
    posts.set(id, post);
  }
  // Selected-only snapshots from older monitor versions still expose quoted
  // reply context separately. They retain their narrower coverage label.
  const replies = new RegExp(String.raw`replyTo:\$R\[\d+\]=\{author:${literal},handle:${literal},id:${literal},sourceUrl:${literal},status:"complete",text:${literal}\},sourceUrl:${literal},text:${literal}`, "g");
  for (const match of monitored ? [] : html.matchAll(replies)) {
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
  for (const post of posts.values()) context.set(post.id, post);
  const signals = [...posts.values()].flatMap(post => {
    const signal = classifyPost(post, context);
    return signal ? [{ ...signal, observedVia: "codexreset" as const }] : [];
  });
  return { signals, coverage: monitored ? "codexreset-monitored-posts" : "codexreset-quoted-posts",
    examinedPosts: posts.size, latestPostAtMs: posts.size ? Math.max(...[...posts.values()].map(p => p.createdAtMs)) : null };
}

export async function fetchCodexReset(nowMs: number, fetcher: typeof fetch = fetch) {
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
  return parseCodexResetSnapshot(Buffer.concat(chunks).toString("utf8"), nowMs);
}
