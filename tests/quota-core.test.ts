import { expect, test } from "bun:test";
import { parseCompactionRequestEvent, TaskSavingsRouter, routeCompaction, parseCodexRateLimits } from "../packages/quota-core/src/index.js";
import { TaskSavingsRouter as HostRouter } from "../src/task-savings";
import { routeCompaction as hostCompaction } from "../src/codex-compaction-policy";
import { parseCodexRateLimits as hostQuota } from "../src/providers/codex-appserver";

const record = { requestId: "10000000-0000-4000-8000-000000000001", threadId: null, turnId: null, kind: "compaction", from: "gpt-6-astra", to: "gpt-5.6-sol", routed: true, phase: "completed", status: 200, requestedEffort: "high", reasoningEffort: "low", at: "2026-01-01T00:00:01Z", durationMs: 1000 } as const;

test("QuotaPie consumes the shared implementations directly", () => {
  expect(HostRouter).toBe(TaskSavingsRouter);
  expect(hostCompaction).toBe(routeCompaction);
  expect(hostQuota).toBe(parseCodexRateLimits);
});

test("event contract rejects coerced metadata and projects only declared fields", () => {
  for (const value of [null, [], 5, {}, { ...record, at: 1 }, { ...record, requestId: { toString: () => record.requestId } }]) {
    expect(parseCompactionRequestEvent(value)).toBeNull();
  }
  const projected = parseCompactionRequestEvent({ ...record, prompt: "private-fixture", authorization: "private-fixture", url: "https://private.invalid", threadId: { toString: () => record.requestId }, errorCode: 123, usage: { input: 2, cachedInput: 3, output: 1 } });
  expect(projected).toEqual({ ...record, responseModel: null, usage: null });
  expect(JSON.stringify(projected)).not.toContain("private-fixture");
  expect(parseCompactionRequestEvent({ ...record, upstreamBodyPresent: true, upstreamContentLength: null,
    upstreamBytes: 42, relayQueuedBytes: 42 })).toEqual({ ...record, responseModel: null, usage: null,
    upstreamBodyPresent: true, upstreamContentLength: null, upstreamBytes: 42, relayQueuedBytes: 42 });
  expect(parseCompactionRequestEvent({ ...record, upstreamBodyPresent: "true", upstreamContentLength: -1,
    upstreamBytes: "42", relayQueuedBytes: Infinity })).toEqual({ ...record, responseModel: null, usage: null });
});
