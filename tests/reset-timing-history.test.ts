import { expect, test } from "bun:test";
import { QuotaStorage } from "../src/storage/database";
import { ResetTimingStore } from "../src/storage/reset-timing-store";
import { timingForecast, timingEvaluation, type ResetTimingCase } from "../src/signals/timing-history";
import { classifyPost } from "../src/signals/classify";
import type { QuotaEvent } from "../src/types";
const DAY = 86400000, HOUR = 3600000, today = Date.parse("2026-10-13T00:00:00Z");
const a = { provider: "codex" as const, account: "fixture" };
function signal(days: number) {
  return classifyPost({ id: String(100+days), author: "thsottiaux", text: "Global reset landing by EOD PST time. Enjoy",
    createdAtMs: today-days*DAY+HOUR, conversationId: String(100+days), references: [] }, new Map())!;
}
function event(days: number, hour = 5): QuotaEvent {
  const at = today-days*DAY+hour*HOUR;
  return { ...a, bucket: "weekly", kind: "external_relief", severity: "info", confidence: "high", displayText: "", occurredAtMs: at,
    details: { previousObservedAtMs: at-60000, usedPercentBefore: 75, usedPercentAfter: 0,
      previousSource: "official", nextSource: "official", previousQuality: "authoritative", nextQuality: "authoritative",
      previousWindowSeconds: 604800, nextWindowSeconds: 604800 } };
}
test("accumulated cases issue a forecast before recovery and retain its measurable miss", () => {
  const db = new QuotaStorage(":memory:"), store = new ResetTimingStore(db);
  try {
    store.sync([signal(4),signal(2),signal(0)], [event(4),event(2)], [a], today+2*HOUR);
    const before = store.list().find(r=>r.signalId===signal(0).id)!;
    expect(before.forecast).toMatchObject({ sampleCount: 2, earliestMs: today+5*HOUR-60000, latestMs: today+5*HOUR });
    store.sync([signal(0)], [event(0,4)], [a], today+4*HOUR);
    const after = store.list().find(r=>r.signalId===signal(0).id)!;
    expect(after.forecast).toEqual(before.forecast);
    expect(after.observation).toMatchObject({ remainingBefore: 25, remainingAfter: 100 });
    expect(timingEvaluation(after)).toMatchObject({ overlaps: false, gapMs: HOUR-60000 });
    expect(new ResetTimingStore(db).summary().evaluation.evaluatedCount).toBe(1);
    store.sync([], [], [a], today+40*DAY);
    expect(store.list()).toHaveLength(3);
    expect(store.list().find(r=>r.signalId===signal(0).id)!.forecast).toEqual(before.forecast);
  } finally { db.close(); }
});
test("backfilled outcomes are not counted as predictions; missed observation is not labelled false alarm", () => {
  const db = new QuotaStorage(":memory:"), store = new ResetTimingStore(db);
  try {
    store.sync([signal(4),signal(2),signal(0)], [event(4),event(2),event(0)], [a], today+6*HOUR);
    expect(store.summary().evaluation.evaluatedCount).toBe(0);
    expect(store.summary().evaluation.issuedCount).toBe(0);
    store.sync([signal(-2)], [], [a], today+4*DAY);
    expect(store.summary().evaluation.unobservedCount).toBe(1);
  } finally { db.close(); }
});
test("wrong accounts, scheduled resets, credits, long gaps and partial recoveries never train", () => {
  const db = new QuotaStorage(":memory:"), store = new ResetTimingStore(db);
  try {
    const e=event(0);
    const bad=[{...e,account:"other"},{...e,kind:"scheduled_reset" as const},
      {...e,details:{...e.details,resetCreditDecreased:true}},
      {...e,details:{...e.details,previousObservedAtMs:e.occurredAtMs-HOUR}},
      {...e,details:{...e.details,usedPercentAfter:20}},
      {...e,details:{...e.details,nextSource:"other"}}];
    store.sync([signal(0)],bad,[a],today+6*HOUR);
    expect(store.list()[0]!.observation).toBeNull();
  } finally { db.close(); }
});
test("duplicate posts on one day cannot manufacture two independent cases; future evidence cannot leak", () => {
  const base:ResetTimingCase={...a,signalId:"1",author:"thsottiaux",sourceUrl:"https://x.com/thsottiaux/status/1",
    originalText:"Global reset by EOD",publishedAtMs:today-2*DAY+HOUR,firstSeenAtMs:today-2*DAY+HOUR,
    forecast:null,status:"observed",observation:{afterMs:today-2*DAY+5*HOUR-60000,byMs:today-2*DAY+5*HOUR,remainingBefore:25,remainingAfter:100}};
  const current={...base,signalId:"3",publishedAtMs:today+HOUR,status:"pending" as const,observation:null};
  expect(timingForecast([base,{...base,signalId:"2"}],current,today+2*HOUR)).toBeNull();
  const future={...base,publishedAtMs:today-DAY,observation:{...base.observation!,byMs:today+4*HOUR}};
  expect(timingForecast([base,future],current,today+2*HOUR)).toBeNull();
});

test("account or plan changes invalidate prior-profile learning without deleting evidence", () => {
  const db=new QuotaStorage(":memory:"),store=new ResetTimingStore(db);
  try {
    store.sync([signal(4),signal(2)], [event(4),event(2)], [a], today-HOUR);
    store.sync([signal(0)], [], [{...a,contextAtMs:today}], today+2*HOUR);
    expect(store.list().filter(r=>r.status==="context-changed")).toHaveLength(2);
    expect(store.list().find(r=>r.signalId===signal(0).id)!.forecast).toBeNull();
  } finally { db.close(); }
});

