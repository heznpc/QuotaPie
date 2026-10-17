import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompactionStatusReader } from "../src/compaction-status";
import { startCompactionProxy } from "../src/codex-compaction";
import { DEFAULT_TASK_SAVINGS } from "../src/task-savings";

test("guard diagnostics expose repeated holds and mixed live revisions without transport or login data", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-guard-status-")));
  const now = Date.parse("2026-10-13T03:00:00Z");
  const token = "cd".repeat(24), route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" };
  const blocked = { requestId: "11111111-1111-4111-8111-111111111111", threadId: null, turnId: null,
    kind: "response", from: "gpt-6-astra", to: "gpt-6-astra", routed: false, phase: "failed", status: 400,
    requestedEffort: null, reasoningEffort: null, at: new Date(now).toISOString(), durationMs: 1,
    errorCode: "subscription_quota_stale" };
  try {
    const directories = [root, join(root, "releases", "1"), join(root, "releases", "2")];
    for (const [index, directory] of directories.entries()) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "settings.json"), JSON.stringify({ port: 45001 + index, token, route }));
    }
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: join(root, "settings.json") }));
    await writeFile(join(root, "relay.log"), JSON.stringify(blocked) + "\n");
    const reader = new CompactionStatusReader(root, (async (input: RequestInfo | URL) => {
      const index = Number(new URL(String(input)).port) - 45001;
      return Response.json({ service: "quotapie-compaction", schemaVersion: 3, route, taskSavings: DEFAULT_TASK_SAVINGS,
        subscriptionGuardVersion: index === 2 ? 0 : 1,
        ...(index === 2 ? {} : { subscriptionGuardRevision: index === 0 ? 3 : 1 }), activeRequests: index,
        subscriptionGuard: index === 2 ? null : { version: 1, account: index === 0 ? "primary" : "second",
          profileKey: "private-profile-key", email: "private@example.com", token, endpoint: "https://secret.example.com", path: root,
          ready: false, reason: index === 0 ? "quota-stale" : "reserve-reached", blockedRequests: index === 0 ? 24 : 3,
          abortedRequests: index === 0 ? 2 : 0,
          blockedByReason: index === 0 ? { "quota-stale": 20, "collection-unavailable": 4 } : { "reserve-reached": 3 },
          windows: [{ bucket: "codex:primary:300", remainingPercent: 63, reservePercent: 0, observedAtMs: now - 125000 },
            { bucket: "https://secret.example.com", remainingPercent: 100, reservePercent: 0, observedAtMs: now }] },
        recent: index === 0 ? [blocked] : index === 1 ? [blocked, { ...blocked,
          requestId: "22222222-2222-4222-8222-222222222222", errorCode: "subscription_reserve_reached" }] : [] });
    }) as unknown as typeof fetch);
    const status = await reader.status(now);
    expect(status.subscriptionProtection).toMatchObject({ expectedRevision: 3, reachable: 3, outOfDate: 2,
      revisionMismatch: true, blockedRequests: 27, abortedRequests: 2, activeRequests: 3,
      blockedByReason: { "quota-stale": 20, "collection-unavailable": 4, "reserve-reached": 3 },
      observedBlocksByReason: { "quota-stale": 1, "reserve-reached": 1 } });
    expect(status.subscriptionProtection.relays[0]).toEqual({ generation: 1, reachable: true, revision: 3, outOfDate: false,
      executionMode: "managed", enforcement: null, nativePolicyCurrent: false, listenerPolicyCurrent: false,
      account: "primary", ready: false, reason: "quota-stale", blockedRequests: 24, abortedRequests: 2, activeRequests: 0,
      blockedByReason: { "quota-stale": 20, "collection-unavailable": 4 },
      windows: [{ bucket: "codex:primary:300", remainingPercent: 63, reservePercent: 0, observedAgeMs: 125000 }] });
    expect(status.subscriptionProtection.relays[2]).toMatchObject({ revision: null, outOfDate: true, account: null,
      ready: null, reason: "guard-unavailable" });
    const serialized = JSON.stringify(status.subscriptionProtection);
    for (const secret of [token, root, "private-profile-key", "private@example.com", "secret.example.com", "endpoint", "profileKey"])
      expect(serialized).not.toContain(secret);
    const stale = reader.snapshot(now + 20000);
    expect(stale.subscriptionProtection).toMatchObject({ reachable: 0, activeRequests: 0, outOfDate: 0, revisionMismatch: false,
      blockedRequests: 27, blockedByReason: { "quota-stale": 20, "collection-unavailable": 4, "reserve-reached": 3 } });
    expect(stale.subscriptionProtection.relays.every(r => !r.reachable && r.ready === null && r.reason === "observer-state-stale")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("guard diagnostics sanitize malformed fields and do not call an unreachable relay ready", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-guard-sanitize-")));
  const now = Date.parse("2026-10-13T03:00:00Z");
  const route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" };
  let reachable = true;
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ port: 45001, token: "ef".repeat(24), route }));
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: join(root, "settings.json") }));
    const reader = new CompactionStatusReader(root, (async () => {
      if (!reachable) throw new Error("https://secret.example.com/private-token");
      return Response.json({ service: "quotapie-compaction", schemaVersion: 3, route, activeRequests: -10,
        subscriptionGuardVersion: 1, subscriptionGuardRevision: 3, subscriptionGuard: { version: 1,
          account: "private@example.com", reason: "https://secret.example.com/private-token", ready: "true",
          blockedRequests: -1, abortedRequests: "20", blockedByReason: { "private@example.com": 2, "quota-stale": -4 },
          windows: [{ bucket: "codex:primary:300", remainingPercent: 101, reservePercent: -1, observedAtMs: now + 1 }] } });
    }) as unknown as typeof fetch);
    expect(reader.snapshot(now).subscriptionProtection).toMatchObject({ reachable: 0, relays: [] });
    const first = await reader.status(now);
    expect(first.subscriptionProtection).toMatchObject({ reachable: 1, outOfDate: 0, revisionMismatch: false,
      blockedRequests: 0, abortedRequests: 0, activeRequests: 0, blockedByReason: { unknown: 2 } });
    expect(first.subscriptionProtection.relays[0]).toMatchObject({ account: null, ready: null, reason: "unknown",
      windows: [{ bucket: "codex:primary:300", remainingPercent: null, reservePercent: null, observedAgeMs: null }] });
    expect(JSON.stringify(first.subscriptionProtection)).not.toContain("private");
    reachable = false;
    const lost = await reader.status(now + 3000);
    expect(lost.subscriptionProtection).toMatchObject({ reachable: 0, outOfDate: 0, revisionMismatch: false,
      relays: [{ reachable: false, revision: null, outOfDate: false, account: null, ready: null, reason: "relay-unreachable" }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("observation reuses validated settings for both policies while still observing unlisted generations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-shared-settings-")));
  const paths = [join(root, "releases", "1", "settings.json"), join(root, "releases", "2", "settings.json")];
  const route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" };
  let requests = 0;
  try {
    for (let i = 0; i < paths.length; i++) {
      await mkdir(join(root, "releases", String(i + 1)), { recursive: true });
      await writeFile(paths[i]!, JSON.stringify({ port: 45001 + i, token: "ab".repeat(24), route }));
    }
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: paths[0] }));
    const reader = new CompactionStatusReader(root, (async () => {
      requests++;
      // The observer already validated this version. A concurrent editor must
      // not force more settings scans or leak a mixed policy snapshot.
      await writeFile(paths[0]!, "{");
      return Response.json({ service: "quotapie-compaction", schemaVersion: 3, route,
        taskSavings: DEFAULT_TASK_SAVINGS, savingsModelSupported: true });
    }) as unknown as typeof fetch);
    const status = await reader.status();
    expect(requests).toBe(2);
    expect(status.generations).toBe(2);
    expect(status.reachable).toBe(2);
    expect(status.policy).toMatchObject({ model: "gpt-5.6-sol", configurable: true, generations: 1 });
    expect(status.savings.policy).toMatchObject({ configurable: true, generations: 1 });
    // Mutation does not reuse the observer's cached settings.
    await expect(reader.policy.configure("gpt-5.6-luna")).rejects.toThrow("policy_update_failed");
    await expect(reader.savingsPolicy.configure({ enabled: true })).rejects.toThrow("savings_update_failed");
    const refreshed = await reader.status(status.checkedAtMs + 3000);
    expect(refreshed.policy).toBeNull();
    expect(refreshed.savings.policy).toBeNull();
    expect(refreshed.generations).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared settings retain required profile validation and ignore invalid retired policies independently", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-retired-policy-")));
  const current = join(root, "settings.json"), retired = join(root, "releases", "1", "settings.json");
  const route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" };
  try {
    await mkdir(join(root, "releases", "1"), { recursive: true });
    await writeFile(current, JSON.stringify({ port: 45001, token: "ab".repeat(24), route }));
    await writeFile(retired, JSON.stringify({ port: 45002, token: "ab".repeat(24), route: {} }));
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: current, retired_settings: [retired] }));
    const reader = new CompactionStatusReader(root, (async () => Response.json({ service: "quotapie-compaction", schemaVersion: 3,
      route, taskSavings: DEFAULT_TASK_SAVINGS, savingsModelSupported: true })) as unknown as typeof fetch);
    const status = await reader.status();
    expect(status.policy).toMatchObject({ generations: 1, configurable: true });
    expect(status.savings.policy).toMatchObject({ generations: 2, configurable: true });
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: current, profile_settings: { second: retired } }));
    const required = await reader.status(status.checkedAtMs + 3000);
    expect(required.policy).toBeNull();
    expect(required.savings.policy).not.toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reads retired generations, distinguishes HTTP headers, completion and lost live state without exposing credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-observation-")));
  const generation = join(root, "releases", "123");
  await mkdir(generation, {recursive:true});
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const events: any[] = [];
  const token = "ab".repeat(24);
  const proxy = startCompactionProxy({token, fetchUpstream: async () => new Response(new ReadableStream({start(c) {controller=c; c.enqueue(new TextEncoder().encode(": keepalive\n\n"));}}),
    {headers:{"content-type":"text/event-stream"}}), onRequest: e => events.push(e)});
  try {
    const settings = {port:Number(new URL(proxy.baseUrl).port), token,
      route:{from:"gpt-6-astra",to:"gpt-5.6-sol",effort:"low"}};
    await writeFile(join(generation, "settings.json"), JSON.stringify(settings));
    await writeFile(join(root, "current.json"), JSON.stringify({settings_path:join(generation, "settings.json")}));
    const response = await fetch(proxy.baseUrl + "/responses/compact", {method:"POST", body:JSON.stringify({model:"gpt-6-astra",reasoning:{effort:"xhigh"}})});
    const body = response.text();
    // Headers reached the client; the compaction is still in progress.
    let healthRequests = 0;
    const reader = new CompactionStatusReader(root, ((...args: Parameters<typeof fetch>) => {
      healthRequests++;
      return fetch(...args);
    }) as unknown as typeof fetch);
    const running = await reader.status();
    expect(healthRequests).toBe(1);
    expect(running.policy).not.toBeNull();
    expect(running.savings.policy).not.toBeNull();
    expect(running.active[0]?.phase).toBe("response_headers");
    expect(running.active[0]?.to).toBe("gpt-5.6-sol");
    expect(running.active[0]?.reasoningEffort).toBe("low");
    expect(running.recent).toHaveLength(0);
    const stale = reader.snapshot(running.checkedAtMs + 20_000);
    expect(stale.active).toHaveLength(0);
    expect(stale.recent[0]?.phase).toBe("unverified");
    expect(stale.reachable).toBe(0);
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":20,"output_tokens":5}}}\n\n')); controller.close();
    await body;
    await writeFile(join(generation,"relay.log"), events.map(e=>JSON.stringify(e)).join("\n")+"\n");
    const completed = await reader.status(Date.now()+3000);
    expect(completed.active).toHaveLength(0);
    expect(completed.recent[0]?.phase).toBe("completed");
    expect(completed.recent[0]?.responseModel).toBe("gpt-5.6-sol");
    expect(completed.recent[0]?.usage).toEqual({ input: 20, cachedInput: 0, output: 5 });
    proxy.stop();
    // Retained log survives relay loss. An unfinished log never implies success.
    const unfinished = {...events[0],requestId:"11111111-1111-4111-8111-111111111111"};
    await writeFile(join(root,"settings.json"),JSON.stringify(settings));
    await writeFile(join(root,"relay.log"),JSON.stringify(unfinished)+"\n");
    const lost = await reader.status(Date.now()+6000);
    expect(lost.generations).toBe(2);
    expect(lost.recent.some(e=>e.phase==="unverified")).toBe(true);
    expect(lost.recent.some(e=>e.phase==="completed")).toBe(true);
    expect(JSON.stringify(lost)).not.toContain(token);
    expect(JSON.stringify(lost)).not.toContain("settings.json");
  } finally { proxy.stop(); await rm(root,{recursive:true,force:true}); }
});
