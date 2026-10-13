import { expect, test } from "bun:test";
import { parseAnnouncementTime, localAnnouncementTime, withAnnouncementTime } from "../src/signals/time";
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

const eodPublished = Date.parse("2026-10-13T01:03:59Z"); // Oct 12 in the source zone.
const eodSignal = (text: string, createdAtMs = eodPublished) => classifyPost({ ...post, text, createdAtMs }, new Map())!;

test("EOD shows the source calendar boundary in the user's zone without scheduling a reset", () => {
  const signal = eodSignal("Global reset landing by EOD PST time. Enjoy");
  const label = localAnnouncementTime(signal, "ko", "Asia/Seoul")!;
  expect(label).toContain("KST 10/13 17:00");
  expect(label).toContain("PST 10/12 EOD");
  expect(label).toContain("KST");
  expect(label.indexOf("PST")).toBeLessThan(label.indexOf("KST"));
  expect(label).toContain("시각 미정");
  expect(withAnnouncementTime(signal).targetAtMs).toBeNull();
  const notice = signalDecision(signal, "ko", "Asia/Seoul", ["계정 1 · 주간: 63% 남음"]);
  expect(notice.severity).toBe("warning");
  expect(notice.message.length).toBeLessThan(120);
  expect(notice.message).not.toContain("63% 남음");
  expect(notice.message).toContain("시각 미정");
  expect(localAnnouncementTime(signal, "en", "America/New_York")).toContain("EDT 10/13 04:00");
});

test("EOD respects explicit dates, tomorrow, source offsets and regional DST at midnight", () => {
  for (const zone of ["PT", "PDT"])
    expect(localAnnouncementTime(eodSignal(`Global reset by EOD ${zone}`), "ko", "Asia/Seoul")).toContain("16:00");
  expect(localAnnouncementTime(eodSignal("Global reset by end of day tomorrow PST"), "ko", "Asia/Seoul")).toContain("10/14 17:00");
  expect(localAnnouncementTime(eodSignal("Global reset by EOD October 14, 2026 PST"), "ko", "Asia/Seoul")).toContain("10/15 17:00");
  expect(localAnnouncementTime(eodSignal("Global reset by EOD 2026-12-31 PST"), "ko", "Asia/Seoul")).toContain("2027/1/1");
  // EOD is resolved at the following midnight, after the DST transition.
  expect(localAnnouncementTime(eodSignal("Global reset by EOD 2026-11-01 PT"), "ko", "Asia/Seoul")).toContain("17:00");
  expect(localAnnouncementTime(eodSignal("Global reset by EOD 2026-03-08 PT"), "ko", "Asia/Seoul")).toContain("16:00");
});

test("EOD with unknown or conflicting time information is not converted", () => {
  for (const text of ["Global reset by EOD", "Global reset by EOD CST", "Global reset by EOD PST or PDT",
    "Global reset by EOD 2026-02-30 PST", "Global reset by EOD today or tomorrow PST", "Global reset by EOD next week PST",
    "Global reset by EOD 13pm PST", "Global reset by EOD 14 October 2026 PST",
    "Global reset by EOD the day after tomorrow PST", "Global reset by EOD 10/14 PST"])
    expect(localAnnouncementTime(eodSignal(text), "ko", "Asia/Seoul")).toBeNull();
});

test("an explicit clock alongside EOD is not described as the calendar-day boundary", () => {
  const signal = eodSignal("Global reset by EOD tomorrow, 5pm PST");
  const notice = signalDecision(signal, "ko", "Asia/Seoul");
  expect(notice.message).toContain("발표된 마감");
  expect(notice.message).not.toContain("날짜의 종료 기준");
  expect(notice.message).not.toContain("날짜 종료 기준");
});

test("saved EOD announcements gain local display without replaying delivered notifications", () => {
  const db = new QuotaStorage(":memory:"); const store = new ResetSignalStore(db);
  const signal = eodSignal("Global reset landing by EOD PST time. Enjoy");
  try {
    store.save([signal], eodPublished);
    store.delivered(signal.fingerprint);
    const saved = store.list()[0]!;
    expect(saved.targetAtMs).toBeNull();
    expect(localAnnouncementTime(saved, "ko", "Asia/Seoul")).toContain("17:00");
    expect(store.pending(eodPublished)).toHaveLength(0);
  } finally { db.close(); }
});

test("at EOD preserves wording rather than turning it into a by deadline", () => {
  const signal = eodSignal("Global reset will happen at EOD PST");
  const label = localAnnouncementTime(signal, "ko", "Asia/Seoul")!;
  expect(label).toContain("날짜 경계");
  expect(label).not.toContain(" 전 ·");
  expect(withAnnouncementTime(signal).targetAtMs).toBeNull();
});

test("terse reset at EOD remains an announcement with an at qualifier", () => {
  const signal = eodSignal("Global reset at EOD PST");
  expect(signal.state).toBe("announced");
  expect(localAnnouncementTime(signal, "en", "UTC")).toContain("calendar boundary");
});
