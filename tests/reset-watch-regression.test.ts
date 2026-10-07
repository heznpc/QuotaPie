import { expect, test } from "bun:test";
import { classifyPost } from "../src/signals/classify";
import { parsePublicFeed } from "../src/signals/public-feed";
import { signalDecision } from "../src/signals/presentation";
import { localAnnouncementTime, withAnnouncementTime } from "../src/signals/time";
import type { PublicPost } from "../src/signals/x-source";
const now = Date.UTC(2026, 9, 7, 0);
const post = (text: string, id = "100"): PublicPost => ({ id, author: "thsottiaux", text,
  createdAtMs: now, conversationId: id, references: [] });

test("accepting a reset vote is an early signal, never a timed promise", () => {
  const parent = { ...post("I voted for a reset today", "99"), author: "someone" };
  const reply = { ...post("@someone I accept your vote"), references: [{ id: "99", type: "replied_to" as const }] };
  const signal = classifyPost(reply, new Map([[parent.id, parent]]))!;
  expect(signal).toMatchObject({ state: "possible", targetAtMs: null });
  expect(classifyPost(reply, new Map())).toBeNull();
  expect(classifyPost(reply, new Map([[parent.id, {...parent, text: "I voted for a new icon"}]]))).toBeNull();
  expect(classifyPost(post("Four updates or a reset. Or both."), new Map())?.state).toBe("possible");
  const decision = signalDecision(signal, "ko", "Asia/Seoul", ["Main · weekly: 63% 남음"]);
  expect(decision.severity).toBe("warning");
  expect(decision.message).toContain("시각 미정");
  expect(decision.message).toContain("63% 남음");
});

test("processed reset is recognized and completion evidence leads the alert", () => {
  const signal = classifyPost(post("The community demands a reset. Therefore ... the reset has been processed. Enjoy!"), new Map())!;
  expect(signal.state).toBe("reported");
  expect(signal.change?.evidence).toContain("has been processed");
  expect(signalDecision(signal, "en").message).toContain("has been processed");
  expect(classifyPost(post("The reset has not been processed"), new Map())?.state).not.toBe("reported");
});

test("relay forecast is never promoted to an announcement deadline, including saved records", () => {
  const signal = parsePublicFeed({version:1,generatedAt:new Date(now).toISOString(),items:[{
    sourceUrl:"https://x.com/thsottiaux/status/100",sourcePublishedAt:new Date(now).toISOString(),
    classificationQuote:"I accept your vote",topic:"likely",targetAt:new Date(now+8*3600000).toISOString()
  }]},now)[0]!;
  expect(signal.targetAtMs).toBeNull();
  const saved = {...signal,targetAtMs:now+8*3600000};
  expect(withAnnouncementTime(saved).targetAtMs).toBeNull();
  expect(localAnnouncementTime(saved,"ko","Asia/Seoul")).toBeNull();
  const explicit = {...saved,text:"Global reset tomorrow 10am PST",timeHint:"Global reset tomorrow 10am PST"};
  expect(withAnnouncementTime(explicit).targetAtMs).not.toBeNull();
  expect(localAnnouncementTime(explicit,"ko","Asia/Seoul")).toContain("PST");
});

import { QuotaStorage } from "../src/storage/database";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
test("late-discovered vote warnings do not fire after a reset report from another relay group", () => {
  const storage = new QuotaStorage(":memory:"), store = new ResetSignalStore(storage);
  try {
    const possible = classifyPost(post("Four updates or a reset. Or both."),new Map())!;
    const reported = classifyPost({...post("The reset has been processed", "101"),createdAtMs:now+1000},new Map())!;
    store.save([possible,reported],now+2000);
    expect(store.pending(now+2000).map(s=>s.state)).toEqual(["reported"]);
    expect(store.list()).toHaveLength(2);
  } finally {storage.close();}
});

test("token efficiency discussion is not a credit grant that hides reset news", () => {
  expect(classifyPost(post("The models are efficient in terms of tokens needed to get things done!"),new Map())).toBeNull();
});
