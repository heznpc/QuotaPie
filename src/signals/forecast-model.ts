import { createHash } from "node:crypto";
import type { ResetTimingCase } from "./timing-history";
import { endOfDayBoundary, parseAnnouncementTime } from "./time";

export const MODEL_VERSION = "deadline-offset-empirical-v2";
export const modelParameters = { candidateEstimator: "laplace-definite-outcomes", sampling: "wilson-95", minTimingSamples: 2,
  minCalibrationEvents: 20, calibrationBins: 5, maxCalibrationError: 0.15, intervalAlpha: 0.2 } as const;
export const deadlineOf = (row: ResetTimingCase) => parseAnnouncementTime(row.originalText, row.publishedAtMs) ?? endOfDayBoundary(row.originalText, row.publishedAtMs);
export const eventIdOf = (row: ResetTimingCase) => row.eventId ?? `${row.provider}:${row.signalId}`;
export const scopeOf = (row: ResetTimingCase) => row.scope ?? "global";
export function forecastAnchor(row:ResetTimingCase) {
  const schedule=deadlineOf(row);
  const form=/\bEOD\b|end of (?:the )?day/i.test(row.originalText)?"eod":/\btomorrow\b/i.test(row.originalText)?"tomorrow":/\btoday\b/i.test(row.originalText)?"today":"unscheduled";
  return schedule?{atMs:schedule.targetAtMs,basis:"source-deadline" as const,cohort:form}:{atMs:row.publishedAtMs,basis:"publication-elapsed" as const,cohort:form};
}
export type ForecastQuery = { signalId: string; provider: ResetTimingCase["provider"]; account: string; bucket: string;
  horizonAtMs: number; now: number; policyVersion?: number; policyId?:string; historyDays?:number; earlyResetQuantile?: number };
export interface ForecastPublication {
  id: string; eventId: string; signalId: string; provider: ResetTimingCase["provider"]; account: string; bucket: string; scope: string; author:string; cohort:string;
  issuedAtMs: number; horizonAtMs: number; modelVersion: string; dataCutoffMs:number; policyVersion?: number; policyId?:string; anchorBasis: "source-deadline" | "publication-elapsed";
  estimand: "announced-account-bucket-recovery-by-horizon"; timingCondition: "recovered-by-horizon";
  parameters: typeof modelParameters; trainingEventIds: string[]; trainingLabelVersions: number[];
  inputVersion: string; observationBounds: { lower: number; upper: number } | null;
  candidateProbabilityEstimate: number | null; actionProbabilityEstimate: number | null;
  samplingInterval: { lower: number; upper: number; method: "wilson-95" } | null;
  sampleCount: number; excludedCount: number; calibrationStatus: "insufficient-data" | "shadow" | "validated";
  conditionalInterval: { lowerMs: number; upperMs: number; alpha: number } | null;
  quantileAtMs: number | null; quantileBounds: { lowerMs: number; upperMs: number; quantile: number } | null;
  evaluationRole: "first-valid" | "update"; retrospective: boolean;
  baselines: { lastEventProbability: number | null; historicalFrequency: number | null; medianOffsetMs: number | null };
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
function quantile(values: number[], p: number): number { const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.max(0, Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1))]!; }
function wilson(successes:number,n:number) { const z=1.959963984540054, p=successes/n, d=1+z*z/n, c=(p+z*z/(2*n))/d,
  r=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return {lower:Math.max(0,c-r),upper:Math.min(1,c+r),method:"wilson-95" as const}; }

/** A sample is one independent event for one account/bucket. Never interpolate
 * ambiguous recovery times into fictitious observed instants or infer negatives
 * from an idle/full quota counter. */
