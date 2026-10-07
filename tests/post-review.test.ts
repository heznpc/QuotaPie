import { expect, test } from "bun:test";
import { reviewPost } from "../src/signals/post-review";
import { QuotaStorage } from "../src/storage/database";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { ResetSignalCollector } from "../src/signals/collector";
import { DEFAULT_CONFIG } from "../src/config";
import type { PublicPost } from "../src/signals/x-source";

const now = Date.now();
const post = (text: string, id = "100"): PublicPost => ({ id, author: "thsottiaux", text,
  createdAtMs: now, conversationId: id, references: [] });

test("exclusion reasons come from the classifier and missing reply context is explicit", () => {
  expect(reviewPost(post("Codex resets every five hours."), new Map(), "x-api").review.reason).toBe("no-event-evidence");
  const reply = { ...post("Maybe", "101"), conversationId: "100", references: [{ id: "100", type: "replied_to" }] };
  const missing = reviewPost(reply, new Map(), "x-api");
  expect(missing.signal).toBeNull();
  expect(missing.review.missingContext).toBeTrue();
  expect(missing.review.reason).toBe("no-reset-or-benefit-evidence");
  const complete = reviewPost(reply, new Map([["100", post("Codex reset tomorrow")]]), "x-api");
  expect(complete.signal?.state).toBe("possible");
  expect(complete.review.reason).toBeNull();
  expect(complete.review.missingContext).toBeFalse();
});

test("persisted exclusions preserve first collection time, clear reclassified posts and expire", () => {
  const storage = new QuotaStorage(":memory:");
  try {
    const store = new ResetSignalStore(storage);
    const excluded = reviewPost(post("Sandwich today"), new Map(), "codexreset").review;
    store.saveReviews([excluded], now);
    store.saveReviews([excluded], now + 1000);
    expect(new ResetSignalStore(storage).excludedPosts(now + 1000)[0]).toMatchObject({firstSeenAtMs: now, lastSeenAtMs: now + 1000});
    store.saveReviews([{ ...excluded, reason: null }], now + 2000);
    expect(store.excludedPosts(now + 2000)).toHaveLength(0);
    store.saveReviews([excluded], now + 3000);
    expect(store.excludedPosts(now + 31 * 86400_000)).toHaveLength(0);
    expect(store.pending(now)).toHaveLength(0);
  } finally { storage.close(); }
});

test("monitor collection retains excluded originals without treating failed sources as covered", async () => {
  const storage = new QuotaStorage(":memory:");
  try {
    const store = new ResetSignalStore(storage);
    const html = `<script id="$tsr-stream-barrier">activeSignals:[],monitoredPosts:${JSON.stringify([
      {id:"100", text:"Sandwich today", createdAt: new Date(now).toISOString(), handle:"@thsottiaux", sourceUrl:"https://x.com/thsottiaux/status/100"},
      {id:"101", text:"Codex reset tomorrow", createdAt: new Date(now).toISOString(), handle:"@thsottiaux", sourceUrl:"https://x.com/thsottiaux/status/101"},
    ])}</script>`;
    const collector = new ResetSignalCollector(store, {...DEFAULT_CONFIG.resetSignals, enabled: true, tokenFile: null},
      (async (url: any) => String(url) === "https://codexreset.org/" ? new Response(html) : new Response("", {status:503})) as typeof fetch);
    await collector.poll(true, now);
    const status = collector.status(now);
    expect(status.state).toBe("partial");
    expect(status.excludedPosts.map(p => p.id)).toEqual(["100"]);
    expect(status.signals.map(p => p.id)).toEqual(["101"]);
    expect(store.pending(now).some(p => p.id === "100")).toBeFalse();
  } finally { storage.close(); }
});
