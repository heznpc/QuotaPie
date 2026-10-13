import { expect, test } from "bun:test";
import { resetOpportunities } from "../src/signals/opportunities";
import { classifyPost } from "../src/signals/classify";
import { eligible } from "../src/dots/policy";
import type { QuotaEvent } from "../src/types";
import type { TargetState } from "../src/dots/store";
import type { ResumeGate } from "../src/resume-gate";
const DAY = 86400000, now = Date.parse("2026-10-13T02:00:00Z");
const announcement = (day: number) => classifyPost({ id: String(day), author: "thsottiaux", text: "Global reset will happen at EOD PST",
  createdAtMs: now - day * DAY, conversationId: String(day), references: [] }, new Map())!;
const report = (day: number) => ({ ...announcement(day), id: `report-${day}`, text: "All reset for everyone.",
  change: { evidence: "All reset for everyone." }, state: "reported" as const, resetKind: "direct" as const, publishedAtMs: now - day * DAY + 3 * 3600000 });
const event = (day: number): QuotaEvent => ({ provider: "codex", account: "fixture", bucket: "codex:weekly", kind: "external_relief", severity: "info",
  confidence: "high", displayText: "", occurredAtMs: report(day).publishedAtMs,
  details: { previousObservedAtMs: report(day).publishedAtMs - 60000, usedPercentBefore: 75, usedPercentAfter: 0,
    previousQuality: "authoritative", nextQuality: "authoritative", previousSource: "codex-app-server", nextSource: "codex-app-server",
    previousWindowSeconds: 604800, nextWindowSeconds: 604800 } });
test("two independent observed recovery days produce an interval; report timestamps alone do not", () => {
  const signals = [announcement(0), announcement(2), report(2), announcement(4), report(4)];
  expect(resetOpportunities(signals, [], "codex", "fixture", now)[0]!.forecast).toBeNull();
  expect(resetOpportunities(signals, [event(2), event(2)], "codex", "fixture", now)[0]!.forecast).toBeNull();
  const result = resetOpportunities(signals, [event(2), event(4)], "codex", "fixture", now)[0]!;
  expect(result.forecast).toMatchObject({ sampleCount: 2, earliestMs: now + 3 * 3600000 - 60000, latestMs: now + 3 * 3600000 });
  expect(result.actionableFromMs).toBe(now);
  expect(resetOpportunities(signals, [event(2), event(4)], "codex", "other", now)[0]!.forecast).toBeNull();
});
test("withdrawn, completed, speculative, banked and scoped announcements cannot start work", () => {
  const a = announcement(0);
  for (const state of ["reported", "withdrawn", "updated"] as const)
    expect(resetOpportunities([a, { ...a, id: "next", state }], [], "codex", "fixture", now)).toEqual([]);
  for (const a2 of [{ ...a, state: "possible" as const }, { ...a, resetKind: "banked" as const },
    { ...a, change: { evidence: "Global reset for Plus only" } }])
    expect(resetOpportunities([a2], [], "codex", "fixture", now)).toEqual([]);
  expect(resetOpportunities([a], [], "codex", "fixture", now + DAY)).toEqual([]);
});
test("public announcement wakes reviewed work with 9% remaining without changing quota or default policies", () => {
  const gate: ResumeGate = { schemaVersion: 1, provider: "codex", account: "fixture", profileKey: "profile", accountKey: "account",
    ready: true, reason: "ready", checkedAtMs: now, retryAtMs: null,
    windows: [{ bucket: "codex:weekly", remainingPercent: 9, reservePercent: 0, observedAtMs: now, resetsAtMs: now + 7 * DAY }],
    resetOpportunities: resetOpportunities([announcement(0)], [], "codex", "fixture", now) };
  const state: TargetState = { policy: { id: "work", threadId: "thread", account: "fixture", profileKey: "profile", accountKey: "account", continuation: "Continue",
    enabled: true, trigger: "quota.reset_approaching", resetBucket: "codex:weekly", resetTiming: "public-announcement",
    resetWithinMinutes: 30, reservePercent: 0, maxTurns: 10, maxUsagePercent: 100, expiresAtMs: now + DAY, priority: 0 },
    turns: 0, spent: 0, last: null, event: null, claimed: null, outcome: null };
  expect(eligible(state, gate, now)).toBeTrue();
  expect(eligible({ ...state, policy: { ...state.policy, resetTiming: undefined } }, gate, now)).toBeFalse();
  expect(eligible(state, { ...gate, ready: false, reason: "quota-stale" }, now)).toBeFalse();
  expect(eligible(state, { ...gate, windows: [{ ...gate.windows[0]!, remainingPercent: 0 }] }, now)).toBeFalse();
  expect(eligible({ ...state, policy: { ...state.policy, enabled: false } }, gate, now)).toBeFalse();
});

test("an observed full recovery closes the opportunity even before the public completion arrives", () => {
  const a = announcement(0), observed = event(0);
  expect(resetOpportunities([a], [observed], "codex", "fixture", observed.occurredAtMs)).toEqual([]);
});

test("an older EOD without a timezone contributes observed clock evidence without inventing its timezone", () => {
  const older = { ...announcement(2), timeHint: "Global reset by EOD", change: { evidence: "Global reset by EOD" } };
  const result = resetOpportunities([announcement(0), older, announcement(4)], [event(2), event(4)], "codex", "fixture", now);
  expect(result[0]!.forecast?.sampleCount).toBe(2);
});

test("posting before UTC midnight does not move the learned recovery clock a day late", () => {
  const older = { ...announcement(2), publishedAtMs: announcement(2).publishedAtMs - 3 * 3600000 };
  const result = resetOpportunities([announcement(0), older, announcement(4)], [event(2), event(4)], "codex", "fixture", now)[0]!;
  expect(result.forecast?.latestMs).toBe(now + 3 * 3600000);
});
