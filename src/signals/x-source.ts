import { readFileSync, statSync } from "node:fs";
import { resolveUserPath } from "../config";

export const WATCHED_ACCOUNTS = ["thsottiaux", "reach_vb", "dkundel", "OpenAIDevs", "OpenAI"] as const;
export interface PublicPost {
  id: string; author: string; text: string; createdAtMs: number;
  conversationId: string; references: { id: string; type: string }[];
}
export interface SourceBatch { posts: PublicPost[]; context: PublicPost[] }
const watched = new Set(WATCHED_ACCOUNTS.map(s => s.toLowerCase()));
export const isWatched = (author: string) => watched.has(author.toLowerCase());

export function readXToken(file: string): string {
  const path = resolveUserPath(file);
  const info = statSync(path);
  if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("token-file-permissions");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token || /\s/.test(token)) throw new Error("invalid-token-file");
  return token;
}

// Read every authored post, including replies. Keyword-only search loses short
// follow-ups such as "It is done" and "moved to tomorrow".
export async function fetchXPosts(token: string, sinceMs: number, fetcher: typeof fetch = fetch): Promise<SourceBatch> {
  const all = new Map<string, PublicPost>();
  const primary = new Set<string>();
  const users = new Map<string, string>();
  async function request(path: string, params: Record<string, string>) {
    const url = new URL(path, "https://api.x.com");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`x-http-${response.status}`);
    // No response body, request headers, or credentials ever enter error logs.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("x-empty-response");
    let size = 0; const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2_000_000) { await reader.cancel(); throw new Error("x-response-too-large"); }
      chunks.push(value);
    }
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("x-invalid-response"); }
    if (!body || typeof body !== "object" || !body.meta && !Array.isArray(body.data) || body.errors?.length) {
      throw new Error("x-incomplete-response");
    }
    for (const user of body.includes?.users ?? []) {
      if (typeof user.id === "string" && typeof user.username === "string") users.set(user.id, user.username);
    }
    for (const item of [...(body.includes?.posts ?? body.includes?.tweets ?? []), ...(body.data ?? [])]) {
      const text = item.note_post?.text ?? item.note_tweet?.text ?? item.text;
      const author = users.get(item.author_id);
      const at = Date.parse(item.created_at);
      if (!/^\d{1,30}$/.test(item.id) || !author || typeof text !== "string" || !Number.isFinite(at)) continue;
      all.set(item.id, { id: item.id, author, text: text.slice(0, 12000), createdAtMs: at,
        conversationId: /^\d{1,30}$/.test(item.conversation_id) ? item.conversation_id : item.id,
        references: (item.referenced_posts ?? item.referenced_tweets ?? []).filter((r: any) => /^\d{1,30}$/.test(r.id) && ["replied_to", "quoted", "retweeted"].includes(r.type)) });
    }
    return body;
  }
  const fields = { "post.fields": "created_at,conversation_id,note_post",
    expansions: "author_id,referenced_posts", "user.fields": "username" };
  let next: string | undefined;
  for (let page = 0; page < 5; page++) {
    const body = await request("/2/tweets/search/recent", { ...fields,
      query: `(${WATCHED_ACCOUNTS.map(a => `from:${a}`).join(" OR ")}) -is:retweet`,
      start_time: new Date(sinceMs).toISOString(), max_results: "100", ...(next ? { next_token: next } : {}) });
    for (const item of body.data ?? []) primary.add(item.id);
    next = body.meta?.next_token;
    if (!next) break;
  }
  if (next) throw new Error("x-pagination-limit"); // Do not advance past unread posts.
  // Bounded context lookup, including conversation roots. A third-party parent
  // is context only; it can never become a first-party announcement.
  for (let depth = 0; depth < 2; depth++) {
    const missing = [...new Set([...all.values()].flatMap(p => [p.conversationId, ...p.references.map(r => r.id)]))]
      .filter(id => !all.has(id));
    if (!missing.length) break;
    if (missing.length > 100) throw new Error("x-context-limit");
    await request("/2/tweets", { ...fields, ids: missing.join(",") });
  }
  return { posts: [...primary].map(id => all.get(id)).filter((p): p is PublicPost => !!p && isWatched(p.author)), context: [...all.values()] };
}
