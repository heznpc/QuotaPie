import { expect, test } from "bun:test";
import { classifyPost } from "../src/signals/classify";
import { parseClaudeNews } from "../src/signals/claude-source";
import { signalDecision } from "../src/signals/presentation";
import { QuotaStorage } from "../src/storage/database";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { ResetSignalCollector } from "../src/signals/collector";
const now = Date.parse("2026-10-02T00:00:00Z");
const post = (text: string, author = "thsottiaux") => ({id:"123", author, text, createdAtMs:now, conversationId:"123", references:[]});

test("credit grants and allowance increases are news without reset wording", () => {
  const grant=classifyPost(post("Existing Pro subscribers will receive additional credits during the plan transition."),new Map())!;
  expect(grant).toMatchObject({provider:"codex",benefitKind:"credits",state:"announced",resetKind:"unknown"});
  expect(signalDecision(grant,"ko").title).toBe("Codex 크레딧 소식");
  expect(classifyPost(post("Claude Code usage limits increase 20% today.","ClaudeDevs"),new Map())).toMatchObject({provider:"claude",benefitKind:"limits"});
  expect(classifyPost(post("We have just reset weekly limits for everyone on Claude Max.","lydiahallie"),new Map())).toMatchObject({provider:"claude",benefitKind:"reset",state:"reported"});
  expect(classifyPost(post("What are usage credits?"),new Map())).toBeNull();
  expect(classifyPost(post("Free usage credits for everyone!","untrusted"),new Map())).toBeNull();
  expect(classifyPost(post("We are giving a banked reset to all Pro users."),new Map())?.benefitKind).toBe("reset");
});
const row={id:"124",origin:"official_post",source:"ClaudeDevs",url:"https://x.com/ClaudeDevs/status/124",ts:"2026-09-22T16:44:06Z",kind:"banked",scope:"Pro+Max+Team",summary:"Claude Code limits increase 20% today; paid subscribers get a reset to use anytime."};
const radar={status:"historic",confidence:"confirmed",impact:"positive",date:"2026-09-23T21:23:00Z",sources:[{url:"https://x.com/ClaudeDevs/status/125"}],summary:"Claude Pro and Max subscribers were offered a one-time credit for cloud sessions."};

test("Claude feeds retain source and scope without importing forecasts or untrusted links", () => {
  expect(parseClaudeNews({schema_version:1,events:[row]},"claudereset",now)[0]).toMatchObject({provider:"claude",observedVia:"claudereset",resetKind:"banked",scopeHint:"Pro+Max+Team"});
  expect(parseClaudeNews({version:"1.0.0",events:[radar]},"resetradar",now)[0]).toMatchObject({provider:"claude",observedVia:"resetradar",benefitKind:"credits"});
  expect(parseClaudeNews({version:"1.0.0",events:[{...radar,status:"projected"},{...radar,sources:[{url:"https://x.com/attacker/status/125"}]}]},"resetradar",now)).toHaveLength(0);
  expect(parseClaudeNews({schema_version:1,events:[{...row,url:"https://x.com.evil/ClaudeDevs/status/124"}]},"claudereset",now)).toHaveLength(0);
});

test("no-token collector imports Claude benefits silently then alerts once on new evidence", async () => {
  const db=new QuotaStorage(":memory:"), store=new ResetSignalStore(db);
  let current=false;
  const fetcher=(async (url: any)=> String(url).includes("claudereset.org") ? Response.json({schema_version:1,events:[row]})
    :String(url).includes("resetradar.com") ? Response.json({version:"1.0.0",events:[current?{...radar,date:new Date(now).toISOString(),sources:[{url:"https://x.com/ClaudeDevs/status/126"}]}:radar]})
    :String(url).includes("resetbeacon") ? Response.json({version:1,generatedAt:new Date(now).toISOString(),items:[]})
    :new Response('<script id="$tsr-stream-barrier">activeSignals:[],monitoredPosts:[]</script>')) as typeof fetch;
  const collector=new ResetSignalCollector(store,{enabled:true,tokenFile:null,pollSeconds:300},fetcher);
  try {
    await collector.poll(true,now);
    expect(collector.status(now).state).toBe("ready");expect(store.list()).toHaveLength(2);expect(store.pending(now)).toHaveLength(0);
    current=true;await collector.poll(true,now);
    expect(store.pending(now)).toHaveLength(1);
    const signal=store.pending(now)[0]!;expect(signalDecision(signal,"ko").title).toBe("Claude 크레딧 소식");
    store.delivered(signal.fingerprint);await collector.poll(true,now);expect(store.pending(now)).toHaveLength(0);
  } finally {db.close();}
});
