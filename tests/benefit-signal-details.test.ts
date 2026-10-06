import { expect, test } from "bun:test";
import { classifyPost, expandBenefitSignals, type ResetSignal } from "../src/signals/classify";
import { parsePublicFeed } from "../src/signals/public-feed";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { QuotaStorage } from "../src/storage/database";
import { localAnnouncementTime, withAnnouncementTime } from "../src/signals/time";
import { signalDecision } from "../src/signals/presentation";

// Synthetic announcements exercise wording support, not claims about a real promotion.
const now = Date.UTC(2026, 9, 3, 1);
const classify = (text: string) => classifyPost({ id: "123", author: "thsottiaux", text,
  createdAtMs: now, conversationId: "123", references: [] }, new Map());

test("reset entitlements, spendable tokens and an actual reset stay distinct", () => {
  const banked = classify("Everyone gets another banked reset today.")!;
  expect(banked).toMatchObject({ benefitKind: "resetCredits", resetKind: "banked", state: "reported",
    change: { amount: 1, unit: "resets" } });
  expect(classify("We added 2 reset credits to every account.")).toMatchObject({ benefitKind: "resetCredits",
    change: { amount: 2, unit: "resets" } });
  expect(classify("We added 100000 tokens to every account.")).toMatchObject({ benefitKind: "credits",
    change: { amount: 100000, unit: "tokens" } });
  expect(classify("Every account receives 62,500 free credits today.")).toMatchObject({ benefitKind: "credits",
    change: { amount: 62500, unit: "credits" } });
  expect(classify("We have just reset weekly limits for everyone.")).toMatchObject({ benefitKind: "reset", state: "reported" });
});

test("announced allowance improvements retain comparable numbers and exact evidence", () => {
  for (const [text, percent] of [
    ["Codex users get 50% more usage starting today.", 50],
    ["We are giving users 1.5x more usage today.", 50],
    ["We have doubled Claude Code usage for Pro and Max.", 100],
    ["Weekly capacity has increased by 50% today.", 50],
    ["기본 제공량이 기존 대비 50% 상승했습니다.", 50],
    ["사용 가능량이 1.5배 증가했습니다.", 50],
  ] as const) {
    expect(classify(text)).toMatchObject({ benefitKind: "limits", state: "reported", change: { percent, evidence: text } });
  }
  expect(classify("Weekly usage allowance increased from 100 to 150 messages.")).toMatchObject({
    benefitKind: "limits", change: { before: 100, after: 150, percent: 50, unit: "messages" } });
  expect(classify("사용 한도가 100회에서 150회로 증가했습니다.")).toMatchObject({
    benefitKind: "limits", change: { before: 100, after: 150, percent: 50, unit: "회" } });
  expect(classify("Usage limits will increase 50% tomorrow.")).toMatchObject({ benefitKind: "limits", state: "announced" });
});

test("speed, consumption, context capacity, guesses and reductions are not additional allowance", () => {
  for (const text of [
    "Codex is now 50% faster.",
    "We increased token usage by 50% in this benchmark.",
    "Active user usage has doubled this month.",
    "We added support for a 1 million token context window.",
    "We added token logging to track usage.",
    "Our context limits have doubled.",
    "We are giving 50% more throughput to our servers.",
    "We doubled server capacity.",
    "We doubled GPU capacity for inference.",
    "Claude Code is now 50% more token efficient.",
    "It feels like users get 50% more usage.",
    "사용량이 체감상 50% 증가한 것 같습니다.",
    "We might increase usage limits by 50%.",
    "We will not increase usage limits by 50%.",
    "Usage limits changed from 150 to 100 messages.",
    "What are usage credits?",
  ]) expect(classify(text)).toBeNull();
  expect(classify("Get a 50% discount on your subscription.")?.benefitKind).toBe("discounts");
});

test("combined announcements retain each benefit and audience restrictions win", () => {
  const text = "Usage limits increased 50% today; everyone gets another banked reset; we added 10k tokens to every account.";
  const source = classify(text)!;
  expect(source.benefits?.map(b => b.kind)).toEqual(["limits", "resetCredits", "credits"]);
  const signals = expandBenefitSignals(source);
  expect(signals.map(s => s.id)).toEqual(["123:limits", "123:resetCredits", "123:credits"]);
  expect(new Set(signals.map(s => s.fingerprint)).size).toBe(3);
  expect(signals.every(s => s.sourcePostId === "123" && s.sourceUrl === "https://x.com/thsottiaux/status/123")).toBe(true);
  expect(signals[0]?.change?.percent).toBe(50);
  expect(signals[1]?.change?.amount).toBe(1);
  expect(signals[2]?.change).toMatchObject({ amount: 10000, unit: "tokens" });
  expect(expandBenefitSignals(source)).toEqual(signals);
  const conditional = "Usage limits increased 50% today; get another banked reset; we added 10k tokens.";
  expect(expandBenefitSignals(classify(`Students receive these benefits: ${conditional}`)!)).toHaveLength(1);
  expect(expandBenefitSignals(classify(`Students receive these benefits: ${conditional}`)!)[0]?.benefitKind).toBe("student");
  expect(expandBenefitSignals(classify(`Complete the challenge to earn benefits: ${conditional}`)!)[0]?.benefitKind).toBe("events");
  const single = classify("Everyone gets another banked reset today.")!;
  expect(expandBenefitSignals(single)).toEqual([single]);
  expect(expandBenefitSignals(classify("Usage limits will increase 50% tomorrow; we added 1000 tokens to every account today.")!)
    .map(s => [s.benefitKind, s.state])).toEqual([["limits", "announced"], ["credits", "reported"]]);
  expect(expandBenefitSignals(classify("We increased usage limits by 50% for everyone. Students can get free credits.")!)
    .map(s => [s.benefitKind, s.change?.percent])).toEqual([["limits", 50], ["student", undefined]]);
  expect(expandBenefitSignals(classify("Students can get free credits. Get 50% more usage today.")!)
    .map(s => s.benefitKind)).toEqual(["student"]);
  expect(expandBenefitSignals(classify("We increased usage limits by 50% for everyone. Students get 100% more usage.")!)
    .map(s => [s.benefitKind, s.change?.percent])).toEqual([["limits", 50], ["student", 100]]);
  expect(expandBenefitSignals(classify("We have just reset weekly limits for everyone; everyone gets another banked reset; we added 1000 tokens to every account; usage limits increased 50% today.")!)
    .map(s => [s.benefitKind, s.resetKind])).toEqual([["reset", "direct"], ["resetCredits", "banked"], ["credits", "unknown"], ["limits", "unknown"]]);
});

