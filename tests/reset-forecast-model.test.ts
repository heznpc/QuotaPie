import {expect,test} from "bun:test";
import {buildForecast,intervalScore,intervalScoreBounds,evaluateForecast,temporalReplay,calibrationReport,deadlineOf} from "../src/signals/forecast-model";
import {resetEventIds,resetScope} from "../src/signals/reset-event-links";
import {ResetTimingStore} from "../src/storage/reset-timing-store";
import {QuotaStorage} from "../src/storage/database";
import {classifyPost} from "../src/signals/classify";
import {resetSignalClosed} from "../src/signals/opportunities";
import type {ResetTimingCase} from "../src/signals/timing-history";
const H=3600000,D=24*H,now=Date.parse("2026-11-05T12:00:00Z");
function row(id:string,days=0):ResetTimingCase {
 const published=now-days*D;
 return {provider:"codex",account:"a",author:"thsottiaux",signalId:id,eventId:`codex:${id}`,scope:"global",sourceUrl:"https://example.invalid",originalText:"Global reset by EOD Pacific",publishedAtMs:published,firstSeenAtMs:published,labelKnownAtMs:published,labelVersion:1,forecast:null,observation:null,status:"pending"};
}
function recovered(id:string,days:number,offset=-3*H):ResetTimingCase {
 const r=row(id,days),d=deadlineOf(r)!.targetAtMs; r.status="observed";r.observation={afterMs:d+offset-60000,byMs:d+offset,remainingBefore:35,remainingAfter:100,bucket:"weekly"};r.labelKnownAtMs=d+offset;return r;
}
const query=(current:ResetTimingCase,horizon=deadlineOf(current)!.targetAtMs)=>({signalId:current.signalId,provider:current.provider,account:current.account,bucket:"weekly",horizonAtMs:horizon,now:current.publishedAtMs,policyVersion:2});
test("deadline-relative samples preserve Pacific DST instead of copying UTC clocks",()=>{
 const current=row("current"),past=[recovered("one",7),recovered("two",8)];
 const f=buildForecast(past,current,query(current));
 expect(deadlineOf(past[0]!)!.sourceZone).toBe("PT");
 expect(f.conditionalInterval?.upperMs).toBe(deadlineOf(current)!.targetAtMs-3*H);
 expect(f.trainingEventIds).toEqual(["codex:two","codex:one"]);
 expect(f.actionProbabilityEstimate).toBeNull();expect(f.calibrationStatus).toBe("shadow");
});
test("unknown timezone never fabricates a forecast",()=>{
 const current={...row("current"),originalText:"Global reset by EOD"};
 expect(buildForecast([recovered("one",3),recovered("two",4)],current,{...query(row("x")),signalId:current.signalId}).conditionalInterval).toBeNull();
});
test("interval score charges width and retains measurement uncertainty bounds",()=>{
 expect(intervalScore(10,20,15,.2)).toBe(10);expect(intervalScore(10,20,8,.2)).toBe(30);expect(intervalScore(10,20,23,.2)).toBe(40);
 expect(intervalScoreBounds(10,20,8,12,.2)).toMatchObject({minimum:10,maximum:30,coverage:"uncertain"});
 expect(intervalScore(0,100,15,.2)).toBeGreaterThan(intervalScore(10,20,15,.2));
});
test("ambiguous outcomes stay bounds, not midpoint candidate probabilities",()=>{
 const current=row("current"),a=recovered("one",3),b=recovered("two",4);
 a.observation!.afterMs=deadlineOf(a)!.targetAtMs-H;a.observation!.byMs=deadlineOf(a)!.targetAtMs+H;
 b.observation!.afterMs=deadlineOf(b)!.targetAtMs-H;b.observation!.byMs=deadlineOf(b)!.targetAtMs+H;
 const f=buildForecast([a,b],current,query(current));
 expect(f.observationBounds).toEqual({lower:0,upper:1});expect(f.candidateProbabilityEstimate).toBeNull();expect(f.quantileAtMs).toBeNull();
});
test("short negative observation is excluded from a longer horizon and full quota does not establish a negative",()=>{
 const current=row("current"),negative=row("negative",3);negative.status="non-occurrence";
 negative.negativeEvidence={bucket:"weekly",method:"provider-reset-epoch",resetEpoch:"epoch",detectableFromMs:negative.publishedAtMs,detectableUntilMs:deadlineOf(negative)!.targetAtMs-H,knownAtMs:negative.publishedAtMs+D};
 const f=buildForecast([negative,{...row("full",4),status:"unobserved"}],current,query(current));expect(f.sampleCount).toBe(0);expect(f.candidateProbabilityEstimate).toBeNull();
});
test("linked posts count once; equal-timestamp unlinked recoveries are ambiguous",()=>{
 const current=row("current"),a=recovered("one",3),b={...a,signalId:"duplicate"};
 expect(buildForecast([a,b],current,query(current)).sampleCount).toBe(1);
 expect(buildForecast([a,{...b,eventId:"codex:unlinked"}],current,query(current)).sampleCount).toBe(0);
});
test("late-ingested past labels cannot leak into chronological replay",()=>{
 const current=row("current"),a=recovered("one",3),late={...recovered("late",4),firstSeenAtMs:now+H,labelKnownAtMs:now+H};
 const outcome={...current,status:"observed" as const,labelVersion:2,labelKnownAtMs:now+D,observation:{afterMs:now+H,byMs:now+2*H,bucket:"weekly",remainingBefore:20,remainingAfter:100}};
 const replay=temporalReplay([a,late,current,outcome],[query(current)]);
 expect(replay[0]!.forecast.trainingEventIds).toEqual(["codex:one"]);
 expect(replay[0]!.kind).toBe("retrospective-replay");
});
test("horizon-crossing observation yields no Brier label; updates do not add independent event weight",()=>{
 const current=row("current"),f=buildForecast([recovered("one",3)],current,query(current));
 const outcome={...current,status:"observed" as const,labelKnownAtMs:now+2*D,observation:{afterMs:f.horizonAtMs-H,byMs:f.horizonAtMs+H,remainingBefore:30,remainingAfter:100,bucket:"weekly"}};
 expect(evaluateForecast(f,outcome)?.brier).toBeNull();
 expect(calibrationReport(Array.from({length:100},(_,i)=>({...f,id:`${i}`})),[outcome],now+3*D).validated).toBe(false);
});
function signal(id:string,text:string,refs:string[]=[]) {return classifyPost({id,text,author:"thsottiaux",createdAtMs:now,conversationId:id,references:refs.map(id=>({id,type:"replied_to" as const}))},new Map())!;}
test("deterministic source linking requires explicit same-scope references",()=>{
 const a=signal("1","Global reset will land by EOD PST"),b=signal("2","Global reset will land by EOD PST"),c=signal("3","Global reset will land by EOD PST",["1"]);
 const ids=resetEventIds([a,b,c]);expect(ids.get("1")).toBe(ids.get("3"));expect(ids.get("1")).not.toBe(ids.get("2"));
 const targeted=signal("4","Pro reset will land by EOD PST",["1"]);expect(resetScope(targeted)).not.toBe(resetScope(a));expect(resetEventIds([a,targeted]).get("4")).not.toBe(ids.get("1"));
});
test("unrelated same-author completion cannot close announcement",()=>{
 const a=signal("1","Global reset will land by EOD PST"),done={...signal("2","Global reset is done"),state:"reported" as const};
 const competing=signal("3","Global reset will land by EOD PST");
 expect(resetSignalClosed(a,[a,competing,done],[],now)).toBe(false);
 expect(resetSignalClosed(a,[a,{...done,relatedSourceIds:["1"]}],[],now)).toBe(true);
});
test("immutable forecast publication survives reopen and repeated inputs deduplicate",()=>{
 const db=new QuotaStorage(":memory:"),store=new ResetTimingStore(db),s=signal("1","Global reset will land by EOD PST");
 try {store.sync([s],[],[{provider:"codex",account:"a"}],now);const current=store.list()[0]!;
 const q=query(current),first=store.issueForecast(q)!;expect(first).not.toBeNull();expect(store.issueForecast({...q,now:now+1000})).toEqual(first);
 expect(new ResetTimingStore(db).listForecasts().filter(f=>f.policyVersion===2)).toHaveLength(1);
 expect(store.labelsKnownAt(now-1)).toHaveLength(0);expect(store.labelsKnownAt(now)).toHaveLength(1);
 expect(()=>store.recordNonOccurrence("codex","a",current.signalId,{bucket:"weekly",method:"provider-reset-epoch",resetEpoch:"",detectableFromMs:now,detectableUntilMs:now+H,knownAtMs:now+H})).toThrow();
 }finally{db.close();}
});

