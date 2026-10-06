export type BenefitKind = "reset" | "resetCredits" | "credits" | "limits" | "student" | "discounts" | "events";
export interface BenefitChange {
  before?: number;
  after?: number;
  percent?: number;
  amount?: number;
  unit?: string;
  evidence: string;
}
export interface SignalBenefit { kind: BenefitKind; change?: BenefitChange; state?: "announced" | "reported" }

export const bankedReset = /\bbanked\b|reset\s+(?:cards?|credits?|tokens?)|resets?\s+to\s+use\s+(?:anytime|later)|리셋권|초기화권/i;
const grant = /\b(?:get(?:s|ting)?|receiv\w*|grant\w*|giv(?:e|es|ing|en)|add(?:ed|ing)?|allocat\w*|award\w*|issu\w*|reissu\w*|offer\w*|top(?:ped)?\s+up|free|bonus)\b|추가|지급|제공|충전|할당/i;
const uncertainty = /\b(?:maybe|might|could|possibly|perhaps|feels?\s+like|seems?\s+like|suspect|guess|anecdot\w*)\b|체감|같습니다|추정|아마/i;
const negation = /\b(?:not|never|no longer|won't|will not|isn't|aren't|didn't|hasn't|haven't)\b|증가하지|추가하지|지급하지/i;
const number = String.raw`\d[\d,]*(?:\.\d+)?(?:\s*[kmb](?![a-z]))?`;
const units = String.raw`credits?|tokens?|messages?|requests?|resets?|크레딧|토큰|메시지|요청|회|개`;

function quantity(value: string | undefined): number | undefined {
  if (!value) return;
  const match = value.replaceAll(",", "").trim().match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return;
  const multipliers: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
  const result = Number(match[1]) * (multipliers[match[2]?.toLowerCase() ?? ""] ?? 1);
  return Number.isFinite(result) ? result : undefined;
}
function normalizedUnit(value: string | undefined): string | undefined {
  if (!value) return;
  if (/credits?|크레딧/i.test(value)) return "credits";
  if (/tokens?|토큰/i.test(value)) return "tokens";
  if (/messages?|메시지/i.test(value)) return "messages";
  if (/requests?|요청/i.test(value)) return "requests";
  if (/resets?/i.test(value)) return "resets";
  return value;
}

function changeFor(text: string, kind: BenefitKind): BenefitChange {
  const result: BenefitChange = { evidence: text.trim().slice(0, 800) };
  const transition = text.match(new RegExp(String.raw`\bfrom\s+(${number})\s*(${units})?\s+to\s+(${number})\s*(${units})?`, "i"))
    ?? text.match(new RegExp(String.raw`(${number})\s*(${units})?\s*(?:→|->|에서)\s*(${number})\s*(${units})?`, "i"));
  if (transition) {
    result.before = quantity(transition[1]); result.after = quantity(transition[3]);
    result.unit = normalizedUnit(transition[4] ?? transition[2]);
    if (result.before != null && result.after != null && result.before > 0) {
      result.percent = Math.round((result.after / result.before - 1) * 10000) / 100;
    }
  }
  if (kind === "limits") {
    const percent = text.match(/\b(\d+(?:\.\d+)?)\s*%/);
    const multiplier = text.match(/\b(\d+(?:\.\d+)?)\s*(?:x|times)\b|\b(\d+(?:\.\d+)?)\s*배/i);
    if (result.percent == null) {
      if (percent) result.percent = Number(percent[1]);
      else if (multiplier) result.percent = Math.round((Number(multiplier[1] ?? multiplier[2]) - 1) * 10000) / 100;
      else if (/\bdoubl\w*\b|두\s*배/i.test(text)) result.percent = 100;
      else if (/\btripl\w*\b|세\s*배/i.test(text)) result.percent = 200;
    }
  } else {
    const count = text.match(new RegExp(String.raw`(${number})\s*(?:additional\s+|extra\s+|free\s+|bonus\s+|banked\s+)*(${kind === "resetCredits" ? "resets?|reset\\s+(?:cards?|credits?|tokens?)|리셋권|초기화권" : "credits?|tokens?|크레딧|토큰"})`, "i"));
    if (count) { result.amount = quantity(count[1]); result.unit = kind === "resetCredits" ? "resets" : normalizedUnit(count[2]); }
    else if (kind === "resetCredits" && /\b(?:a|one|another)\s+(?:(?:additional|extra|free|banked)\s+)*(?:reset|one)\b|리셋권\s*한\s*개/i.test(text)) {
      result.amount = 1; result.unit = "resets";
    }
  }
  return result;
}

