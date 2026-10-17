import { expect, test } from "bun:test";
import { sessionEfficiencyInsights } from "../src/session-efficiency";
import type { CompactionRequestEvent } from "../src/codex-compaction";
const now = 10_000_000;
const event = (n: number, patch: Partial<CompactionRequestEvent> = {}): CompactionRequestEvent => ({
  requestId: `request-${n}`, threadId: "11111111-1111-4111-8111-111111111111", turnId: null,
  kind: "response", phase: "failed", status: 200, at: new Date(now - 1000 + n).toISOString(),
  durationMs: 100, from: "gpt-6-astra", to: "gpt-6-astra", routed: false,
  requestedEffort: "high", reasoningEffort: "high", errorCode: "upstream_stream_interrupted", failureOrigin: "provider_protocol", ...patch,
});
test("repeated errors produce bounded evidence and clear after a successful response", () => {
  const failures = [event(1), event(2), event(3)];
  const insights = sessionEfficiencyInsights([...failures, event(3)], now);
  expect(insights).toHaveLength(1);
  expect(insights[0]).toMatchObject({count: 3, observedDurationMs: 300, savingsApplied: false, suggestion: "review-provider-error"});
  expect(insights[0]!.requestIds).toEqual(["request-1", "request-2", "request-3"]);
  expect(sessionEfficiencyInsights([...failures, event(4, {phase:"completed"})], now)).toEqual([]);
  expect(sessionEfficiencyInsights(failures, now + 30 * 60_000)).toEqual([]);
});
test("unrelated threads, distinct errors, cancellations and duration alone are not waste evidence", () => {
  expect(sessionEfficiencyInsights([event(1), event(2, {errorCode:"different"}), event(3, {threadId:null})], now)).toEqual([]);
  expect(sessionEfficiencyInsights([1,2,3].map(n=>event(n,{phase:"cancelled",durationMs:100000})),now)).toEqual([]);
  expect(sessionEfficiencyInsights([1,2,3].map(n=>event(n,{phase:"completed",durationMs:100000})),now)).toEqual([]);
});
test("repeated completed compactions without progress are review suggestions, not failed quality claims", () => {
  const events = [1,2,3].map(n=>event(n,{kind:"compaction",phase:"completed",routed:true}));
  expect(sessionEfficiencyInsights(events, now)[0]).toMatchObject({kind:"repeated-compaction",suggestion:"review-compaction",savingsApplied:false});
  expect(sessionEfficiencyInsights([...events,event(4,{phase:"completed"})],now)).toEqual([]);
});
