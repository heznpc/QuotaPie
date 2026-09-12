import { expect, test } from "bun:test";
import { parseCodexResetPage } from "../src/signals/codexreset-source";
import { ResetSignalCollector } from "../src/signals/collector";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { QuotaStorage } from "../src/storage/database";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { DEFAULT_CONFIG } from "../src/config";
import { signalDecision } from "../src/signals/presentation";

const page = (text:string, at:number, id="100") => `<script id="$tsr-stream-barrier">activeSignals:[$R[1]={id:"${id}",kind:"hint",score:99,text:${JSON.stringify(text)},createdAt:"${new Date(at).toISOString()}",sourceUrl:"https://x.com/thsottiaux/status/${id}",author:$R[2]={username:"thsottiaux"}}]</script>`;
const emptyFeed = (now:number) => ({version:1,generatedAt:new Date(now).toISOString(),items:[]});

test("captures the September 12 midnight announcement without inferring timezone, certainty or unrelated model news", () => {
  const now=Date.now();
  const text="Hi Astra users. " + "Quality fixes. ".repeat(30) + "And of course, a reset is also landing by midnight today.";
  const signal=parseCodexResetPage(page(text,now),now)[0]!;
  expect(signal.state).toBe("announced");
  expect(signal.timeHint).toContain("midnight today");
  expect(signal.targetAtMs).toBeNull();
  expect(signal.observedVia).toBe("codexreset");
  expect(signalDecision(signal,"ko").message).toContain("midnight today");
  expect(signalDecision(signal,"ko").message).toContain("미확인");
  expect(parseCodexResetPage(page("Retiring a model next week",now),now)).toHaveLength(0);
  expect(()=>parseCodexResetPage('<html>OK</html>',now)).toThrow("monitor-invalid-response");
});

test("request success, partial coverage and new evidence are separate; silence alone is not failure", async () => {
  const storage=new QuotaStorage(":memory:"); const store=new ResetSignalStore(storage); const now=Date.now();
  let failed=false;
  const fetcher=(async(input:any)=> String(input).includes("resetbeacon") ? Response.json(emptyFeed(now))
    : failed ? new Response("private error",{status:503}) : new Response(page("Codex reset tomorrow",now-4*86400000))) as typeof fetch;
  const collector=new ResetSignalCollector(store,{enabled:true,tokenFile:null,pollSeconds:300},fetcher);
  try {
    await collector.poll(true,now);
    expect(collector.status(now).state).toBe("ready");
    const first=collector.status(now).sources.find(s=>s.id==="codexreset")!;
    expect(first.latestPublishedAtMs).toBe(now-4*86400000);
    expect(first.newEvidenceCount).toBe(1);
    expect(store.pending(now)).toHaveLength(0);
    await collector.poll(true,now+1000);
    const second=collector.status(now+1000).sources.find(s=>s.id==="codexreset")!;
    expect(second.state).toBe("ready"); expect(second.newEvidenceCount).toBe(0); expect(second.lastEvidenceMs).toBe(now);
    failed=true; await collector.poll(true,now+2000);
    expect(collector.status(now+2000).state).toBe("partial");
    expect(store.list()).toHaveLength(1);
    expect(JSON.stringify(collector.status(now+2000))).not.toContain("private error");
  } finally {storage.close()}
});

