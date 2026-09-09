import { createHash } from "node:crypto";
import { isWatched, type PublicPost } from "./x-source";

export type SignalState = "possible" | "announced" | "reported" | "updated" | "withdrawn";
export interface ResetSignal {
  id: string; groupId: string; fingerprint: string; author: string; sourceUrl: string;
  text: string; contextText: string | null; publishedAtMs: number;
  state: SignalState; resetKind: "banked" | "direct" | "unknown";
  timeHint: string | null; scopeHint: string | null;
  observedVia: "x-api" | "public-feed"; targetAtMs: number | null;
}
const reset = /\breset(?:s|ting|ted)?\b|\breseting\b/i;
const subject = /\bcodex\b|chatgpt\s+work|\b(?:usage|rate|weekly)\s+limits?\b|banked\s+reset/i;
const correction = /\b(?:delay(?:ed)?|postpon(?:ed|e)|moved|instead|correction|meant|pushed back)\b/i;
const withdrawal = /\b(?:no|not|won't|will not)\s+(?:be\s+)?(?:a\s+)?reset\b|\b(?:cancelled|canceled)\b/i;
const done = /\b(?:have|has|just|now|already)\s+(?:been\s+)?reset\b|\breset\s+(?:is\s+)?(?:done|complete|completed|live|propagated)\b|\bit(?:'s| is) done\b|\bbutton\s+(?:was\s+)?pressed\b/i;
const promised = /\b(?:will|we'll|i'll|going to|scheduled|lands?|arriv(?:e|es)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const hint = /\b(?:button|celebrat\w*|rejoice|you know what comes next|good news|stay tuned)\b/i;

export function classifyPost(post: PublicPost, context: Map<string, PublicPost>): ResetSignal | null {
  if (!isWatched(post.author)) return null;
  const parents: PublicPost[] = [];
  const seen = new Set([post.id]);
  function visit(id: string, depth: number) {
    const parent = context.get(id);
    if (!parent || seen.has(id) || depth > 4) return;
    seen.add(id); parents.push(parent);
    for (const ref of parent.references) visit(ref.id, depth + 1);
  }
  for (const ref of post.references) visit(ref.id, 0);
  if (post.conversationId !== post.id) visit(post.conversationId, 0);
  const text = post.text;
  const parentText = parents.map(p => p.text).join("\n");
  const contextRelevant = reset.test(parentText) && subject.test(parentText);
  const explicit = reset.test(text) && (subject.test(text) || contextRelevant || post.author.toLowerCase() === "thsottiaux");
  const followup = contextRelevant && (done.test(text) || promised.test(text) || correction.test(text) || withdrawal.test(text) || /\byes\b|forgot to say/i.test(text));
  const implicit = post.author.toLowerCase() === "thsottiaux" && hint.test(text) && (subject.test(text) || contextRelevant);
  if (!explicit && !followup && !implicit) return null;
  // Quoting a reset request alone is insufficient to declare a reset promised.
  const state: SignalState = withdrawal.test(text) ? "withdrawn" : correction.test(text) ? "updated"
    : done.test(text) ? "reported" : explicit && promised.test(text) && !/\?/.test(text) ? "announced" : "possible";
  const combined = `${text}\n${parentText}`;
  const resetKind = /\bbanked\b|reset\s+(?:card|credit|token)/i.test(text) ? "banked"
    : /\b(?:direct|instant|automatic|system.wide)\b/i.test(text) ? "direct"
    : /\bbanked\b|reset\s+(?:card|credit|token)/i.test(parentText) ? "banked" : "unknown";
  const timeHint = text.match(/[^.!?\n]*(?:\btomorrow\b|\btoday\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|PST|PDT|PT|UTC)\b|\bin\s+(?:~\s*)?(?:\d+|one|an?)\s+hours?\b)[^.!?\n]*/i)?.[0]?.trim().slice(0, 300) ?? null;
  const scopeHint = combined.match(/\ball\s+(?:paid\s+)?(?:users|accounts|plans|subscriptions)\b|\b(?:Plus|Pro|Business|Enterprise)(?:\s*[,/&]\s*(?:Plus|Pro|Business|Enterprise))*/i)?.[0] ?? null;
  const primaryParent = parents.find(p => isWatched(p.author) && reset.test(p.text));
  const groupId = primaryParent?.conversationId ?? (contextRelevant ? post.conversationId : post.id);
  // Linked reposts without new conditions share the same notification identity.
  const normalized = text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim();
  const fingerprint = createHash("sha256").update(JSON.stringify([groupId, state, resetKind, timeHint, scopeHint,
    state === "updated" || state === "withdrawn" ? normalized : null])).digest("hex").slice(0, 24);
  return { id: post.id, groupId, fingerprint, author: post.author,
    sourceUrl: `https://x.com/${post.author}/status/${post.id}`, text, contextText: parentText.slice(0, 3000) || null,
    publishedAtMs: post.createdAtMs, state, resetKind, timeHint, scopeHint, observedVia: "x-api", targetAtMs: null };
}
