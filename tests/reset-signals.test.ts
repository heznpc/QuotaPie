import { describe, test, expect } from "bun:test";
import { classifyPost } from "../src/signals/classify";
import { fetchXPosts, type PublicPost } from "../src/signals/x-source";
import { parsePublicFeed } from "../src/signals/public-feed";
import { ResetSignalCollector } from "../src/signals/collector";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { QuotaStorage } from "../src/storage/database";
import { DEFAULT_CONFIG } from "../src/config";
const now = Date.UTC(2026,8,8,12);
const post = (text: string, id = "100", author = "thsottiaux", references: PublicPost["references"] = []): PublicPost =>
  ({id, author, text, createdAtMs: now, conversationId: references[0]?.id ?? id, references});
const classify = (p: PublicPost, others: PublicPost[] = []) => classifyPost(p, new Map(others.map(p => [p.id,p])));
const feed = (items: unknown[]) => ({version:1, generatedAt:new Date(now).toISOString(),items});
const item = (extra = {}) => ({postId:"100",eventId:"one",sourceUrl:"https://x.com/thsottiaux/status/100",
  sourcePublishedAt:new Date(now).toISOString(),classificationQuote:"We will reset Codex usage tomorrow.",topic:"likely",...extra});

describe("reset signal classification", () => {
  test("early hints notify, unrelated posts do not", () => {
    expect(classify(post("Good news for Codex. Stay tuned."))?.state).toBe("possible");
    expect(classify(post("I had a sandwich"))).toBeNull();
    expect(classify(post("Please reset Codex", "100", "randomuser"))).toBeNull();
    expect(classify(post("Codex will reset tomorrow"))?.state).toBe("announced");
    expect(classify(post("We have reset Codex usage"))?.state).toBe("reported");
  });
  test("short replies use parents without inheriting their certainty", () => {
    const parent = post("We will reset Codex usage tomorrow");
    const reply = post("It is done", "101", "thsottiaux", [{id:"100",type:"replied_to"}]);
    expect(classify(reply)).toBeNull();
    expect(classify(reply,[parent])?.state).toBe("reported");
    expect(classify(post("Maybe", "102", "dkundel",[{id:"100",type:"quoted"}]),[parent])).toBeNull();
  });
  test("corrections and withdrawals have distinct alert identities", () => {
    const parent = post("Codex reset tomorrow");
    const ref = [{id:"100",type:"replied_to"}];
    const original = classify(parent)!;
    const correction = classify(post("Moved to Monday", "101", "thsottiaux",ref),[parent])!;
    const cancelled = classify(post("No reset tomorrow", "102", "thsottiaux",ref),[parent])!;
    expect(correction.groupId).toBe(original.groupId);
    expect(correction.state).toBe("updated");
    expect(correction.fingerprint).not.toBe(original.fingerprint);
    expect(cancelled.state).toBe("withdrawn");
  });
  test("same linked confirmation is deduplicated across authors", () => {
    const parent = post("We have reset Codex usage");
    const copy = post("We have reset Codex usage", "101", "reach_vb",[{id:"100",type:"quoted"}]);
    expect(classify(copy,[parent])?.fingerprint).toBe(classify(parent)?.fingerprint);
  });
});

describe("public feed", () => {
  test("allowlisted X sources only, explicit relay provenance and expiry", () => {
    const rows = parsePublicFeed(feed([item(),item({sourceUrl:"https://evil.test/thsottiaux/status/100"}),item({sourceUrl:"https://x.com/imposter/status/100"})]),now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observedVia).toBe("public-feed");
    expect(rows[0]?.state).toBe("possible");
    expect(parsePublicFeed(feed([item({withdrawn:true})]),now)[0]?.state).toBe("withdrawn");
    expect(() => parsePublicFeed({...feed([]),generatedAt:new Date(now-7200_000).toISOString()},now)).toThrow("stale");
  });
  test("feed action promises remain announcements and duplicate stages collapse", () => {
    const rows = parsePublicFeed(feed([item({topic:"action"}),item({topic:"likely"})]),now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("announced");
  });
  test("store retains corrections, suppresses repeats and past schedules", () => {
    const storage = new QuotaStorage(":memory:"); const store = new ResetSignalStore(storage);
    try {
      const s = parsePublicFeed(feed([item()]),now)[0]!;
      store.save([s,s],now); expect(store.list()).toHaveLength(1); expect(store.pending(now)).toHaveLength(1);
      store.delivered(s.fingerprint); store.save([s],now); expect(store.pending(now)).toHaveLength(0);
      const updated = {...s,id:"101",fingerprint:"new",state:"updated" as const,publishedAtMs:now+1000};
      store.save([updated],now+1000); expect(store.pending(now+1000)).toHaveLength(1);
      store.save([{...updated,id:"102",fingerprint:"past",publishedAtMs:now+2000,targetAtMs:now-1}],now+2000);
      expect(store.pending(now+2000)).toHaveLength(0);
    } finally { storage.close(); }
  });
  test("collector keeps saved signals on failure and never advances cursor", async () => {
    const storage = new QuotaStorage(":memory:");const store = new ResetSignalStore(storage);
    let calls=0;
    const mock = (async () => { calls++; return calls===1 ? Response.json(feed([item()])) : new Response("secret raw error",{status:503}); }) as unknown as typeof fetch;
    const collector = new ResetSignalCollector(store,{...DEFAULT_CONFIG.resetSignals,enabled:true},mock);
    try {
      await collector.poll(true,now); expect(collector.status(now).state).toBe("ready");
      await collector.poll(false,now+1000); expect(calls).toBe(1);
      await collector.poll(true,now+300000);
      expect(store.health().cursorMs).toBe(now);
      expect(collector.status(now+300000).state).toBe("error");
      expect(store.health().error).toBe("feed-http-503");
      expect(store.list()).toHaveLength(1);
    } finally { storage.close(); }
  });
});

test("X source includes all five accounts, replies, pagination and reference lookup", async () => {
  const urls: URL[]=[];
  const user={id:"1",username:"thsottiaux"};
  const tweet=(id:string,text:string,refs:unknown[]=[])=>({id,text,author_id:"1",created_at:new Date(now).toISOString(),conversation_id:"100",referenced_tweets:refs});
  const mock=(async(input:any,init:any)=>{
    const url=new URL(input);urls.push(url);
    expect(init.headers.Authorization).toBe("Bearer fixture-token");
    if(url.pathname==="/2/tweets") return Response.json({data:[tweet("100","Codex reset tomorrow")],includes:{users:[user]}});
    if(url.searchParams.has("next_token")) return Response.json({data:[],meta:{result_count:0}});
    return Response.json({data:[tweet("101","It is done",[{id:"100",type:"replied_to"}])],includes:{users:[user]},meta:{next_token:"next"}});
  }) as unknown as typeof fetch;
  const result=await fetchXPosts("fixture-token",now-60000,mock);
  expect(urls).toHaveLength(3);
  expect(urls[0]!.searchParams.get("post.fields")).toContain("note_post");
  expect(urls[0]!.searchParams.get("query")).toContain("from:dkundel");
  expect(urls[0]!.searchParams.get("query")).not.toContain("-is:reply");
  expect(result.posts).toHaveLength(1);
  expect(classify(result.posts[0]!,result.context)?.state).toBe("reported");
});