test("announcement, changed deadline and withdrawal travel through collection to the native notification API once each", async () => {
  const config=structuredClone(DEFAULT_CONFIG);
  config.dashboard.port=0; config.collection.codexEnabled=false;
  config.resetSignals={enabled:true,tokenFile:null,pollSeconds:300};
  config.alerts.enabled=true;config.alerts.macOSNotifications=true;config.alerts.command=null;
  const service=new QuotaPieService(config,new QuotaDatabase(":memory:"));
  const server=startDashboard(service,config);
  const origin=`http://127.0.0.1:${server.port}`;
  const now=Date.now(); let text="Codex reset is landing by midnight today";
  const fetcher=(async(input:any)=> String(input).includes("resetbeacon") ? Response.json(emptyFeed(now)) : new Response(page(text,now))) as typeof fetch;
  const collector=new ResetSignalCollector(service.resetSignals,config.resetSignals,fetcher);
  const originalPoll=service.signalCollector.poll.bind(service.signalCollector);
  // Replace only network collection; all production store, decisions, outbox and HTTP actions execute.
  service.signalCollector.poll=()=>collector.poll(true);
  const actionToken=(await (await fetch(origin+"/api/status")).json() as any).actionToken;
  const headers={"x-quotapie-action-token":actionToken};
  try {
    await fetch(origin+"/api/notifications/claim",{method:"POST",headers});
    for (const [wording,state] of [[text,"announced"],["Codex reset moved to tomorrow","updated"],["No reset tomorrow, cancelled","withdrawn"]]) {
      text=wording!;
      await service.collectResetSignals();
      const result=await (await fetch(origin+"/api/notifications/claim",{method:"POST",headers})).json() as any;
      expect(result.notification).not.toBeNull();
      expect(result.notification.presentation.title.key).toBe("signal."+state);
      const complete=await fetch(origin+`/api/notifications/${result.notification.id}/scheduled`,{method:"POST",
        headers:{...headers,"x-quotapie-notification-claim":result.notification.claimToken}});
      expect(complete.status).toBe(200);
      await service.collectResetSignals();
      expect((await (await fetch(origin+"/api/notifications/claim",{method:"POST",headers})).json() as any).notification).toBeNull();
    }
    // A lagging cached copy cannot resurrect a previously observed announcement.
    text="Codex reset is landing by midnight today";await service.collectResetSignals();
    expect(service.resetSignals.list()[0]?.state).toBe("withdrawn");
    expect(service.resetSignals.pending(Date.now())).toHaveLength(0);
  } finally {service.signalCollector.poll=originalPoll;server.stop(true);await service.close()}
});

test("adding a relay enriches old history silently, while a later same-source withdrawal still alerts", () => {
  const storage=new QuotaStorage(":memory:");const store=new ResetSignalStore(storage);const now=Date.now();
  try {
    const old=parseCodexResetPage(page("Codex reset tomorrow",now-4*86400000),now)[0]!;
    store.save([{...old,observedVia:"public-feed",fingerprint:"old-feed",text:"Relay summary of a reset"}],now);
    store.save([old],now);
    expect(store.list()[0]?.observedVia).toBe("codexreset");
    expect(store.pending(now)).toHaveLength(0);
    const revision=parseCodexResetPage(page("Codex reset cancelled",now-4*86400000),now)[0]!;
    store.save([revision],now+1000);
    expect(store.pending(now+1000).map(s=>s.state)).toEqual(["withdrawn"]);
  } finally {storage.close()}
});

test("quoted reply context retains a short correction, rhetorical hints are not withdrawals, and propagated is not Pro", () => {
  const now=Date.now();
  const html=page("Meant 2pm obviously",now,"101") + page("Codex reset tomorrow",now-1000,"100") +
    'replyTo:$R[3]={author:"Tibo",handle:"@thsottiaux",id:"100",sourceUrl:"https://x.com/i/web/status/100",status:"complete",text:"Codex reset tomorrow"},sourceUrl:"https://x.com/thsottiaux/status/101",text:"Meant 2pm obviously"';
  const correction=parseCodexResetPage(html,now).find(s=>s.id==="101")!;
  expect(correction.state).toBe("updated"); expect(correction.groupId).toBe("100");
  expect(parseCodexResetPage(page("Who says it won't reset in a while 👀",now),now)[0]?.state).toBe("possible");
  expect(parseCodexResetPage(page("Reset all propagated. Sweet dreams.",now),now)[0]?.scopeHint).toBeNull();
});

test("reclassifying identical historical wording does not create a new announcement", () => {
  const storage=new QuotaStorage(":memory:");const store=new ResetSignalStore(storage);const now=Date.now();
  try {
    const signal=parseCodexResetPage(page("Who says it won't reset in a while 👀",now-4*86400000),now)[0]!;
    store.save([{...signal,state:"withdrawn",fingerprint:"old-classifier"}],now);
    store.save([signal],now+1000);
    expect(store.list()[0]?.state).toBe("possible");
    expect(store.pending(now+1000)).toHaveLength(0);
  } finally {storage.close()}
});