// Work at sentence/clause scope: a speed improvement elsewhere in a release
// post must not hide an independent allowance increase, or supply its amount.
function clauses(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|[;\n]+|\s+(?:and|while|but)\s+(?=(?:we|everyone|all|paid|users|subscribers|you|our|the)\b)/i)
    .map(value => value.trim()).filter(Boolean);
}

export function detectBenefits(text: string): SignalBenefit[] {
  const benefits: SignalBenefit[] = [];
  for (const clause of clauses(text)) {
    if (uncertainty.test(clause) || negation.test(clause) || /\?/.test(clause)) continue;
    const state = /\b(?:will|going to|scheduled|landing|coming|tomorrow)\b|예정|내일부터|지급할|제공할/i.test(clause) ? "announced" : "reported";
    const banked = bankedReset.test(clause);
    const completedReset = /\b(?:have|has|just|now|already)\s+(?:been\s+)?reset\b|\ball\s+reset\s+for\s+everyone\b|\breset\s+(?:(?:is|all)\s+)?(?:done|complete|completed|live|propagated)\b|(?:리셋|초기화).{0,12}(?:완료|시행)/i;
    if (!banked && completedReset.test(clause) && /\b(?:codex|claude|usage|weekly|limits?|everyone)\b|사용량|한도/i.test(clause)) {
      benefits.push({ kind: "reset", state: "reported", change: { evidence: clause.slice(0, 800) } });
    }
    if (banked && (grant.test(clause) || state === "announced")) benefits.push({ kind: "resetCredits", state, change: changeFor(clause, "resetCredits") });
    // A reset credit is a reset entitlement, never spendable token credit.
    const spendable = clause.replace(/\breset\s+(?:cards?|credits?|tokens?)\b/gi, "");
    if (/\b(?:credits?|tokens?)\b|크레딧|토큰/i.test(spendable) && grant.test(spendable)
      && !/\b(?:context|token\s+(?:support|logging|counter|counting|tracking|display)|(?:tokens?|credits?)\s+(?:spent|consumed|used|charged))\b|컨텍스트|문맥|토큰\s*(?:소모|사용량|계산)/i.test(spendable)) {
      benefits.push({ kind: "credits", state, change: changeFor(spendable, "credits") });
    }
    const capacity = /\b(?:(?:usage|rate|weekly|daily|monthly)\s+)?(?:limits?|allowances?|quotas?|capacity)\b|기본\s*제공량|사용\s*(?:가능량|한도)|이용\s*한도/i.test(clause);
    const usage = /\busage\b|사용량/i.test(clause);
    const increase = /\b(?:increas\w*|higher|doubl\w*|tripl\w*|boost\w*|rais\w*|expand\w*|grew|grown)\b|\b\d+(?:\.\d+)?\s*(?:%\s+more|x|times)\b|증가|상승|늘어|늘렸|확대|\d+(?:\.\d+)?\s*배/i.test(clause);
    const changedNumbers = /\bfrom\s+\d|\d\s*(?:→|->|에서)/i.test(clause);
    const allocation = /\b(?:we|users?|subscribers?|plans?|accounts?|get|gets|receive|give|giving|available|included|provide|provided|allow|offer|offering)\b|제공|사용\s*가능/i.test(clause);
    const otherMetric = /\b(?:speed|faster|slower|latency|throughput|context|contextual|benchmark|traffic|adoption|active\s+users?|consum\w*|spent|spending|pricing|prices?|costs?|expensive|cheaper|discount|token\s+usage|token\s+efficient|servers?|gpus?|datacent(?:er|re)s?|infrastructure|training)\b|속도|지연|문맥|컨텍스트|소모|소비|가격|할인|활성\s*사용자|토큰\s*효율|서버|데이터센터|인프라/i.test(clause);
    if ((capacity || usage && allocation) && (increase || changedNumbers) && !otherMetric) {
      const change = changeFor(clause, "limits");
      if ((change.percent == null || change.percent > 0) && (change.before == null || change.after == null || change.after > change.before)) {
        benefits.push({ kind: "limits", state, change });
      }
    }
  }
  return benefits;
}
