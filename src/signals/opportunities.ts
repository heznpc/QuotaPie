import type { Provider, QuotaEvent } from "../types";
import type { ResetSignal } from "./classify";
import { endOfDayBoundary, parseAnnouncementTime } from "./time";
import { recoveryEvidence } from "./correlation";
import { timingForecast, timingObservation, type ResetTimingCase } from "./timing-history";
import { explicitlyRelated, resetEventIds, resetScope, resetScopeMatchesBucket, resetBucketWindow } from "./reset-event-links";

export interface ResetOpportunity {
  signalId: string; provider: Provider; publishedAtMs: number; sourceUrl: string;
  actionableFromMs: number; expiresAtMs: number;
  calendarBoundaryMs: number | null;
  forecast: null | { earliestMs: number; latestMs: number; sampleCount: number; basis: "deadline-offset-empirical-v2" };
}
const DAY = 86400000;
const textOf = (s: ResetSignal) => s.change?.evidence ?? s.timeHint ?? s.text;
export const isWeeklyResetBucket = (bucket:string) => resetBucketWindow(bucket)==="weekly";
const reset = (s: ResetSignal) => (s.benefitKind ?? "reset") === "reset" && s.resetKind !== "banked";
// Scope is deliberately explicit. A targeted promotion is not a global reset.
const universal = (s: ResetSignal) => /\bglobal\b|\bsystem.wide\b|\beveryone\b|\ball\s+(?:users|accounts|plans|subscriptions)\b/i.test(textOf(s)) &&
  !/\b(?:paid|Plus|Pro|Business|Enterprise|Team|Free|students?)\b/i.test(textOf(s));

/** Announcements create urgency, not allowance. Forecasts retain observation
 * intervals and require independent days; they never prove causal attribution. */
export function resetOpportunities(signals: ResetSignal[], events: QuotaEvent[], provider: Provider, account: string, now: number, options: {cases?:ResetTimingCase[]; maxAgeMinutes?:number;bucket?:string} = {}): ResetOpportunity[] {
  const known = signals.filter(s => (s.provider ?? "codex") === provider && s.publishedAtMs <= now && reset(s));
  const observed = events.filter(event => event.provider === provider && event.account === account &&
    ["external_relief", "allowance_relief"].includes(event.kind) && event.occurredAtMs <= now &&
    Number(event.details.usedPercentAfter) <= 1 &&
    recoveryEvidence(event, [], now).reason === "no-public-match");
  const announcements = known.filter(s => s.state === "announced" && universal(s));
  const targetBucket=options.bucket??observed.find(e=>isWeeklyResetBucket(e.bucket))?.bucket??(provider==="claude"?"seven_day":`${provider}:weekly`);
  const maxAge=(options.maxAgeMinutes??1440)*60000;
  const ids=resetEventIds(known);
  const cases=options.cases??announcements.map(signal=>{
    const row:ResetTimingCase={provider,account,signalId:signal.sourcePostId??signal.id,eventId:ids.get(signal.sourcePostId??signal.id),scope:resetScope(signal),author:signal.author,
      originalText:textOf(signal),sourceUrl:signal.sourceUrl,publishedAtMs:signal.publishedAtMs,firstSeenAtMs:signal.detectedAtMs??signal.publishedAtMs,
      forecast:null,observation:null,status:"pending"};
    row.observation=observed.map(e=>timingObservation(e,row)).filter(o=>o&&o.bucket===targetBucket).sort((a,b)=>a!.byMs-b!.byMs)[0]??null;
    if(row.observation)row.status="observed";
    return row;
  });
  const expiry=(s:ResetSignal)=>(parseAnnouncementTime(textOf(s),s.publishedAtMs)??endOfDayBoundary(textOf(s),s.publishedAtMs))?.targetAtMs??s.publishedAtMs+maxAge;
  return announcements.filter(s => now < expiry(s) && resetScopeMatchesBucket(resetScope(s),targetBucket) && !resetSignalClosed(s, known, observed, now,targetBucket)).map(s => {
    const boundary = parseAnnouncementTime(textOf(s),s.publishedAtMs)??endOfDayBoundary(textOf(s), s.publishedAtMs);
    const row=cases.find(r=>r.signalId===(s.sourcePostId??s.id)&&r.provider===provider&&r.account===account);
    const estimate=row?timingForecast(cases,row,now):null;
    const forecast=estimate?{earliestMs:estimate.earliestMs,latestMs:estimate.latestMs,sampleCount:estimate.sampleCount,basis:"deadline-offset-empirical-v2" as const}:null;
    return { signalId: s.id, provider, publishedAtMs: s.publishedAtMs, sourceUrl: s.sourceUrl,
      // Start when announced. Waiting until a guessed deadline wastes usable quota.
      actionableFromMs: s.publishedAtMs, expiresAtMs: expiry(s),
      calendarBoundaryMs: boundary?.targetAtMs ?? null, forecast };
  });
}

/** Account observation and public completion are separate from calendar expiry. */
export function resetSignalClosed(s: ResetSignal, signals: ResetSignal[], events: QuotaEvent[], now: number, bucket = "weekly"): boolean {
  return events.some(event => event.provider === (s.provider ?? "codex") && (event.bucket === bucket || bucket === "weekly" && isWeeklyResetBucket(event.bucket)) &&
    ["external_relief", "allowance_relief"].includes(event.kind) && event.occurredAtMs <= now &&
    Number(event.details.usedPercentAfter) <= 1 && recoveryEvidence(event, [], now).reason === "no-public-match" &&
    event.occurredAtMs >= s.publishedAtMs && event.occurredAtMs <= ((parseAnnouncementTime(textOf(s),s.publishedAtMs)??endOfDayBoundary(textOf(s),s.publishedAtMs))?.targetAtMs??s.publishedAtMs+DAY)) || signals.some(other =>
    reset(other) && (other.provider ?? "codex") === (s.provider ?? "codex") &&
    other.publishedAtMs <= now && other.publishedAtMs >= s.publishedAtMs && other.id !== s.id &&
    ((explicitlyRelated(s,other) && resetScope(s) === resetScope(other)) || standaloneCompletion(s,other,signals)) &&
    ["reported", "withdrawn", "updated"].includes(other.state));
}

/** Standalone completion closes one unambiguous opportunity without merging
 * training event identities. Multiple candidate events always abstain. */
function standaloneCompletion(s:ResetSignal,other:ResetSignal,signals:ResetSignal[]):boolean {
  if(other.state!=="reported"||other.author.toLowerCase()!==s.author.toLowerCase()||other.publishedAtMs-s.publishedAtMs>DAY||
    !/\breset\b/i.test(other.text)||!/(?:\b(?:done|completed?|processed|propagated)\b|all reset for everyone)/i.test(other.text))return false;
  const scope=resetScope(other);
  if(![resetScope(s),"reset:direct:unspecified:unspecified"].includes(scope))return false;
  const candidates=signals.filter(candidate=>candidate.state==="announced"&&reset(candidate)&&
    (candidate.provider??"codex")===(s.provider??"codex")&&candidate.author.toLowerCase()===s.author.toLowerCase()&&
    candidate.publishedAtMs<=other.publishedAtMs&&other.publishedAtMs-candidate.publishedAtMs<=DAY&&
    (scope==="reset:direct:unspecified:unspecified"||resetScope(candidate)===scope));
  return new Set(candidates.map(c=>c.sourcePostId??c.id)).size===1&&candidates[0]?.id===s.id;
}
