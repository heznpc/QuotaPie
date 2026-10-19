import { expect, test } from "bun:test";
import { deflateSync, gzipSync } from "node:zlib";
import { createCompactionHandler, type CompactionRequestEvent, type NativeRequestEvent } from "../src/codex-compaction";
import { createRelayDiagnostics } from "../src/relay-diagnostics";
import type { SubscriptionGuard } from "../src/subscription-guard";

const route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" } as const;
const guard = { intervalMs: 1000, check: () => ({ ready: true, enforcement: "source-identity" }),
  checkIdentity: () => ({ ready: true }) } as unknown as SubscriptionGuard;
const encode = (input: Uint8Array) => [
  ["identity", input], ["gzip", gzipSync(input)], ["deflate", deflateSync(input)], ["zstd", Bun.zstdCompressSync(input)],
] as const;

function fixture(compaction = true) {
  const events: CompactionRequestEvent[] = [], native: NativeRequestEvent[] = [], logs: unknown[] = [];
  const sent: { bytes: Uint8Array; headers: Headers }[] = [];
  const logger = createRelayDiagnostics(line => logs.push(JSON.parse(line)));
  const handler = createCompactionHandler({ executionMode: "interactive", route, subscriptionGuard: guard,
    taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" },
    onRequest: event => { events.push(event); logger.onRequest(event); },
    onNativeRequest: event => { native.push(event); logger.onNativeRequest(event); },
    fetchUpstream: async (_url, init) => {
      sent.push({ bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), headers: new Headers(init.headers) });
      return Response.json(compaction ? { model: route.to, output: [{ type: "compaction", encrypted_content: "fixture" }] }
        : { status: "completed", model: route.from, output: [] });
    } });
  return { handler, events, native, sent, logs,
    async request(path: string, bytes: Uint8Array, encoding: string) {
      const response = await handler.fetch(new Request("http://127.0.0.1" + handler.prefix + path, {
        method: "POST", headers: { "content-type": "application/json", "content-encoding": encoding,
          authorization: "Bearer private-fixture-token" }, body: bytes as Uint8Array<ArrayBuffer> }));
      expect(response.status).toBe(200); await response.text();
    } };
}

test("interactive compaction switches models and emits completion for every supported request encoding", async () => {
  for (const path of ["/responses", "/responses/compact"]) {
    const input = { model: route.from, reasoning: { effort: "xhigh" },
      input: [{ role: "user", content: "private-fixture-text" }, { type: "compaction_trigger" }] };
    for (const [encoding, bytes] of encode(Buffer.from(JSON.stringify(input)))) {
      const f = fixture(); await f.request(path, bytes, encoding);
      expect(f.sent).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(f.sent[0]!.bytes))).toEqual({ ...input, model: route.to, reasoning: { effort: "low" } });
      expect(f.sent[0]!.headers.get("content-encoding")).toBeNull();
      expect(f.events.map(event => event.phase)).toEqual(["started", "response_headers", "completed"]);
      expect(f.events.every(event => event.kind === "compaction" && event.routed && event.from === route.from && event.to === route.to
        && event.requestEncoding === encoding && event.requestInspection === "parsed")).toBe(true);
      expect(f.native[0]).toMatchObject({ requestEncoding: encoding, requestInspection: "parsed", reason: "provider-response" });
      expect(f.handler.snapshot()).toMatchObject({ compactions: 1, attemptedCompactions: 1, activeRequests: 0, nativeRequestInspectionVersion: 1 });
      expect(JSON.stringify(f.logs)).not.toContain("private-fixture");
    }
  }
});

test("interactive ordinary requests preserve their exact compressed bytes and encoding", async () => {
  const input = Buffer.from(JSON.stringify({ model: route.from, input: [{ role: "user", content: "fixture" }] }, null, 2));
  for (const [encoding, bytes] of encode(input)) {
    const f = fixture(false); await f.request("/responses", bytes, encoding);
    expect(f.sent).toHaveLength(1); expect(f.sent[0]!.bytes).toEqual(new Uint8Array(bytes));
    expect(f.sent[0]!.headers.get("content-encoding")).toBe(encoding);
    expect(f.events.at(-1)).toMatchObject({ kind: "response", phase: "completed", routed: false, from: route.from, to: route.from,
      requestEncoding: encoding, requestInspection: "parsed" });
    expect(f.handler.snapshot().compactions).toBe(0);
  }
});

test("uninspectable interactive payloads pass through once and report only fixed inspection reasons", async () => {
  const compressed = Bun.zstdCompressSync('{"model":"gpt-6-astra","input":[]}');
  // Single-segment zstd frame advertising 65 MiB: rejected before decompression/allocation.
  const oversized = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0x10, 4, 1, 0, 0]);
  const cases = [
    ["zstd", compressed.subarray(0, compressed.length - 1), "decode-failed"],
    ["zstd", Buffer.concat([compressed, compressed]), "decode-failed"],
    ["zstd", oversized, "decode-limit-exceeded"],
    ["gzip", Buffer.from("private-fixture-text"), "decode-failed"],
    ["private-fixture-encoding", compressed, "unsupported-encoding"],
    ["identity", Buffer.from("private-fixture-text"), "invalid-json"],
    ["identity", Buffer.from("[]"), "missing-model"],
    ["identity", Buffer.alloc(0), "empty-body"],
  ] as const;
  for (const [encoding, bytes, reason] of cases) {
    const f = fixture(false); await f.request("/responses/compact", bytes, encoding);
    expect(f.sent).toHaveLength(1); expect(f.sent[0]!.bytes).toEqual(new Uint8Array(bytes));
    expect(f.sent[0]!.headers.get("content-encoding")).toBe(encoding);
    expect(f.events).toHaveLength(0);
    expect(f.native).toHaveLength(1); expect(f.native[0]).toMatchObject({ requestInspection: reason,
      requestEncoding: encoding === "private-fixture-encoding" ? "unsupported" : encoding });
    expect(f.handler.snapshot()).toMatchObject({ compactions: 0, attemptedCompactions: 0, activeRequests: 0 });
    expect(JSON.stringify(f.logs)).not.toContain("private-fixture");
  }
});

test("cancelling optional inspection never forwards a partial or original request afterward", async () => {
  const f = fixture(), controller = new AbortController();
  const bytes = Bun.zstdCompressSync(JSON.stringify({ model: route.from,
    input: [{ role: "user", content: "x".repeat(8 * 1024 * 1024) }, { type: "compaction_trigger" }] }));
  const response = f.handler.fetch(new Request("http://127.0.0.1" + f.handler.prefix + "/responses", {
    method: "POST", headers: { "content-encoding": "zstd" }, body: bytes as Uint8Array<ArrayBuffer>, signal: controller.signal }));
  controller.abort();
  expect((await response).status).toBe(499);
  expect(f.sent).toHaveLength(0);
  expect(f.handler.snapshot()).toMatchObject({ activeRequests: 0, attemptedCompactions: 0, compactions: 0 });
});