test("public relay preserves numeric details and all benefits before storage", () => {
  const signals = parsePublicFeed({ version: 1, generatedAt: new Date(now).toISOString(), items: [{
    sourceUrl: "https://x.com/thsottiaux/status/123", sourcePublishedAt: new Date(now).toISOString(), topic: "action",
    classificationQuote: "Usage limits increased 50% today; everyone gets another banked reset.",
  }] }, now);
  expect(signals[0]?.benefits).toHaveLength(2);
  expect(signals[0]?.change?.percent).toBe(50);
});

test("each compound benefit keeps its own schedule and converts that schedule to KST", () => {
  const signals = expandBenefitSignals(classify("Added 1000 tokens now. Banked reset tomorrow at 10am PST.")!);
  const tokens = signals.find(signal => signal.benefitKind === "credits")!;
  const reset = signals.find(signal => signal.benefitKind === "resetCredits")!;
  expect(tokens).toMatchObject({ state: "reported", timeHint: null, targetAtMs: null });
  expect(reset).toMatchObject({ state: "announced", targetAtMs: Date.UTC(2026, 9, 3, 18) });
  expect(localAnnouncementTime(tokens, "ko", "Asia/Seoul")).toBeNull();
  expect(signalDecision(tokens, "ko", "Asia/Seoul").message).not.toContain("KST");
  expect(signalDecision(tokens, "ko", "Asia/Seoul").message).not.toContain("tomorrow");
  expect(localAnnouncementTime(reset, "ko", "Asia/Seoul")).toContain("KST");
  expect(localAnnouncementTime(reset, "ko", "Asia/Seoul")).toContain("10월 4일");
  // Older derived metadata must not restore the other benefit's deadline.
  expect(withAnnouncementTime({ ...tokens, targetAtMs: reset.targetAtMs, timeHint: reset.timeHint }).targetAtMs).toBeNull();
});

test("recent completed grants and resets notify after their target time, once per benefit", () => {
  const db = new QuotaStorage(":memory:"), store = new ResetSignalStore(db);
  try {
    const signal = classify("Usage limits increased 50% today at 12am UTC; everyone gets another banked reset today at 12am UTC.")!;
    store.save([signal], now);
    expect(store.pending(now)).toHaveLength(2);
    for (const s of store.pending(now)) store.delivered(s.fingerprint);
    store.save([signal], now + 1000);
    expect(store.pending(now + 1000)).toHaveLength(0);
    expect(store.list()).toHaveLength(2);
    store.save([{ ...signal, id: "456", groupId: "456", fingerprint: "past-promise", state: "announced",
      benefits: signal.benefits?.map(benefit => ({ ...benefit, state: "announced" })) }], now);
    expect(store.pending(now)).toHaveLength(0);
  } finally { db.close(); }
});

test("historic compound imports and enrichment of already-delivered posts stay quiet", () => {
  const db = new QuotaStorage(":memory:"), store = new ResetSignalStore(db);
  try {
    const compound = classify("Usage limits increased 50% today; everyone gets another banked reset.")!;
    store.save([{ ...compound, publishedAtMs: now - 2 * 86400000 }], now);
    expect(store.list()).toHaveLength(2);
    expect(store.pending(now)).toHaveLength(0);
    const newer = { ...compound, id: "456", groupId: "456", fingerprint: "new-compound" };
    const old: ResetSignal = { ...newer, benefits: undefined, benefitKind: "reset", change: undefined };
    store.save([old], now);
    store.delivered(old.fingerprint);
    store.save([newer], now + 1000);
    expect(store.pending(now + 1000)).toHaveLength(0);
    expect(store.list().some(s => s.id === "456")).toBe(false);
    expect(store.list().filter(s => s.sourcePostId === "456")).toHaveLength(2);
  } finally { db.close(); }
});

test("enriching a pending post preserves each independent pending benefit", () => {
  const db = new QuotaStorage(":memory:"), store = new ResetSignalStore(db);
  try {
    const compound = classify("Usage limits increased 50% today; everyone gets another banked reset.")!;
    store.save([{ ...compound, benefits: undefined, benefitKind: "reset", change: undefined }], now);
    store.save([compound], now + 1000);
    expect(store.pending(now + 1000).map(signal => signal.benefitKind)).toEqual(["limits", "resetCredits"]);
  } finally { db.close(); }
});
