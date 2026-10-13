import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayRuntimeHost } from "../src/relay-runtime-host";
import type { RuntimeFactory, RuntimeSettings } from "../src/codex-relay-runtime";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(factory: RuntimeFactory) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "quotapie-runtime-test-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const settings: RuntimeSettings = { port: 0, token: "a".repeat(48), route: { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" } };
  const settingsPath = join(directory, "settings.json");
  await writeFile(settingsPath, JSON.stringify(settings));
  const host = await startRelayRuntimeHost({ settingsPath, settings, initialFactory: factory });
  cleanups.push(() => host.stop());
  return { host, directory };
}
async function stage(directory: string, label = "updated") {
  const text = `export const relayRuntimeApiVersion = 1;
    export function createRelayRuntime(settings, memory) {
      return { activeRequests: 0, close() {}, async fetch(request) {
        if (request.url.endsWith('/quotapie-health')) return Response.json({service:'quotapie-compaction',route:settings.route});
        return new Response(${JSON.stringify(label)});
      }};
    }`;
  const sourceHash = createHash("sha256").update(text).digest("hex");
  const candidatePath = join(directory, `relay-runtime-${sourceHash}.js`);
  await writeFile(candidatePath, text, { mode: 0o600 });
  await writeFile(join(directory, "runtime-candidate.json"), JSON.stringify({ schemaVersion: 1, sourceHash, candidatePath }));
  return { sourceHash, candidatePath };
}
const simple: RuntimeFactory = () => ({ activeRequests: 0, close() {}, async fetch(request) {
  return request.url.endsWith("/quotapie-health") ? Response.json({ service: "quotapie-compaction" }) : new Response("original");
} });

test("reload keeps the endpoint and lets an admitted stream finish on the old handler", async () => {
  let active = 0, closed = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const { host, directory } = await fixture(() => ({
    get activeRequests() { return active; }, close() { closed++; },
    async fetch(request) {
      if (request.url.endsWith("/quotapie-health")) return Response.json({ service: "quotapie-compaction" });
      active++;
      return new Response(new ReadableStream<Uint8Array>({ start(c) {
        controller = c; c.enqueue(new TextEncoder().encode("before\n"));
      } }));
    },
  }));
  const response = await fetch(host.baseUrl + "/responses");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("before\n");
  const { sourceHash } = await stage(directory);
  const update = await fetch(host.baseUrl + "/quotapie-reload", { method: "POST" });
  expect(update.status).toBe(200);
  expect((await update.json()).runtimeSourceHash).toBe(sourceHash);
  expect(closed).toBe(0);
  expect(await (await fetch(host.baseUrl + "/responses")).text()).toBe("updated");
  controller.enqueue(new TextEncoder().encode("after\n")); controller.close(); active--;
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("after\n");
  expect((await reader.read()).done).toBe(true);
  await Bun.sleep(130);
  expect(closed).toBe(1);
  expect(JSON.parse(await readFile(join(directory, "runtime-current.json"), "utf8")).sourceHash).toBe(sourceHash);
});

test("reload does not release a handler awaiting request parsing before it counts a stream", async () => {
  let release!: () => void, entered!: () => void, closed = 0;
  const admission = new Promise<void>(r => { entered = r; });
  const wait = new Promise<void>(r => { release = r; });
  const { host, directory } = await fixture(() => ({ activeRequests: 0, close() { closed++; }, async fetch() {
    entered(); await wait; return new Response("finished");
  } }));
  const response = fetch(host.baseUrl + "/responses");
  await admission; await stage(directory);
  expect((await fetch(host.baseUrl + "/quotapie-reload", { method: "POST" })).status).toBe(200);
  expect(closed).toBe(0);
  release(); expect(await (await response).text()).toBe("finished");
  expect(closed).toBe(1);
});

test("a damaged candidate leaves existing and subsequent requests available", async () => {
  const { host, directory } = await fixture(simple);
  const { candidatePath } = await stage(directory);
  await writeFile(candidatePath, "invalid candidate");
  expect((await fetch(host.baseUrl + "/quotapie-reload", { method: "POST" })).status).toBe(409);
  expect(host.sourceHash).toBe("embedded");
  expect(await (await fetch(host.baseUrl + "/responses")).text()).toBe("original");
});