export function forecastSamples(history: ResetTimingCase[], current: ResetTimingCase, query: ForecastQuery) {
  const anchor=forecastAnchor(current),deadline=anchor.atMs;
  const offset=query.horizonAtMs-deadline;
  const groups=new Map<string,ResetTimingCase[]>(); let excluded=0;
  for(const row of history) {
    if(row.provider!==current.provider || row.account!==current.account || scopeOf(row)!==scopeOf(current) ||
      row.author.toLowerCase()!==current.author.toLowerCase() || forecastAnchor(row).basis!==anchor.basis || forecastAnchor(row).cohort!==anchor.cohort || (row.contextAtMs??0)!==(current.contextAtMs??0) ||
      eventIdOf(row)===eventIdOf(current)) continue;
    if(query.historyDays!=null&&query.now-row.publishedAtMs>query.historyDays*86400000 || row.firstSeenAtMs>query.now || (row.labelKnownAtMs??row.firstSeenAtMs)>query.now || row.publishedAtMs>=current.publishedAtMs ||
      row.linkStatus==="ambiguous" || !["observed","non-occurrence"].includes(row.status)) {excluded++;continue;}
    const id=eventIdOf(row); groups.set(id,[...(groups.get(id)??[]),row]);
  }
  const samples: {row:ResetTimingCase;outcome:0|1|null;low?:number;high?:number}[]=[];
  for(const rows of groups.values()) {
    const row=rows[0]!, d=forecastAnchor(row).atMs;
    const o=row.observations?.find(o=>o.bucket===query.bucket)??row.observation;
    if(row.status==="non-occurrence") {
      if(row.negativeEvidence?.bucket===query.bucket && row.negativeEvidence.detectableUntilMs>=d+offset && row.negativeEvidence.detectableFromMs<=row.publishedAtMs && row.negativeEvidence.knownAtMs<=query.now)
        samples.push({row,outcome:0}); else excluded++;
    } else if(o && o.bucket===query.bucket && o.byMs<=query.now) {
      // If several unlinked announcements claim the same account recovery,
      // neither gets independent-event weight.
      if([...groups.values()].some(other=>other!==rows && other.some(r=>r.observation?.byMs===o.byMs && r.observation?.afterMs===o.afterMs && r.observation?.bucket===o.bucket))) {excluded++;continue;}
      const low=o.afterMs-d, high=o.byMs-d;
      samples.push({row,low,high,outcome:high<=offset?1:low>=offset?0:null});
    } else excluded++;
  }
  return {samples:samples.sort((a,b)=>a.row.publishedAtMs-b.row.publishedAtMs),excluded};
}
export function buildForecast(history:ResetTimingCase[], current:ResetTimingCase, query:ForecastQuery):ForecastPublication {
  if(query.historyDays!=null&&(!Number.isInteger(query.historyDays)||query.historyDays<1||query.historyDays>3650))throw new Error("invalid history window");
  if(!Number.isFinite(query.now)||!Number.isFinite(query.horizonAtMs)||query.horizonAtMs<=query.now) throw new Error("forecast horizon must be after issue time");
  const {samples,excluded}=forecastSamples(history,current,query), n=samples.length, definite=samples.filter(s=>s.outcome!==null), positives=definite.filter(s=>s.outcome===1).length;
  const candidate=definite.length ? (positives+1)/(definite.length+2) : null;
  const anchor=forecastAnchor(current),deadline=anchor.atMs;
  // Conditional timing uses a single set of definite recoveries by this query
  // horizon; never connect independently censored horizon ratios into a CDF.
  const recovered=samples.filter(s=>s.outcome===1&&s.low!=null&&s.high!=null);
  const lows=recovered.map(s=>s.low!), highs=recovered.map(s=>s.high!);
  const p=query.earlyResetQuantile??0.1;
  if(!(p>0&&p<1)) throw new Error("invalid early reset quantile");
  const conditionalInterval=deadline!=null&&recovered.length>=modelParameters.minTimingSamples ? {
    lowerMs:deadline+quantile(lows,0.1),upperMs:deadline+quantile(highs,0.9),alpha:0.2}:null;
  const qb=deadline!=null&&recovered.length>=modelParameters.minTimingSamples ? {lowerMs:deadline+quantile(lows,p),upperMs:deadline+quantile(highs,p),quantile:p}:null;
  const inputVersion=hash({current:{provider:current.provider,account:current.account,event:eventIdOf(current),text:current.originalText,known:current.firstSeenAtMs,label:current.labelVersion??1},
    labels:samples.map(s=>[eventIdOf(s.row),s.row.labelVersion??1,s.row.labelKnownAtMs,s.outcome,s.low,s.high]),horizon:query.horizonAtMs,policy:query.policyVersion,policyId:query.policyId,historyDays:query.historyDays,bucket:query.bucket,p,model:MODEL_VERSION});
  return {id:`forecast-${inputVersion}`,eventId:eventIdOf(current),signalId:current.signalId,provider:current.provider,account:current.account,bucket:query.bucket,scope:scopeOf(current),author:current.author.toLowerCase(),cohort:anchor.cohort,
    issuedAtMs:query.now,horizonAtMs:query.horizonAtMs,modelVersion:MODEL_VERSION,dataCutoffMs:query.now,policyVersion:query.policyVersion,policyId:query.policyId,anchorBasis:anchor.basis,parameters:modelParameters,inputVersion,
    estimand:"announced-account-bucket-recovery-by-horizon",timingCondition:"recovered-by-horizon",trainingEventIds:samples.map(s=>eventIdOf(s.row)),
    trainingLabelVersions:samples.map(s=>s.row.labelVersion??1),observationBounds:n?{lower:positives/n,upper:(positives+samples.filter(s=>s.outcome===null).length)/n}:null,
    candidateProbabilityEstimate:candidate,actionProbabilityEstimate:null,samplingInterval:definite.length?wilson(positives,definite.length):null,
    sampleCount:n,excludedCount:excluded,calibrationStatus:candidate==null?"insufficient-data":"shadow",conditionalInterval,
    quantileAtMs:qb?.lowerMs??null,quantileBounds:qb,evaluationRole:"first-valid",retrospective:(current.observations??(current.observation?[current.observation]:[])).some(o=>o.bucket===query.bucket)||query.now<current.firstSeenAtMs,
    baselines:{lastEventProbability:definite.at(-1)?.outcome??null,historicalFrequency:definite.length?positives/definite.length:null,
      medianOffsetMs:lows.length?quantile(lows,0.5):null}};
}
export function intervalScore(lower:number,upper:number,y:number,alpha:number):number {
  if(!(alpha>0&&alpha<1)||![lower,upper,y].every(Number.isFinite)||lower>upper) throw new Error("invalid scoring interval");
  return upper-lower+2/alpha*Math.max(0,lower-y,y-upper);
}
export function intervalScoreBounds(lower:number,upper:number,after:number,by:number,alpha:number) {
  if(after>by) throw new Error("invalid observation interval");
  const closest=Math.max(after,Math.min(by,lower));
  return {minimum:intervalScore(lower,upper,closest,alpha),maximum:Math.max(intervalScore(lower,upper,after,alpha),intervalScore(lower,upper,by,alpha)),
    observationWidthMs:by-after,coverage:after>=lower&&by<=upper?"contained":by<lower||after>upper?"outside":"uncertain"};
}
export function evaluateForecast(f:ForecastPublication,row:ResetTimingCase) {
  if(f.retrospective || f.eventId!==eventIdOf(row)||f.account!==row.account||row.linkStatus==="ambiguous") return null;
  const o=row.observations?.find(o=>o.bucket===f.bucket)??row.observation;
  let outcome:0|1|null=null;
  if(o&&o.bucket===f.bucket&&f.issuedAtMs<o.afterMs) outcome=o.byMs<=f.horizonAtMs?1:o.afterMs>=f.horizonAtMs?0:null;
  else if(row.status==="non-occurrence"&&row.negativeEvidence?.bucket===f.bucket&&row.negativeEvidence.detectableUntilMs>=f.horizonAtMs&&row.negativeEvidence.detectableFromMs<=f.issuedAtMs) outcome=0;
  const interval=f.conditionalInterval&&o&&o.bucket===f.bucket&&f.issuedAtMs<o.afterMs&&o.byMs<=f.horizonAtMs ? intervalScoreBounds(f.conditionalInterval.lowerMs,f.conditionalInterval.upperMs,o.afterMs,o.byMs,f.conditionalInterval.alpha):null;
  return {forecastId:f.id,eventId:f.eventId,outcome,brier:outcome!=null&&f.candidateProbabilityEstimate!=null?(f.candidateProbabilityEstimate-outcome)**2:null,
    lastEventBrier:outcome!=null&&f.baselines.lastEventProbability!=null?(f.baselines.lastEventProbability-outcome)**2:null,
    baselineBrier:outcome!=null&&f.baselines.historicalFrequency!=null?(f.baselines.historicalFrequency-outcome)**2:null,interval,
    leadTimeMinMs:o?o.afterMs-f.issuedAtMs:null,leadTimeMaxMs:o?o.byMs-f.issuedAtMs:null};
}

