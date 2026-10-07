import { classifyPost, type ExclusionReason } from "./classify";
import type { PublicPost } from "./x-source";

export interface PostReview {
  id: string;
  author: string;
  text: string;
  publishedAtMs: number;
  contextText: string | null;
  missingContext: boolean;
  reason: ExclusionReason | null;
  source: "x-api" | "codexreset";
}

export function reviewPost(post: PublicPost, context: Map<string, PublicPost>, source: PostReview["source"]) {
  let reason: ExclusionReason | null = null;
  let contextText: string | null = null;
  const signal = classifyPost(post, context, (why, text) => { reason = why; contextText = text; });
  const required = [...post.references.map(r => r.id), ...(post.conversationId !== post.id ? [post.conversationId] : [])];
  const review: PostReview = { id: post.id, author: post.author, text: post.text, publishedAtMs: post.createdAtMs,
    contextText, missingContext: required.some(id => !context.has(id)), reason, source };
  return { signal, review };
}