test("a path outside the private release is rejected before importing", async () => {
  const { host, directory } = await fixture(simple);
  const staged = await stage(directory);
  await writeFile(join(directory, "runtime-candidate.json"), JSON.stringify({ schemaVersion: 1, ...staged, candidatePath: "/tmp/untrusted.js" }));
  expect((await fetch(host.baseUrl + "/quotapie-reload", { method: "POST" })).status).toBe(409);
  expect(await (await fetch(host.baseUrl + "/responses")).text()).toBe("original");
});

test("simultaneous and repeated reloads use one selected runtime without interrupting requests", async () => {
  const { host, directory } = await fixture(simple);
  const { sourceHash } = await stage(directory);
  const replies = await Promise.all(Array.from({ length: 4 }, () => fetch(host.baseUrl + "/quotapie-reload", { method: "POST" })));
  expect(replies.every(response => response.ok)).toBe(true);
  const health = await (await fetch(host.baseUrl + "/quotapie-health")).json();
  expect(health.runtimeSourceHash).toBe(sourceHash);
  expect(health.retiringRuntimes).toBe(0);
  expect(health.draining).toBe(false);
  expect(await (await fetch(host.baseUrl + "/responses")).text()).toBe("updated");
});

test("the real handler keeps its active request visible and archives its final event across reload", async () => {
  const { createCompactionHandler } = await import("../src/codex-compaction");
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encode = (data: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  const { host, directory } = await fixture(settings => {
    const handler = createCompactionHandler({ ...settings, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" },
      fetchUpstream: async () => new Response(new ReadableStream({ start(controller) {
        stream = controller;
        controller.enqueue(encode({ type: "response.created", response: { id: "resp_fixture_old", model: "gpt-6-astra" } }));
      } }), { headers: { "content-type": "text/event-stream" } }),
    });
    return { fetch: handler.fetch, snapshot: handler.snapshot, get activeRequests() { return handler.activeRequests; }, close() {} };
  });
  const response = await fetch(host.baseUrl + "/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: "local fixture" }) });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("response.created");
  const before = await (await fetch(host.baseUrl + "/quotapie-health")).json();
  expect(before.active).toHaveLength(1);
  const requestId = before.active[0].requestId;
  await stage(directory);
  expect((await fetch(host.baseUrl + "/quotapie-reload", { method: "POST" })).status).toBe(200);
  const during = await (await fetch(host.baseUrl + "/quotapie-health")).json();
  expect(during.activeRequests).toBe(1);
  expect(during.active.map((event: any) => event.requestId)).toContain(requestId);
  stream.enqueue(encode({ type: "response.completed", response: { id: "resp_fixture_old", model: "gpt-6-astra", status: "completed", output: [] } }));
  stream.close();
  while (!(await reader.read()).done) { /* Drain only the synthetic stream. */ }
  await Bun.sleep(130);
  const after = await (await fetch(host.baseUrl + "/quotapie-health")).json();
  expect(after.activeRequests).toBe(0);
  expect(after.active).toHaveLength(0);
  expect(after.recent.some((event: any) => event.requestId === requestId && event.phase === "completed")).toBe(true);
});

test("pool errors retain their classification between separately bundled runtime generations", async () => {
  const { PoolError } = await import("../src/account-pool");
  const { directory } = await fixture(simple);
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/account-pool.ts")], target: "bun" });
  expect(bundle.success).toBe(true);
  const path = join(directory, "pool-copy.js");
  await writeFile(path, await bundle.outputs[0]!.text());
  const duplicated = await import(path);
  expect(new duplicated.PoolError("pool_source_identity_mismatch", 409)).toBeInstanceOf(PoolError);
  expect(new PoolError("pool_account_cooldown", 429, 15)).toBeInstanceOf(duplicated.PoolError);
  expect({ code: "pool_account_cooldown", status: 429 }).not.toBeInstanceOf(PoolError);
});