test("timezone-free EOD uses separate publication-elapsed evidence without inferring author timezone",()=>{
 const current={...row("current"),originalText:"Global reset by EOD"};
 const history=[3,4].map(days=>{const r={...row(String(days),days),originalText:current.originalText};return {...r,status:"observed" as const,observation:{bucket:"weekly",afterMs:r.publishedAtMs+2*H-60000,byMs:r.publishedAtMs+2*H,remainingBefore:20,remainingAfter:100}};});
 const f=buildForecast([...history,recovered("explicit-zone",5)],current,{...query(row("q")),signalId:current.signalId,horizonAtMs:now+4*H});
 expect(f.anchorBasis).toBe("publication-elapsed");expect(f.sampleCount).toBe(2);expect(f.conditionalInterval?.upperMs).toBe(now+2*H);expect(f.actionProbabilityEstimate).toBeNull();
});

test("existing timing rows gain scope and independent identity without losing observations",()=>{
 const db=new QuotaStorage(":memory:"),store=new ResetTimingStore(db);
 try {
   for(const sample of [recovered("old-one",3),recovered("old-two",4)]) {
     delete sample.scope;delete sample.eventId;delete sample.labelKnownAtMs;delete sample.labelVersion;
     db.db.run("INSERT INTO reset_timing_cases(provider,account,signal_id,published_ms,payload) VALUES(?,?,?,?,?)",[sample.provider,sample.account,sample.signalId,sample.publishedAtMs,JSON.stringify(sample)]);
   }
   const current=signal("current","Global reset will land by EOD Pacific");
   store.sync([current],[],[{provider:"codex",account:"a"}],now);
   expect(store.list().filter(r=>r.observation)).toHaveLength(2);
   expect(store.list().every(r=>r.scope==="reset:direct:global:unspecified")).toBe(true);
   expect(store.issueForecast({...query(row("current")),horizonAtMs:deadlineOf(row("current"))!.targetAtMs})?.sampleCount).toBe(2);
 }finally{db.close();}
});

