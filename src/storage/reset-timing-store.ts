import type { QuotaStorage } from "./database";
import type { ResetSignal } from "../signals/classify";
import type { Provider, QuotaEvent } from "../types";
import { isTimingAnnouncement, timingEvaluation, timingForecast, timingObservation, type ResetTimingCase } from "../signals/timing-history";
import { buildForecast, calibrationReport, deadlineOf, evaluateForecast, eventIdOf, type ForecastPublication, type ForecastQuery } from "../signals/forecast-model";
import { resetEventIds, resetScope, explicitlyRelated, resetBucketWindow } from "../signals/reset-event-links";
const DAY = 86_400_000;

/** Durable local evidence survives the public-feed retention window. No model,
 * notification, quota policy or conversation is invoked by this store. */
export class ResetTimingStore {
  private retentionDays = 365;
  constructor(private storage: QuotaStorage) {}
  setRetentionDays(days: number) { if(!Number.isInteger(days)||days<1||days>3650)throw new Error("invalid timing history retention"); this.retentionDays=days; }
  listForecasts(): ForecastPublication[] {
    return this.storage.db.query<{payload:string},[]>("SELECT payload FROM reset_forecast_publications ORDER BY issued_ms,id").all().map(r=>JSON.parse(r.payload));
  }
  issueForecast(query:ForecastQuery): ForecastPublication | null {
    const rows=this.list(),current=rows.find(r=>r.signalId===query.signalId&&r.provider===query.provider&&r.account===query.account);
    if(!current||!["pending","unobserved","observed"].includes(current.status)||current.firstSeenAtMs>query.now||
      (current.observations??(current.observation?[current.observation]:[])).some(o=>o.bucket===query.bucket))return null;
    const candidate=buildForecast(rows,current,query), old=this.listForecasts();
    const existing=old.find(f=>f.id===candidate.id); if(existing)return existing;
    candidate.evaluationRole=old.some(f=>f.eventId===candidate.eventId&&f.account===candidate.account&&f.bucket===candidate.bucket&&f.policyVersion===candidate.policyVersion&&f.policyId===candidate.policyId)?"update":"first-valid";
    const comparable=old.filter(f=>f.provider===candidate.provider&&f.account===candidate.account&&f.bucket===candidate.bucket&&f.scope===candidate.scope&&f.anchorBasis===candidate.anchorBasis&&f.author===candidate.author&&f.cohort===candidate.cohort);
    const report=calibrationReport(comparable,rows,query.now);
    if(report.validated){candidate.calibrationStatus="validated";candidate.actionProbabilityEstimate=candidate.candidateProbabilityEstimate;}
    this.storage.db.run("INSERT OR IGNORE INTO reset_forecast_publications(id,event_id,issued_ms,payload) VALUES(?,?,?,?)",[candidate.id,candidate.eventId,candidate.issuedAtMs,JSON.stringify(candidate)]);
    return candidate;
  }
  recordExecutionDecision(forecastId:string,policyVersion:number,now:number) {
    const f=this.listForecasts().find(f=>f.id===forecastId);
    if(!f||f.issuedAtMs>now||f.policyVersion!==policyVersion)throw new Error("forecast decision mismatch");
    this.storage.db.run("INSERT OR IGNORE INTO reset_forecast_actions(forecast_id,policy_version,decided_ms) VALUES(?,?,?)",[forecastId,policyVersion,now]);
  }
  correctEventLink(provider:Provider, signalIds:string[], eventId:string, knownAtMs:number) {
    if(!eventId.startsWith(`${provider}:`)||!signalIds.length||!Number.isFinite(knownAtMs))throw new Error("invalid event correction");
    const rows=this.list().filter(r=>r.provider===provider&&signalIds.includes(r.signalId));
    if(!rows.length||rows.some(r=>r.firstSeenAtMs>knownAtMs)||new Set(rows.map(r=>r.scope)).size>1)throw new Error("incompatible event correction");
    this.storage.transaction(()=>{for(const row of rows){row.eventId=eventId;row.eventLinkOverride=eventId;row.linkStatus="resolved";if(row.status==="ambiguous")row.status=row.observation?"observed":"unobserved";
      row.labelVersion=(row.labelVersion??1)+1;row.labelKnownAtMs=knownAtMs;this.saveLabel(row);this.saveRow(row);}});
  }
  recordCoverage(input:{id:string;provider:Provider;account:string;bucket:string;observedAtMs:number;success:boolean;resetDetectable:boolean;resetEpoch?:string}) {
    if(!Number.isFinite(input.observedAtMs)||!input.id||!input.bucket)throw new Error("invalid coverage");
    this.storage.db.run("INSERT OR IGNORE INTO reset_observation_coverage(id,provider,account,observed_ms,payload) VALUES(?,?,?,?,?)",[input.id,input.provider,input.account,input.observedAtMs,JSON.stringify(input)]);
  }
  /** Only verified provider epoch evidence may establish a negative. Mere
   * passage of time or successful/full quota samples must never call this. */
  recordNonOccurrence(provider:Provider,account:string,signalId:string,evidence:NonNullable<ResetTimingCase["negativeEvidence"]>) {
    if(!evidence.resetEpoch||evidence.method!=="provider-reset-epoch"||evidence.detectableUntilMs<=evidence.detectableFromMs||evidence.knownAtMs<evidence.detectableUntilMs)throw new Error("invalid negative evidence");
    const row=this.list().find(r=>r.provider===provider&&r.account===account&&r.signalId===signalId);
    if(!row||row.observation||row.linkStatus==="ambiguous"||evidence.detectableFromMs>row.publishedAtMs)throw new Error("negative evidence cannot identify this event");
    row.negativeEvidence=evidence;row.status="non-occurrence";row.labelKnownAtMs=evidence.knownAtMs;row.labelVersion=(row.labelVersion??1)+1;
    this.storage.transaction(()=>{this.saveLabel(row);this.saveRow(row);});
  }
  private saveRow(row:ResetTimingCase) {
    this.storage.db.run(`INSERT INTO reset_timing_cases(provider,account,signal_id,published_ms,payload)
      VALUES(?,?,?,?,?) ON CONFLICT(provider,account,signal_id) DO UPDATE SET payload=excluded.payload`,
      [row.provider,row.account,row.signalId,row.publishedAtMs,JSON.stringify(row)]);
  }
  private saveLabel(row:ResetTimingCase) {
    this.storage.db.run("INSERT OR IGNORE INTO reset_timing_labels(case_key,known_ms,version,payload) VALUES(?,?,?,?)",
      [JSON.stringify([row.provider,row.account,row.signalId]),row.labelKnownAtMs??row.firstSeenAtMs,row.labelVersion??1,JSON.stringify(row)]);
  }
  labelsKnownAt(now:number):ResetTimingCase[] {
    const rows=this.storage.db.query<{case_key:string,payload:string},[number]>("SELECT case_key,payload FROM reset_timing_labels WHERE known_ms <= ? ORDER BY version").all(now);
    const latest=new Map<string,ResetTimingCase>();for(const r of rows)latest.set(r.case_key,JSON.parse(r.payload));return [...latest.values()];
  }
  list(): ResetTimingCase[] {
    return this.storage.db.query<{ payload: string }, []>("SELECT payload FROM reset_timing_cases ORDER BY published_ms DESC").all()
      .map(r => JSON.parse(r.payload));
  }
  sync(signals: ResetSignal[], events: QuotaEvent[], accounts: { provider: Provider; account: string; contextAtMs?: number }[], now: number) {
    this.storage.transaction(() => {
      const rows = this.list();
      const prior = new Map(rows.map(r => [JSON.stringify([r.provider,r.account,r.signalId]), JSON.stringify(r)]));
      const eventIds=resetEventIds(signals);
      for(const row of rows) {
        row.eventId=row.eventLinkOverride??eventIds.get(row.signalId)??row.eventId??`${row.provider}:${row.signalId}`;
        row.scope??=resetScope({text:row.originalText,timeHint:null,resetKind:"direct"} as ResetSignal);
      }
      for(const event of events.filter(e=>["external_relief","allowance_relief"].includes(e.kind)&&e.occurredAtMs<=now)) {
        const id=JSON.stringify([event.provider,event.account,event.bucket,event.occurredAtMs,event.details.previousObservedAtMs]);
        this.storage.db.run("INSERT OR IGNORE INTO reset_account_recoveries(id,observed_ms,payload) VALUES(?,?,?)",[id,event.occurredAtMs,JSON.stringify({event,knownAtMs:now})]);
      }
      for (const s of signals.filter(isTimingAnnouncement)) for (const a of accounts) {
        if (a.provider !== (s.provider ?? "codex") || s.publishedAtMs > now || now - s.publishedAtMs > this.retentionDays * DAY) continue;
        const id = s.sourcePostId ?? s.id;
        if (!rows.some(r => r.signalId === id && r.provider === a.provider && r.account === a.account)) rows.push({
          ...a, eventId:eventIds.get(id), scope:resetScope(s), relatedSourceIds:s.relatedSourceIds, linkStatus:"resolved", labelVersion:1,labelKnownAtMs:now, signalId: id, author: s.author, sourceUrl: s.sourceUrl, originalText: s.change?.evidence ?? s.timeHint ?? s.text,
          publishedAtMs: s.publishedAtMs, firstSeenAtMs: Math.max(s.detectedAtMs ?? now, now), forecast: null, observation: null, status: "pending",
        });
      }
      for (const row of rows) {
        const schedule=deadlineOf(row);row.sourceZone=schedule?.sourceZone??null;row.sourceDeadlineMs=schedule?.targetAtMs??null;
        const context = accounts.find(a=>a.provider===row.provider&&a.account===row.account)?.contextAtMs ?? 0;
        if (context > (row.contextAtMs ?? 0) && context >= row.publishedAtMs) row.status = "context-changed";
        if (["withdrawn", "context-changed", "non-occurrence"].includes(row.status)) continue;
        const signal = signals.find(s => (s.sourcePostId ?? s.id) === row.signalId);
        const withdrawn = signals.some(s => s.state === "withdrawn" && (s.provider ?? "codex") === row.provider &&
          s.publishedAtMs <= now && (s.sourcePostId === row.signalId || s.id === row.signalId ||
            signal != null && explicitlyRelated(s,signal) && resetScope(s)===resetScope(signal)));
        if (withdrawn) { row.status = "withdrawn"; continue; }
        {
          const observations = events.filter(e => e.occurredAtMs <= now).flatMap(e => {
            const o = timingObservation(e, row); return o ? [o] : [];
          }).sort((a,b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0) || a.byMs - b.byMs);
          const merged=new Map((row.observations??(row.observation?[row.observation]:[])).map(o=>[JSON.stringify([o.bucket,o.afterMs,o.byMs]),o]));
          for(const observation of observations)merged.set(JSON.stringify([observation.bucket,observation.afterMs,observation.byMs]),observation);
          row.observations=[...merged.values()].sort((a,b)=>(b.windowSeconds??0)-(a.windowSeconds??0)||a.byMs-b.byMs);
          row.observation = row.observations[0] ?? null;
        }
        row.status = row.observation ? "observed" : now > Math.max(row.publishedAtMs + DAY,row.sourceDeadlineMs??0) ? "unobserved" : "pending";
      }
      // One recovery matching multiple unlinked announcements has unresolved
      // event attribution. Retain each source; exclude all from learning.
      for(const row of rows.filter(r=>r.observation)) {
        const o=row.observation!;
        const ambiguous=rows.some(other=>other!==row&&other.provider===row.provider&&other.account===row.account&&eventIdOf(other)!==eventIdOf(row)&&
          other.observation?.byMs===o.byMs&&other.observation?.afterMs===o.afterMs&&other.observation?.bucket===o.bucket);
        if(ambiguous){row.linkStatus="ambiguous";row.status="ambiguous";}else{row.linkStatus="resolved";if(row.status==="ambiguous")row.status="observed";}
      }
      for (const row of rows) {
        // Never manufacture a prediction for a reset already observed, or after
        // its historical estimated interval has passed. First issue is frozen.
        if (!row.forecast && row.status === "pending") {
          const forecast = timingForecast(rows, row, now);
          if (forecast && forecast.latestMs > now) row.forecast = forecast;
        }
      }
      for (const row of rows) {
        if (prior.get(JSON.stringify([row.provider,row.account,row.signalId])) === JSON.stringify(row)) continue;
        row.labelKnownAtMs=now;
        row.labelVersion=prior.has(JSON.stringify([row.provider,row.account,row.signalId]))?(row.labelVersion??1)+1:(row.labelVersion??1);
        this.saveRow(row);this.saveLabel(row);
      }
      const cutoff=now-this.retentionDays*DAY;
      this.storage.db.run("DELETE FROM reset_timing_cases WHERE published_ms < ?", [cutoff]);
      this.storage.db.run("DELETE FROM reset_observation_coverage WHERE observed_ms < ?",[cutoff]);
      this.storage.db.run("DELETE FROM reset_account_recoveries WHERE observed_ms < ?",[cutoff]);
      this.storage.db.run("DELETE FROM reset_timing_labels WHERE known_ms < ?",[cutoff]);
      this.storage.db.run("DELETE FROM reset_forecast_publications WHERE issued_ms < ?",[cutoff]);
      this.storage.db.run("DELETE FROM reset_forecast_actions WHERE decided_ms < ?",[cutoff]);
    });
    for(const row of this.list().filter(r=>["pending","observed"].includes(r.status)&&r.sourceDeadlineMs!=null&&r.sourceDeadlineMs>now)) {
      const publication=this.issueForecast({signalId:row.signalId,provider:row.provider,account:row.account,bucket:this.list().filter(r=>r.provider===row.provider&&r.account===row.account).flatMap(r=>r.observations??(r.observation?[r.observation]:[])).find(o=>o.bucket&&resetBucketWindow(o.bucket)==="weekly")?.bucket??(row.provider==="claude"?"seven_day":`${row.provider}:weekly`),horizonAtMs:row.sourceDeadlineMs!,now});
      if(publication?.conditionalInterval && (!row.forecast || row.forecast.issuedAtMs===now)) {
        row.forecast={issuedAtMs:publication.issuedAtMs,earliestMs:publication.conditionalInterval.lowerMs,latestMs:publication.conditionalInterval.upperMs,
          sampleCount:publication.sampleCount,method:"deadline-offset-empirical-v2",forecastId:publication.id,trainingEventIds:publication.trainingEventIds,alpha:publication.conditionalInterval.alpha};
        this.saveRow(row);
      }
    }
  }
  summary() {
    const cases = this.list();
    const evaluated = cases.filter(r => r.status === "observed").flatMap(r => {
      const e = timingEvaluation(r); return e ? [e] : [];
    });
    const publications=this.listForecasts();
    const firstByTarget=new Map<string,ForecastPublication>();
    for(const f of publications.filter(f=>f.evaluationRole==="first-valid")) {
      const key=JSON.stringify([f.eventId,f.provider,f.account,f.bucket]);if(!firstByTarget.has(key))firstByTarget.set(key,f);
    }
    const score=(f:ForecastPublication)=>{
      const row=cases.find(r=>eventIdOf(r)===f.eventId&&r.provider===f.provider&&r.account===f.account);
      return row?evaluateForecast(f,row):null;
    };
    const prospectiveEvaluation=[...firstByTarget.values()].map(score).filter(Boolean);
    const actions=this.storage.db.query<{forecast_id:string},[]>("SELECT forecast_id FROM reset_forecast_actions ORDER BY decided_ms").all();
    const firstAction=new Map<string,ForecastPublication>();
    for(const action of actions){const f=publications.find(f=>f.id===action.forecast_id);if(!f)continue;const key=JSON.stringify([f.eventId,f.provider,f.account,f.bucket]);if(!firstAction.has(key))firstAction.set(key,f);}
    const executionEvaluation=[...firstAction.values()].map(score).filter(Boolean);
    const coverage=this.storage.db.query<{payload:string},[]>("SELECT payload FROM reset_observation_coverage ORDER BY observed_ms DESC LIMIT 1000").all().map(r=>JSON.parse(r.payload));
    const recoveries=this.storage.db.query<{payload:string},[]>("SELECT payload FROM reset_account_recoveries ORDER BY observed_ms DESC").all().map(r=>JSON.parse(r.payload));
    return { recoveries, publications, prospectiveEvaluation, executionEvaluation, coverage, unresolvedCount:cases.filter(r=>r.linkStatus==="ambiguous").length, cases: cases.map(r => ({ ...r, evaluation: timingEvaluation(r) })),
      evaluation: { issuedCount: cases.filter(r => r.forecast).length, evaluatedCount: evaluated.length,
        overlapCount: evaluated.filter(e => e.overlaps).length,
        meanGapMs: evaluated.length ? evaluated.reduce((sum,e) => sum+e.gapMs,0)/evaluated.length : null,
        unobservedCount: cases.filter(r => r.status === "unobserved").length } };
  }
}
