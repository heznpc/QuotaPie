import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CompactionStatusReader } from "../src/compaction-status";

test("groups only a later request from the same task and turn, and persists observed continuation across relay history eviction", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-followup-"));
  const threadId = randomUUID(), turnId = randomUUID(), token = "aa".repeat(24);
  const compact = { requestId: randomUUID(), threadId, turnId, kind: "compaction", from: "gpt-6-astra", to: "gpt-5.6-sol",
    requestedEffort: "xhigh", reasoningEffort: "low", routed: true, phase: "completed", status: 200,
    at: new Date(11000).toISOString(), durationMs: 1000 };
  const response = (overrides = {}) => ({ ...compact, requestId: randomUUID(), kind: "response", from: "gpt-5.6-luna", to: "gpt-5.6-luna",
    requestedEffort: "high", reasoningEffort: "high", routed: false, at: new Date(11800).toISOString(), durationMs: 300, ...overrides });
  const followup = response();
  let recent = [compact,
    response({ threadId: randomUUID() }), response({ turnId: randomUUID() }),
    response({ at: new Date(11300).toISOString(), durationMs: 500 }), followup];
  const fetcher = (async () => Response.json({ service: "quotapie-compaction", schemaVersion: 2, recent, active: [] })) as unknown as typeof fetch;
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ port: 45000, token }));
    await writeFile(join(root, "relay.log"), JSON.stringify(compact) + "\n");
    const result = await new CompactionStatusReader(root, fetcher).status(12000);
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]?.finishedAtMs).toBe(11000);
    expect(result.recent[0]?.followup).toEqual({ requestId: followup.requestId, model: "gpt-5.6-luna", effort: "high", startedAtMs: 11500 });
    recent = [];
    const restored = await new CompactionStatusReader(root, fetcher).status(20000);
    expect(restored.recent[0]?.followup?.requestId).toBe(followup.requestId);
    const evidence = await readFile(join(root, "observations.json"), "utf8");
    expect(JSON.parse(evidence)).toHaveLength(2);
    expect(evidence).not.toContain(token);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("headers, unknown identity and a newer compaction never imply a return to the work model", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-no-followup-"));
  const threadId = randomUUID();
  const first = { requestId: randomUUID(), threadId, turnId: null, kind: "compaction", from: "gpt-6-astra", to: "gpt-5.6-sol",
    routed: true, requestedEffort: "xhigh", reasoningEffort: "low", phase: "completed", status: 200,
    at: new Date(10000).toISOString(), durationMs: 1000 };
  const next = { ...first, requestId: randomUUID(), at: new Date(13000).toISOString(), durationMs: 1000 };
  const response = { ...next, requestId: randomUUID(), kind: "response", from: "gpt-6-astra", to: "gpt-6-astra",
    at: new Date(15000).toISOString() };
  const unknown = { ...first, requestId: randomUUID(), threadId: null };
  const headers = { ...first, requestId: randomUUID(), phase: "response_headers", at: new Date(16000).toISOString() };
  const fetcher = (async () => Response.json({ service: "quotapie-compaction", schemaVersion: 2,
    recent: [first, next, response, unknown], active: [headers] })) as unknown as typeof fetch;
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({port:45000, token:"bb".repeat(24)}));
    const result = await new CompactionStatusReader(root, fetcher).status(17000);
    expect(result.recent.find(r => r.requestId === first.requestId)?.followup).toBeNull();
    expect(result.recent.find(r => r.requestId === unknown.requestId)?.followup).toBeNull();
    expect(result.recent.find(r => r.requestId === next.requestId)?.followup?.requestId).toBe(response.requestId);
    expect(result.active[0]?.followup).toBeNull();
    expect(result.active[0]?.finishedAtMs).toBeNull();
  } finally { await rm(root, {recursive: true, force: true}); }
});