/** Fixed chronological split; the last third is held out. A model is only
 * actionable for the exact provider/account/bucket/scope cohort validated here.
 * Updating labels or predictions does not add event weight. */
export function calibrationReport(publications:ForecastPublication[], cases:ResetTimingCase[], beforeMs:number) {
  const first=new Map<string,{f:ForecastPublication;e:NonNullable<ReturnType<typeof evaluateForecast>>}>();
  for(const f of [...publications].sort((a,b)=>a.issuedAtMs-b.issuedAtMs)) {
    if(f.issuedAtMs>=beforeMs||f.evaluationRole!=="first-valid"||f.modelVersion!==MODEL_VERSION||first.has(f.eventId))continue;
    const row=cases.find(r=>eventIdOf(r)===f.eventId&&r.provider===f.provider&&r.account===f.account&& (r.labelKnownAtMs??Infinity)<beforeMs);
    if(!row)continue; const e=evaluateForecast(f,row); if(e?.brier!=null&&e.baselineBrier!=null)first.set(f.eventId,{f,e});
  }
  const all=[...first.values()], selectionCount=Math.floor(all.length*2/3), heldout=all.slice(selectionCount);
  const bins=Array.from({length:5},(_,i)=>{const rows=heldout.filter(x=>Math.min(4,Math.floor(x.f.candidateProbabilityEstimate!*5))===i);
    return {from:i/5,to:(i+1)/5,count:rows.length,predicted:rows.length?rows.reduce((s,x)=>s+x.f.candidateProbabilityEstimate!,0)/rows.length:null,
      observed:rows.length?rows.reduce((s,x)=>s+x.e.outcome!,0)/rows.length:null};});
  const error=heldout.length?bins.reduce((s,b)=>s+b.count*Math.abs((b.predicted??0)-(b.observed??0)),0)/heldout.length:null;
  const differences=heldout.map(x=>x.e.brier!-x.e.baselineBrier!);
  const mean=differences.length?differences.reduce((a,b)=>a+b,0)/differences.length:null;
  // Resample independent events, never individual posts or repeated forecasts.
  // The deterministic seed makes reported percentile intervals reproducible.
  let seed=0x6d2b79f5;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const bootstrap=Array.from({length:differences.length?1000:0},()=>differences.reduce(sum=>sum+differences[Math.floor(random()*differences.length)]!,0)/differences.length).sort((a,b)=>a-b);
  const improvementBounds=bootstrap.length?{lower:quantile(bootstrap,.025),upper:quantile(bootstrap,.975),method:"event-bootstrap-percentile-95" as const}:null;
  return {selectionCount,heldoutCount:heldout.length,eventIds:heldout.map(x=>x.f.eventId),bins,calibrationError:error,improvementBounds,
    validated:heldout.length>=modelParameters.minCalibrationEvents&&error!=null&&error<=modelParameters.maxCalibrationError&&improvementBounds!=null&&improvementBounds.upper<0&&bins.every(b=>b.count===0||b.count>=5)};
}

