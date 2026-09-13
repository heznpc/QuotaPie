import { expect, test } from "bun:test";
import { parseCodexResetPage, parseCodexResetSnapshot } from "../src/signals/codexreset-source";
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
const monitoredPost = (text: string, at: number, id = "100", extra = {}) => ({
  id, handle: "@thsottiaux", text, createdAt: new Date(at).toISOString(),
  sourceUrl: `https://x.com/thsottiaux/status/${id}`, classification: "irrelevant", ...extra,
});
const monitoredPage = (posts: unknown[]) => `<script id="$tsr-stream-barrier">activeSignals:[],monitoredPosts:${JSON.stringify(posts)}</script>`;

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
    : failed ? new Response("private error",{status:503}) : new Response(monitoredPage([
      monitoredPost("Codex reset tomorrow",now-4*86400000), monitoredPost("Unrelated new post",now,"101")
    ]))) as typeof fetch;
  const collector=new ResetSignalCollector(store,{enabled:true,tokenFile:null,pollSeconds:300},fetcher);
  try {
    await collector.poll(true,now);
    expect(collector.status(now).state).toBe("ready");
    const first=collector.status(now).sources.find(s=>s.id==="codexreset")!;
    expect(first.latestPublishedAtMs).toBe(now-4*86400000);
    expect(first.newEvidenceCount).toBe(1);
    expect(first.coverage).toBe("codexreset-monitored-posts");
    expect(first.examinedPosts).toBe(2);
    expect(first.latestPostAtMs).toBe(now);
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
  const server=startDashboard(service,config, { compactionRoot: new URL("fixtures/no-relays", import.meta.url).pathname });
  const origin=`http://127.0.0.1:${server.port}`;
  const now=Date.now(); let text="Codex reset is landing by midnight today";
  const fetcher=(async(input:any)=> String(input).includes("resetbeacon") ? Response.json(emptyFeed(now))
    : new Response(monitoredPage([monitoredPost(text,now)]))) as typeof fetch;
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
  const html=monitoredPage([monitoredPost("Meant 2pm obviously",now,"101", {
    replyTo: {author:"Tibo",handle:"@thsottiaux",id:"100",sourceUrl:"https://x.com/i/web/status/100",status:"complete",text:"Codex reset tomorrow"}
  }), monitoredPost("Codex reset tomorrow",now-1000,"100")]);
  const correction=parseCodexResetPage(html,now).find(s=>s.id==="101")!;
  expect(correction.state).toBe("updated"); expect(correction.groupId).toBe("100");
  expect(parseCodexResetPage(page("Who says it won't reset in a while 👀",now),now)[0]?.state).toBe("possible");
  expect(parseCodexResetPage(page("Reset all propagated. Sweet dreams.",now),now)[0]?.scopeHint).toBeNull();
});

test("monitor selection and scores cannot hide raw announcements, corrections or withdrawals", () => {
  const now=Date.now();
  const parent = {handle:"@thsottiaux",id:"100",sourceUrl:"https://x.com/i/web/status/100",status:"complete",text:"Codex reset tomorrow"};
  const snapshot=parseCodexResetSnapshot(monitoredPage([
    monitoredPost("Codex reset tomorrow",now),
    monitoredPost("Meant 2pm obviously",now+1000,"101",{replyTo:parent}),
    monitoredPost("Cancelled",now+2000,"102",{replyTo:parent}),
    monitoredPost("Unrelated update",now+3000,"103"),
    monitoredPost("Codex reset tomorrow",now,"104",{handle:"@imposter",sourceUrl:"https://x.com/imposter/status/104"}),
  ]),now+3000);
  expect(snapshot.signals.map(s=>s.state)).toEqual(["announced","updated","withdrawn"]);
  expect(snapshot.signals.map(s=>s.groupId)).toEqual(["100","100","100"]);
  expect(snapshot.examinedPosts).toBe(4);
  expect(snapshot.latestPostAtMs).toBe(now+3000);
  expect(snapshot.coverage).toBe("codexreset-monitored-posts");
});

test("monitor data accepts shared references and reordered fields without executing script", () => {
  const now=Date.now();
  const html=`<script id="$tsr-stream-barrier">activeSignals:$R[1]=[
    $R[2]={author:$R[3]={username:"thsottiaux",priority:!0},sourceUrl:"https://x.com/thsottiaux/status/100",text:"Codex reset tomorrow",id:"100",createdAt:"${new Date(now).toISOString()}"},
    $R[4]={id:"101",text:"Codex reset cancelled",createdAt:"${new Date(now).toISOString()}",sourceUrl:"https://x.com/thsottiaux/status/101",author:$R[3]}],monitoredPosts:[]</script>`;
  expect(parseCodexResetPage(html,now).map(s=>s.state)).toEqual(["announced","withdrawn"]);
  expect(parseCodexResetSnapshot(monitoredPage([]),now).examinedPosts).toBe(0);
  expect(()=>parseCodexResetPage(html.replace('priority:!0','priority:globalThis.process.exit()'),now)).toThrow("monitor-schema-changed");
  expect(()=>parseCodexResetPage(html.replace('monitoredPosts:[]','monitoredPosts:[{unknown:"schema"}]'),now)).toThrow("monitor-schema-changed");
  expect(()=>parseCodexResetPage(html.replace('author:$R[3]}','author:$R[999]}'),now)).toThrow("monitor-schema-changed");
  expect(parseCodexResetPage(monitoredPage([monitoredPost('unrelated text \\" monitoredPosts:[malicious]',now)]),now)).toHaveLength(0);
});

test("raw posts distinguish general discussion and unrelated follow-ups from grounded possibilities", () => {
  const now=Date.now();
  const replyTo={handle:"@thsottiaux",id:"100",sourceUrl:"https://x.com/i/web/status/100",status:"complete",text:"Codex reset tomorrow"};
  const signal=(text:string)=>parseCodexResetPage(monitoredPage([monitoredPost(text,now,"101",{replyTo})]),now)[0];
  for(const text of [
    "There is no difference between usage you get before or after a reset.",
    "You forgot the part where I reset usage twice in the middle",
    "There is no schedule, only resets",
    "Excellent service for existing Codex users includes the occasional reset",
    "And the team will have some nice sleep now. See you next week for some more ships.",
  ]) expect(signal(text)).toBeUndefined();
  expect(signal("Maybe")?.state).toBe("possible");
  expect(signal("Around 2pm")?.timeHint).toBe("Around 2pm");
  expect(signal("Landing 2:30pm PST")?.timeHint).toBe("Landing 2:30pm PST");
  expect(signal("Who says it won't reset in a while 👀")?.state).toBe("possible");
  expect(signal("Everyone affected by banked resets not applying is getting another one")?.resetKind).toBe("banked");
});

test("saved classifier false positives no longer display or alert, while their source records are retained", () => {
  const now=Date.now();const storage=new QuotaStorage(":memory:");const store=new ResetSignalStore(storage);
  try {
    const valid=parseCodexResetPage(page("Codex reset tomorrow",now),now)[0]!;
    const unsupported={...valid,id:"101",fingerprint:"old-classifier-general-discussion",
      text:"There is no difference between usage you get before or after a reset.",state:"possible" as const};
    store.save([unsupported,valid],now);
    expect(store.list().map(s=>s.id)).toEqual(["100"]);
    expect(store.pending(now).map(s=>s.id)).toEqual(["100"]);
    expect(storage.db.query<{count:number},[]>("SELECT COUNT(*) AS count FROM reset_signals").get()?.count).toBe(2);
  } finally {storage.close()}
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