test("retained evidence calibrates a later estimate after the source's 30-day retention", () => {
  const db=new QuotaStorage(":memory:"),store=new ResetTimingStore(db);
  try {
    store.sync([signal(44),signal(42)], [event(44),event(42)], [a], today-40*DAY);
    store.sync([signal(0)], [], [a], today+2*HOUR);
    expect(store.list().find(r=>r.signalId===signal(0).id)!.forecast?.sampleCount).toBe(2);
  } finally { db.close(); }
});

test("service history reaches the status API with local time and observed remaining quota", async () => {
  const { QuotaPieService } = await import("../src/service");
  const { QuotaDatabase } = await import("../src/db");
  const { DEFAULT_CONFIG } = await import("../src/config");
  const { startDashboard } = await import("../src/server");
  const config=structuredClone(DEFAULT_CONFIG);
  config.dashboard.port=0; config.collection.codexEnabled=false; config.alerts.enabled=false;
  config.profile.locale="ko"; config.profile.timeZone="Asia/Seoul";
  config.accounts.codex=[{id:a.account,label:"Fixture",enabled:true,codexHome:"/tmp/timing-test-home"}];
  config.accounts.claude=[];
  const s=new QuotaPieService(config,new QuotaDatabase(":memory:"));
  let server: ReturnType<typeof startDashboard> | undefined;
  try {
    s.resetSignals.save([signal(0)],today+HOUR);
    const base={...a,bucket:"weekly",label:"Weekly",windowSeconds:604800,source:"codex-app-server",quality:"authoritative" as const};
    s.ingest([{...base,usedPercent:75,observedAtMs:today+5*HOUR-60000,resetsAtMs:today+4*DAY},
      {...base,usedPercent:0,observedAtMs:today+5*HOUR,resetsAtMs:today+7*DAY}]);
    s.refreshResetTiming(today+6*HOUR);
    const summarize=s.resetTiming.summary.bind(s.resetTiming);
    let summaries=0;
    s.resetTiming.summary=()=>{summaries++;return summarize();};
    server=startDashboard(s,config);
    const response=await fetch(`http://127.0.0.1:${server.port}/api/status`);
    expect(response.status).toBe(200);
    const data=await response.json() as any;
    expect(summaries).toBe(1);
    expect(data.resetTiming.cases[0].observation.remainingBefore).toBe(25);
    const row=data.resetSignals.signals.find((r:any)=>r.id===signal(0).id);
    expect(row.localTimeText).toContain("PST");
    expect(row.timingHistoryText).toContain("KST");
    expect(row.timingHistoryText).toContain("25% → 100%");
    expect(data.resetTiming.evaluation.evaluatedCount).toBe(0);
  } finally { server?.stop(true); await s.close(); }
});

test("timing measurement failure cannot throw through quota collection", async () => {
  const { QuotaPieService }=await import("../src/service");
  const { QuotaDatabase }=await import("../src/db");
  const { DEFAULT_CONFIG }=await import("../src/config");
  const { spyOn }=await import("bun:test");
  const s=new QuotaPieService(structuredClone(DEFAULT_CONFIG),new QuotaDatabase(":memory:"));
  const fail=spyOn(s.resetTiming,"sync").mockImplementation(()=>{throw new Error("fixture storage failure");});
  const log=spyOn(console,"error").mockImplementation(()=>{});
  try {
    expect(()=>s.refreshResetTiming(today)).not.toThrow();
    expect(s.resetTimingStatus().error).toBe("timing-history-update-failed");
    fail.mockRestore(); s.refreshResetTiming(today);
    expect(s.resetTimingStatus().error).toBeNull();
  } finally { fail.mockRestore(); log.mockRestore(); await s.close(); }
});

test("case evidence survives closing and reopening the database", async () => {
  const { mkdtempSync,rmSync }=await import("node:fs");
  const { tmpdir }=await import("node:os");
  const { join }=await import("node:path");
  const dir=mkdtempSync(join(tmpdir(),"timing-ledger-"));
  let db=new QuotaStorage(join(dir,"fixture.sqlite"));
  try {
    new ResetTimingStore(db).sync([signal(0)],[event(0)],[a],today+6*HOUR);
    db.close(); db=new QuotaStorage(join(dir,"fixture.sqlite"));
    expect(new ResetTimingStore(db).list()[0]!.observation?.remainingBefore).toBe(25);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});


test("historical reset observations stay out of unrelated benefits", async () => {
  const { resetTimingPresentation }=await import("../src/signals/timing-presentation");
  const db=new QuotaStorage(":memory:"),store=new ResetTimingStore(db);
  try {
    store.sync([signal(0)],[event(0)],[a],today+6*HOUR);
    const news={...signal(0),benefitKind:"credits" as const};
    expect(resetTimingPresentation(news,store.list(),"ko","Asia/Seoul",[]).timingHistoryText).toBeNull();
  } finally { db.close(); }
});

test("posts across UTC midnight for one recovery still count as one case", () => {
  const row:ResetTimingCase={...a,signalId:"a",author:"thsottiaux",sourceUrl:"https://x.com/thsottiaux/status/1",
    originalText:"Global reset by EOD PST",publishedAtMs:today-2*DAY-HOUR,firstSeenAtMs:today-2*DAY-HOUR,
    forecast:null,status:"observed",observation:{afterMs:today-2*DAY+5*HOUR-60000,byMs:today-2*DAY+5*HOUR,remainingBefore:25,remainingAfter:100}};
  const duplicate={...row,signalId:"b",publishedAtMs:today-2*DAY+HOUR};
  const current={...row,signalId:"c",publishedAtMs:today+HOUR,observation:null,status:"pending" as const};
  expect(timingForecast([row,duplicate],current,today+2*HOUR)).toBeNull();
});