/** Research replay is explicitly separate from prospective publications. Each
 * query sees only labels that were ingested by that time; later-known old posts
 * cannot appear in the training set. Event-wide exclusion happens in samples. */
export function temporalReplay(labels:ResetTimingCase[], queries:ForecastQuery[]) {
  return [...queries].sort((a,b)=>a.now-b.now).flatMap(query=>{
    const known=new Map<string,ResetTimingCase>();
    for(const row of [...labels].sort((a,b)=>(a.labelVersion??1)-(b.labelVersion??1))) {
      if(row.firstSeenAtMs<=query.now&&(row.labelKnownAtMs??row.firstSeenAtMs)<=query.now)
        known.set(JSON.stringify([row.provider,row.account,row.signalId]),row);
    }
    const current=[...known.values()].find(r=>r.signalId===query.signalId&&r.provider===query.provider&&r.account===query.account);
    if(!current||current.observation||current.status!=="pending")return [];
    const forecast=buildForecast([...known.values()],current,query);
    const outcome=[...labels].filter(r=>eventIdOf(r)===eventIdOf(current)&&r.provider===current.provider&&r.account===current.account)
      .sort((a,b)=>(b.labelVersion??1)-(a.labelVersion??1))[0];
    return [{kind:"retrospective-replay" as const,forecast,evaluation:outcome?evaluateForecast(forecast,outcome):null}];
  });
}
