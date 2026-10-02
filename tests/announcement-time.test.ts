import { expect, test } from "bun:test";
import { parseAnnouncementTime, localAnnouncementTime } from "../src/signals/time";
import { classifyPost } from "../src/signals/classify";
import { signalDecision } from "../src/signals/presentation";
import { QuotaStorage } from "../src/storage/database";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { parsePublicFeed } from "../src/signals/public-feed";

const published = Date.parse("2026-10-02T02:14:51Z"); // Still Oct 1 in Pacific time.
const text = "Global reset landing tomorrow 10am PST for all paid ChatGPT accounts.";
const post = { id: "123", author: "thsottiaux", text, createdAtMs: published, conversationId: "123", references: [] };
const expected = Date.parse("2026-10-02T18:00:00Z"); // Oct 3, 03:00 KST.

test("tomorrow is resolved on the author's calendar; literal PST differs from PDT/PT", () => {
  expect(parseAnnouncementTime(text, published)?.targetAtMs).toBe(expected);
  expect(parseAnnouncementTime(text.replace("PST", "PDT"), published)?.targetAtMs).toBe(expected - 3600_000);
  expect(parseAnnouncementTime(text.replace("PST", "PT"), published)?.targetAtMs).toBe(expected - 3600_000);
  expect(parseAnnouncementTime("January 3, 2027 at 10am PT", published)?.targetAtMs).toBe(Date.parse("2027-01-03T18:00:00Z"));
  expect(parseAnnouncementTime("2026-10-02 23:30 UTC", published)?.targetAtMs).toBe(Date.parse("2026-10-02T23:30:00Z"));
});

test("unknown dates/zones, ambiguous clocks and DST gaps remain unresolved", () => {
  for (const value of ["tomorrow 10am", "10am PST", "midnight today PST", "tomorrow 10am CST", "tomorrow 13pm PST",
    "tomorrow 10am PST or 11am PST", "2026-02-30 10am PST", "March 8, 2026 2:30am PT", "November 1, 2026 1:30am PT"])
    expect(parseAnnouncementTime(value, published)).toBeNull();
  expect(parseAnnouncementTime("November 1, 2026 1:30am PST", published)).not.toBeNull();
});

test("notification conversion honors user zone independently of language and keeps source time", () => {
  const signal = classifyPost(post, new Map())!;
  expect(signal.targetAtMs).toBe(expected);
  const korean = signalDecision(signal, "ko", "Asia/Seoul").message;
  expect(korean).toContain("10월 3일"); expect(korean).toContain("3:00"); expect(korean).toContain("KST");
  expect(korean).toContain("10am PST"); expect(korean).not.toContain("미확인");
  const english = localAnnouncementTime(signal, "en", "America/New_York")!;
  expect(english).toContain("Oct 2"); expect(english).toContain("2:00 PM");
  expect(localAnnouncementTime({ ...signal, text: "by tomorrow 10am PST", timeHint: "by tomorrow 10am PST" }, "ko", "Asia/Seoul")).toContain("까지");
  expect(localAnnouncementTime({ ...signal, text: "around tomorrow 10am PST", timeHint: "around tomorrow 10am PST" }, "en", "Europe/London")).toContain("Around");
});

test("existing saved news and relay estimates use explicit post timezone without replay", () => {
  const signal = classifyPost(post, new Map())!;
  const db = new QuotaStorage(":memory:"); const store = new ResetSignalStore(db);
  try {
    store.save([{ ...signal, targetAtMs: expected - 3600_000 }], published);
    store.delivered(signal.fingerprint);
    expect(store.list()[0]!.targetAtMs).toBe(expected);
    expect(store.pending(published)).toHaveLength(0);
    const feed = parsePublicFeed({ version: 1, generatedAt: new Date(published).toISOString(), items: [{
      sourceUrl: signal.sourceUrl, sourcePublishedAt: new Date(published).toISOString(), topic: "schedule",
      classificationQuote: text, targetAt: new Date(expected - 3600_000).toISOString(),
    }] }, published);
    expect(feed[0]!.targetAtMs).toBe(expected);
  } finally { db.close(); }
});
