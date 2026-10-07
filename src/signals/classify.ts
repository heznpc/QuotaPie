import { announcementTimeHint, parseAnnouncementTime } from "./time";
import { createHash } from "node:crypto";
import { isWatched, providerForAuthor, type PublicPost } from "./x-source";
import { bankedReset, detectBenefits, type BenefitChange, type BenefitKind, type SignalBenefit } from "./benefit-details";
export type { BenefitChange, BenefitKind, SignalBenefit } from "./benefit-details";

export type SignalState = "possible" | "announced" | "reported" | "updated" | "withdrawn";
export interface ResetSignal {
  id: string; groupId: string; fingerprint: string; author: string; sourceUrl: string;
  text: string; contextText: string | null; publishedAtMs: number;
  state: SignalState; resetKind: "banked" | "direct" | "unknown";
  timeHint: string | null; scopeHint: string | null;
  observedVia: "x-api" | "public-feed" | "codexreset" | "claudereset" | "resetradar"; targetAtMs: number | null;
  detectedAtMs?: number;
  sourcePostId?: string;
  provider?: "codex" | "claude";
  benefitKind?: BenefitKind;
  change?: BenefitChange;
  benefits?: SignalBenefit[];
}
// Audience restrictions take precedence over the reward, including saved older signals.
export function benefitCategory(text: string, fallback: ResetSignal["benefitKind"] = "reset"): NonNullable<ResetSignal["benefitKind"]> {
  if (/\bstudents?\b|\bcampus\b|\bsheerid\b|학생|재학생|대학생/i.test(text)) return "student";
  if (/\bdiscount\w*\b|\b\d+%\s+off\b|할인/i.test(text)) return "discounts";
  if (/\bhackathon\w*\b|\bchallenge\b|\breferral\b|\bcourse completion\b|\bcomplete.{0,30}course\b|해커톤|챌린지|추천인|수료/i.test(text)) return "events";
  return fallback ?? "reset";
}
function audienceBenefit(benefit: SignalBenefit, context: string): SignalBenefit {
  const evidence = benefit.change?.evidence;
  const local = evidence ? benefitCategory(evidence, benefit.kind) : benefit.kind;
  if (["student", "discounts", "events"].includes(local)) return { ...benefit, kind: local };
  // A universal benefit in its own clause is independent of a student offer
  // elsewhere. Otherwise keep the post/parent's restriction for short followups.
  const universal = evidence && /\beveryone\b|\bevery\s+(?:user|account|subscriber|plan)\b|\ball\s+(?:users|accounts|subscribers|plans)\b|\bfor\s+all\b|모든\s*(?:사용자|계정|구독자)|전체\s*(?:사용자|계정|구독자)/i.test(evidence);
  return { ...benefit, kind: universal ? local : benefitCategory(context, local) };
}
const reset = /\breset(?:s|ting|ted)?\b|\breseting\b|리셋|초기화/i;
const subject = /\bcodex\b|\bclaude\b|chatgpt\s+work|\b(?:usage|rate|weekly)\s+limits?\b|banked\s+reset/i;
const correction = /\b(?:delay(?:ed)?|postpon(?:ed|e)|moved|instead|correction|meant|pushed back)\b/i;
const withdrawal = /\b(?:no|not|won't|will not)\s+(?:be\s+)?(?:a\s+)?reset\b|\b(?:cancelled|canceled)\b/i;
const done = /\breset\s+(?:has|have)\s+been\s+(?:processed|applied)\b|\b(?:have|has|just|now|already)\s+(?:been\s+)?reset\b|(?:^|[.!]\s+)all\s+reset\s+for\s+everyone(?:\.|$)|\breset\s+(?:(?:is|all)\s+)?(?:done|complete|completed|live|propagated)\b|\bit(?:'s| is) done\b|\bbutton\s+(?:was\s+)?pressed\b/i;
const promised = /\b(?:will|we'll|i'll|going to|scheduled|landing|lands?|arriv(?:e|es)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const hint = /\b(?:button|celebrat\w*|rejoice|you know what comes next|good news|stay tuned)\b/i;
const tentative = /\b(?:maybe|might|could|possibly|perhaps|soon|in a while|stay tuned)\b/i;
const issuance = /\b(?:getting|giving|reissuing)\b.*\b(?:reset|another|one)\b/i;

export type ExclusionReason = "unwatched-author" | "no-event-evidence" | "no-reset-or-benefit-evidence";
export function classifyPost(post: PublicPost, context: Map<string, PublicPost>,
  onExcluded?: (reason: ExclusionReason, contextText: string | null) => void): ResetSignal | null {
  if (!isWatched(post.author)) { onExcluded?.("unwatched-author", null); return null; }
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
  const detectedBenefits = detectBenefits(text);
  let benefitKind = benefitCategory(text, detectedBenefits[0]?.kind ?? "reset");
  const restricted = ["student", "discounts", "events"].includes(benefitKind);
  const benefitEvidence = detectedBenefits.length > 0 || restricted && /\b(?:free|offer\w*|discount\w*|credits?|tokens?|access|off)\b|무료|할인|크레딧|토큰/i.test(text);

  const parentText = parents.map(p => p.text).join("\n");
  const contextRelevant = reset.test(parentText) && subject.test(parentText);
  const explicit = reset.test(text) && (subject.test(text) || contextRelevant || post.author.toLowerCase() === "thsottiaux");
  const reply = text.replace(/@\w+/g, "").trim();
  // A weekday or "will" somewhere in a reply can refer to unrelated work.
  // Keep short, contextual answers without borrowing the parent's certainty.
  const shortAnswer = /^(?:yes|maybe|perhaps|possibly|soon|forgot to say)(?:[.!?,]|$)/i.test(reply);
  const timeAnswer = /^(?:(?:on|by|at|around|in|landing|lands?)\s+)?(?:today|tomorrow|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm|hours?))\b/i.test(reply);
  // A contextual promise can omit "reset" while explicitly naming its
  // arrival. Require the pronoun and a time in the same short answer; a
  // weekday elsewhere in a reply is not enough to inherit the request.
  const timedFollowup = contextRelevant && reply.length <= 200 &&
    /^(?:(?:ok(?:ay)?(?:,?\s+fine)?|yes)[.!]\s*)?(?:but\s+)?it(?:['’]s|\s+is|\s+will\s+be)\s+(?:(?:also|still)\s+){0,2}(?:coming|landing|arriving)\s+(?:(?:on|by|in)\s+)?(?:today|tomorrow|midnight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?=$|[.!?,])/i.test(reply);
  const promisedFollowup = timedFollowup && !tentative.test(text) && !/\?|\b(?:not|never|won't|will not)\b/i.test(text);
  const acceptedVote = (contextRelevant || post.author.toLowerCase() === "thsottiaux" && reset.test(parentText)) && /^i accept your vote[.!]?$/i.test(reply);
  const resetChoice = post.author.toLowerCase() === "thsottiaux" && /\bor (?:a )?reset\b/i.test(text)
    && /\b(?:updates?|ship|both)\b/i.test(text);
  const followup = acceptedVote || resetChoice || contextRelevant && (done.test(text) || correction.test(text) || withdrawal.test(text) ||
    reply.length <= 200 && (shortAnswer || timeAnswer)) || timedFollowup;
  const implicit = post.author.toLowerCase() === "thsottiaux" && hint.test(text) && (subject.test(text) || contextRelevant);
  // General explanations of how resets work, and mentions of prior resets,
  // are not evidence of another reset. Raw monitored posts include both.
  const eventEvidence = done.test(text) || correction.test(text) || withdrawal.test(text) ||
    promised.test(text) || tentative.test(text) || hint.test(text) || issuance.test(text);
  if (!(explicit && eventEvidence) && !followup && !implicit && !benefitEvidence) {
    onExcluded?.(explicit ? "no-event-evidence" : "no-reset-or-benefit-evidence", parentText || null);
    return null;
  }
  // Quoting a reset request alone is insufficient to declare a reset promised.
  const state: SignalState = withdrawal.test(text) && !/\?|\bwho\s+(?:says|said)\b/i.test(text) ? "withdrawn" : correction.test(text) ? "updated"
    : done.test(text) ? "reported" : promisedFollowup || (explicit || benefitEvidence) && promised.test(text) && !/\?/.test(text) ? "announced" : benefitEvidence && !/\?|\b(?:maybe|might|could|possibly)\b/i.test(text) ? "reported" : "possible";
  const combined = `${text}\n${parentText}`;
  const resetKind = bankedReset.test(text) ? "banked"
    : /\b(?:direct|instant|automatic|system.wide|global)\b|\ball\s+reset\s+for\s+everyone\b/i.test(text) ? "direct"
    : bankedReset.test(parentText) ? "banked" : "unknown";
  const benefits = [...detectedBenefits];
  if ((explicit && eventEvidence || followup || implicit) && !benefits.some(b => b.kind === "reset" || b.kind === "resetCredits")) {
    const clauses = text.split(/(?<=[.!?])\s+|[;\n]+/);
    const evidence = clauses.find(clause => done.test(clause)) ?? clauses.find(clause => reset.test(clause)) ?? text;
    benefits.unshift({ kind: resetKind === "banked" ? "resetCredits" : "reset", change: { evidence: evidence.trim().slice(0, 800) } });
  }
  const audienceBenefits = benefits.map(benefit => audienceBenefit(benefit, combined));
  const visibleBenefits = [...new Map(audienceBenefits.map(benefit => [benefit.kind, benefit])).values()];
  benefitKind = visibleBenefits[0]?.kind ?? (resetKind === "banked" && !restricted ? "resetCredits" : benefitKind);
  const change = visibleBenefits.find(b => b.kind === benefitKind)?.change;
  const timeHint = announcementTimeHint(text);
  const scopeHint = combined.match(/\ball\s+(?:paid\s+)?(?:users|accounts|plans|subscriptions)\b|\b(?:Plus|Pro|Business|Enterprise)\b(?:\s*[,/&]\s*(?:Plus|Pro|Business|Enterprise)\b)*/i)?.[0] ?? null;
  const primaryParent = parents.find(p => isWatched(p.author) && reset.test(p.text));
  const groupId = primaryParent?.conversationId ?? (contextRelevant ? post.conversationId : post.id);
  // Linked reposts without new conditions share the same notification identity.
  const normalized = text.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim();
  const fingerprint = createHash("sha256").update(JSON.stringify([groupId, state, resetKind, timeHint, scopeHint,
    state === "updated" || state === "withdrawn" || !["reset", "resetCredits"].includes(benefitKind) ? normalized : null])).digest("hex").slice(0, 24);
  return { id: post.id, groupId, fingerprint, author: post.author,
    sourceUrl: `https://x.com/${post.author}/status/${post.id}`, text, contextText: parentText.slice(0, 3000) || null,
    publishedAtMs: post.createdAtMs, state, resetKind, provider: providerForAuthor(post.author), benefitKind,
    ...(change ? { change } : {}), ...(visibleBenefits.length > 1 ? { benefits: visibleBenefits } : {}),
    timeHint, scopeHint, observedVia: "x-api", targetAtMs: parseAnnouncementTime(timeHint ?? text, post.createdAtMs)?.targetAtMs ?? null };
}

// A source post can announce several independent changes. Stable per-benefit
// identities prevent a reset-credit notification from swallowing a limit boost.
// Leave single-benefit IDs unchanged for existing storage and deduplication.
export function expandBenefitSignals(signal: ResetSignal): ResetSignal[] {
  const context = `${signal.text}\n${signal.contextText ?? ""}`;
  const audienceBenefits = (signal.benefits ?? [{ kind: signal.benefitKind ?? "reset", change: signal.change }])
    .map(benefit => audienceBenefit(benefit, context));
  const benefits = [...new Map(audienceBenefits.map(benefit => [benefit.kind, benefit])).values()];
  if (benefits.length < 2) return [{ ...signal, benefitKind: benefits[0]?.kind ?? signal.benefitKind, benefits: undefined }];
  return benefits.map(benefit => ({ ...signal, sourcePostId: signal.sourcePostId ?? signal.id,
    id: `${signal.id}:${benefit.kind}`, groupId: `${signal.groupId}:${benefit.kind}`,
    fingerprint: createHash("sha256").update(`${signal.fingerprint}:${benefit.kind}`).digest("hex").slice(0, 24),
    benefitKind: benefit.kind, change: benefit.change, benefits: undefined,
    state: ["updated", "withdrawn"].includes(signal.state) ? signal.state : benefit.state ?? signal.state,
    timeHint: benefit.change ? announcementTimeHint(benefit.change.evidence) : null,
    targetAtMs: benefit.change ? parseAnnouncementTime(benefit.change.evidence, signal.publishedAtMs)?.targetAtMs ?? null : null,
    resetKind: benefit.kind === "resetCredits" ? "banked" : benefit.kind === "reset" ? signal.resetKind === "banked" ? "direct" : signal.resetKind : "unknown",
  }));
}

// Recheck saved local classifications as well. Keep the source record in the
// database; improving a classifier must not fabricate a withdrawal or alert.
export function supportsSignal(signal: ResetSignal): boolean {
  if (["public-feed", "claudereset", "resetradar"].includes(signal.observedVia)) return true;
  const parentId = `context:${signal.id}`;
  const context = new Map<string, PublicPost>();
  if (signal.contextText) context.set(parentId, { id: parentId, author: "", text: signal.contextText,
    createdAtMs: signal.publishedAtMs, conversationId: parentId, references: [] });
  return classifyPost({ id: signal.id, author: signal.author, text: signal.text,
    createdAtMs: signal.publishedAtMs, conversationId: signal.id,
    references: signal.contextText ? [{ id: parentId, type: "replied_to" }] : [] }, context) !== null;
}