test("later weekly recovery is retained after an earlier short-bucket recovery",()=>{
 const db=new QuotaStorage(":memory:"),store=new ResetTimingStore(db);
 const s=signal("current","Global reset will land by EOD PST");
 const makeEvent=(bucket:string,at:number,windowSeconds:number)=>({provider:"codex" as const,account:"a",bucket,kind:"external_relief" as const,severity:"info" as const,confidence:"high" as const,displayText:"",occurredAtMs:at,
   details:{previousObservedAtMs:at-60000,usedPercentBefore:75,usedPercentAfter:0,previousQuality:"authoritative",nextQuality:"authoritative",previousSource:"official",nextSource:"official",previousWindowSeconds:windowSeconds,nextWindowSeconds:windowSeconds}});
 try {
   store.sync([s],[makeEvent("codex:primary:300",now+H,18000)],[{provider:"codex",account:"a"}],now+H);
   expect(store.list()[0]!.observation?.bucket).toBe("codex:primary:300");
   store.sync([s],[makeEvent("codex:secondary:10080",now+2*H,604800)],[{provider:"codex",account:"a"}],now+2*H);
   expect(store.list()[0]!.observations?.map(o=>o.bucket).sort()).toEqual(["codex:primary:300","codex:secondary:10080"]);
   expect(store.list()[0]!.observation?.bucket).toBe("codex:secondary:10080");
 }finally{db.close();}
});

test("actual Codex duration-suffixed buckets match weekly and short scopes",async()=>{
 const {resetScopeMatchesBucket,resetBucketWindow}=await import("../src/signals/reset-event-links");
 const {isWeeklyResetBucket}=await import("../src/signals/opportunities");
 expect(resetBucketWindow("codex:secondary:10080")).toBe("weekly");
 expect(resetBucketWindow("codex:primary:300")).toBe("short");
 expect(resetScopeMatchesBucket("reset:direct:global:weekly","codex:secondary:10080")).toBe(true);
 expect(resetScopeMatchesBucket("reset:direct:global:weekly","codex:primary:300")).toBe(false);
 expect(resetScopeMatchesBucket("reset:direct:global:short","codex:primary:300")).toBe(true);
 expect(isWeeklyResetBucket("codex:secondary:10080")).toBe(true);
 expect(isWeeklyResetBucket("seven_day")).toBe(true);
 expect(isWeeklyResetBucket("codex:primary:300")).toBe(false);
});

test("weekly announcements admit actual weekly windows and do not authorize short-only work",async()=>{
 const {resetOpportunities}=await import("../src/signals/opportunities");
 const weekly=signal("weekly","Global weekly reset will land by EOD PST");
 expect(resetOpportunities([weekly],[],"codex","a",now,{bucket:"codex:secondary:10080"})).toHaveLength(1);
 expect(resetOpportunities([weekly],[],"codex","a",now,{bucket:"codex:primary:300"})).toHaveLength(0);
});

test("fully spelled standard/daylight zones preserve explicit fixed offsets",async()=>{
 const {endOfDayBoundary}=await import("../src/signals/time");
 const summer=Date.parse("2026-07-15T12:00:00Z");
 expect(endOfDayBoundary("Global reset by EOD Pacific Standard Time",summer)?.targetAtMs).toBe(Date.parse("2026-07-16T08:00:00Z"));
 expect(endOfDayBoundary("Global reset by EOD Pacific",summer)?.targetAtMs).toBe(Date.parse("2026-07-16T07:00:00Z"));
});
