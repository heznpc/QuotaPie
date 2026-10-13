import { expect, test } from "bun:test";
import { classifyPost } from "../src/signals/classify";
import { signalDecision } from "../src/signals/presentation";

const classify = (text: string, author = "thsottiaux") => classifyPost({
  id: "2109045392684032299", author, text, createdAtMs: 1791670580000,
  conversationId: "2109045392684032299", references: [],
}, new Map());

test("October 11 EOD announcement is actionable without inventing a reset instant", () => {
  const signal = classify("Global reset by EOD. May the tokens do good things for you.")!;
  expect(signal?.state).toBe("announced");
  expect(signal.resetKind).toBe("direct");
  expect(signal.timeHint).toBe("Global reset by EOD");
  expect(signal.targetAtMs).toBeNull();
  const notice = signalDecision(signal, "ko", "Asia/Seoul", ["계정 1 · 주간: 63% 남음"]);
  expect(notice.severity).toBe("warning");
  expect(notice.message).toContain("남은 한도로 할 작업을 지금 확인하세요");
  expect(notice.message).toContain("63% 남음");
  expect(signalDecision(signal, "en", "UTC").message).toContain("Review work for your remaining quota now");
});

test("daily reset hint and propagation confirmation survive local classification", () => {
  expect(classify("Day 6/ Reset")?.state).toBe("possible");
  expect(classify("Put the reset in the bag. All propagated.")?.state).toBe("reported");
  expect(classify("Day 6/ Reset", "randomuser")).toBeNull();
});

test("explicit source zones and deadlines do not promise users a safe waiting period", () => {
  const eod = classify("Global reset by EOD PST.")!;
  expect(signalDecision(eod, "ko", "Asia/Seoul").message).toContain("EOD → KST");
  expect(eod.targetAtMs).toBeNull();
  const timed = classify("Global reset by tomorrow 10am PST.")!;
  const notice = signalDecision(timed, "ko", "Asia/Seoul");
  expect(notice.severity).toBe("warning");
  expect(notice.message).toContain("발표된 마감");
  expect(notice.message).toContain("KST");
});

test("questions, negation, history and unrelated deadlines do not become reset promises", () => {
  for (const text of ["Global reset by EOD?", "Maybe a global reset by EOD.",
    "No reset by EOD.", "We had a reset yesterday. Documentation by EOD.",
    "Reset requests are common. Documentation by EOD.", "When will the reset be all propagated?"]) {
    expect(classify(text)?.state).not.toBe("announced");
    expect(classify(text)?.state).not.toBe("reported");
  }
});
