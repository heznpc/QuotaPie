import { expect, test } from "bun:test";
import { parseCompactionRequestEvent } from "../packages/quota-core/src/events.js";
import { summarizeRouting, staleRouting } from "../src/request-routing";

const now = Date.parse("2026-10-20T03:00:00Z");
const id = "10000000-0000-4000-8000-000000000001";
function event(patch = {}) {
  return parseCompactionRequestEvent({ requestId: id, threadId: id, turnId: null, kind: "response", from: "gpt-6-astra", to: "gpt-6-astra",
    routed: false, phase: "started", status: 0, requestedEffort: "high", reasoningEffort: "high", at: new Date(now).toISOString(), durationMs: 100, ...patch })!;
}
function generation(records = [event()], source: unknown = "main", live = records.map(row => row.requestId)) {
  return { reachable: true, records, health: { subscriptionGuardVersion: 1, subscriptionGuard: { version: 1, account: source } },
    healthRequestIds: new Set(live), activeIds: new Set(live) };
}

test("source passthrough needs exact live health evidence, never null-to-default guessing", () => {
  const source = summarizeRouting([generation()], now).active[0]!;
  expect(source).toMatchObject({ sourceAccount: "main", account: "main", attribution: "relay-source", switched: false,
    upstreamResponseObserved: false, observedAtMs: now, startedAtMs: now - 100 });
  expect(summarizeRouting([generation([event()], "main", [])], now).recent[0])
    .toMatchObject({ sourceAccount: null, account: null, attribution: "unknown", active: false, phase: "unverified" });
  expect(summarizeRouting([generation([event()], "private@example.com")], now).active[0]?.account).toBeNull();
});

test("frozen pool route is projected without credentials or labels and wins over relay source", () => {
  const record = event({ accountRouting: { sourceAccount: "main", account: "other", accountLabel: "secret@example.com", reason: "reserve",
    accessToken: "secret-token", identity: "secret-identity" } });
  const result = summarizeRouting([generation([record])], now);
  expect(result.active[0]).toMatchObject({ sourceAccount: "main", account: "other", attribution: "pool-selection", reason: "reserve", switched: true });
  expect(JSON.stringify(record)).not.toContain("secret");
  expect(summarizeRouting([generation([event({ accountRouting: { sourceAccount: "main", account: "secret@example.com", reason: "reserve" } })])], now)
    .active[0]).toMatchObject({ account: null, sourceAccount: null, attribution: "unknown" });
});

test("parallel accounts stay separate, duplicate generations collapse, conflicts remain unknown", () => {
  const other = event({ requestId: "20000000-0000-4000-8000-000000000002" });
  expect(summarizeRouting([generation(), generation([other], "other")], now).active.map(row => row.account)).toEqual(["main", "other"]);
  expect(summarizeRouting([generation(), generation()], now).active).toHaveLength(1);
  expect(summarizeRouting([generation(), generation([event()], "other"), generation()], now).active[0])
    .toMatchObject({ attribution: "unknown", account: null, switched: null });
});

test("unreachable and stale readers clear active claims and preserve proven historical attribution", () => {
  const first = summarizeRouting([generation()], now);
  const lost = summarizeRouting([{ ...generation([event()], "main", []), reachable: false }], now + 3000, first.active);
  expect(lost).toMatchObject({ freshness: "stale", active: [], recent: [{ account: "main", active: false, phase: "unverified" }] });
  expect(staleRouting(first)).toMatchObject({ freshness: "stale", active: [], recent: [{ account: "main", active: false }] });
  const completed = event({ phase: "completed", status: 200, at: new Date(now + 1000).toISOString(), durationMs: 1100 });
  expect(summarizeRouting([generation([completed])], now + 1000, first.active).recent[0])
    .toMatchObject({ account: "main", upstreamResponseObserved: true, finishedAtMs: now + 1000 });
});

test("loss of one previously active relay preserves uncertainty while another remains fresh", () => {
  const second = event({ requestId: "20000000-0000-4000-8000-000000000002" });
  const first = summarizeRouting([generation(), generation([second], "other")], now);
  const unavailable = { ...generation([second], "other", []), reachable: false };
  const lost = summarizeRouting([generation(), unavailable], now + 1000, [...first.active, ...first.recent]);
  expect(lost).toMatchObject({ freshness: "fresh", activityUncertain: true, active: [{ account: "main" }],
    recent: [{ account: "other", active: false, activityUncertain: true }] });
  const later = summarizeRouting([generation(), unavailable], now + 2000, [...lost.active, ...lost.recent]);
  expect(later.activityUncertain).toBe(true);
  const terminal = event({ requestId: second.requestId, phase: "completed", status: 200,
    at: new Date(now + 2500).toISOString(), durationMs: 2600 });
  expect(summarizeRouting([generation(), generation([terminal], "other")], now + 3000, [...later.active, ...later.recent]))
    .toMatchObject({ activityUncertain: false, active: [{ account: "main" }] });
  expect(summarizeRouting([generation(), { ...generation([], "retired", []), reachable: false }], now).activityUncertain).toBe(false);
});

test("newer completed requests cannot silently discard an earlier unconfirmed active request", () => {
  const first = summarizeRouting([generation()], now);
  const completions = Array.from({ length: 60 }, (_, index) => event({ requestId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    phase: "completed", status: 200, at: new Date(now + 1000).toISOString() }));
  const lost = summarizeRouting([generation(completions)], now + 2000, first.active);
  expect(lost.activityUncertain).toBe(true);
  expect(lost.recent.find(row => row.requestId === id)?.activityUncertain).toBe(true);
  expect(summarizeRouting([generation(completions)], now + 3000, [...lost.active, ...lost.recent]).activityUncertain).toBe(true);
});
