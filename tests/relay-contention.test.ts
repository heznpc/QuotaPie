import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccountPool, type PoolAccount } from "../src/account-pool";
import { startCompactionProxy } from "../src/codex-compaction";

const model = "gpt-6-astra";
const body = { model, stream: true, input: [{ role: "user", content: "synthetic" }] };
const done = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
const bytes = (value: string) => new TextEncoder().encode(value);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function fixture(contentionWaitMs = 3000) {
  const dir = mkdtempSync(join(tmpdir(), "qp-relay-contention-")), path = join(dir, "pool.db");
  const now = Date.now();
  const accounts = ["source", "other"].map((id, i): PoolAccount => ({ id, label: id, identity: id,
    accessToken: id, upstreamAccount: id, tokenExpiresAt: now + 3600000, models: [model],
    remaining: i ? 80 : 50, validUntil: now + 600000 }));
  const options = { path, sourceAccount: "source", accounts: () => accounts,
    policy: () => ({ enabled: true, accounts: ["source", "other"] }), contentionWaitMs };
  const pool = new AccountPool(options), lock = new Database(path);
  const headers = () => ({ authorization: "Bearer source", "chatgpt-account-id": "source", session_id: randomUUID() });
  const input = () => ({ threadId: randomUUID(), requestId: randomUUID(), body, model, headers: new Headers(headers()) });
  return { pool, lock, accounts, options, headers, input, close: () => { lock.close(); pool.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function bounded<T>(promise: Promise<T>, ms = 1200): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("event loop stalled behind SQLite")), ms); })]); }
  finally { clearTimeout(timer!); }
}

test("a SQLite writer cannot stall live SSE or health while another request waits for its route", async () => {
  const c = fixture();
  let upstreamCalls = 0, controller!: ReadableStreamDefaultController<Uint8Array>, locked = false;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => {
    upstreamCalls++;
    if (upstreamCalls > 1) return new Response(done, { headers: { "content-type": "text/event-stream" } });
    c.lock.run("BEGIN IMMEDIATE"); locked = true;
    return new Response(new ReadableStream({ start(value) { controller = value; controller.enqueue(bytes('data: {"type":"response.output_text.delta","delta":"one"}\n\n')); } }),
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const response = await bounded(fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body) }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await bounded(reader.read())).value)).toContain("one");
    const waiting = fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body) });
    await pause(30);
    controller.enqueue(bytes('data: {"type":"response.output_text.delta","delta":"two"}\n\n'));
    const started = performance.now();
    const [chunk, health] = await bounded(Promise.all([reader.read(), fetch(proxy.baseUrl + "/quotapie-health").then(r => r.json())]));
    expect(new TextDecoder().decode(chunk.value)).toContain("two");
    expect((health as any).activeRequests).toBe(2);
    expect(performance.now() - started).toBeLessThan(1200);
    expect(upstreamCalls).toBe(1);
    c.lock.run("COMMIT"); locked = false;
    expect(await (await waiting).text()).toContain("response.completed");
    controller.enqueue(bytes(done)); controller.close();
    while (!(await reader.read()).done) { /* consume terminal */ }
    // Deferred response and finish writes must retain their per-request order.
    for (let i = 0; i < 50 && (c.lock.query("SELECT COUNT(*) AS n FROM requests WHERE state='completed' AND status=200").get() as any).n < 2; i++) await pause(10);
    expect(c.lock.query("SELECT COUNT(*) AS n FROM requests WHERE state='completed' AND status=200").get()).toEqual({ n: 2 });
    expect(upstreamCalls).toBe(2);
  } finally { if (locked) c.lock.run("ROLLBACK"); proxy.stop(); c.close(); }
});

test("routing contention is bounded and never sends an uncommitted request", async () => {
  const c = fixture(100); let calls = 0;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => { calls++; return new Response(done); } });
  c.lock.run("BEGIN IMMEDIATE");
  try {
    const response = await bounded(fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body) }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("pool_storage_busy");
    expect(calls).toBe(0);
  } finally { c.lock.run("ROLLBACK"); proxy.stop(); await pause(60); c.close(); }
});

test("a request cancelled while awaiting its binding never dispatches inference", async () => {
  const c = fixture(); let calls = 0;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => { calls++; return new Response(done); } });
  const abort = new AbortController();
  c.lock.run("BEGIN IMMEDIATE");
  try {
    const request = fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body), signal: abort.signal }).catch(() => null);
    await pause(40); abort.abort(); await request; await pause(30);
    c.lock.run("COMMIT");
    await pause(80);
    expect(calls).toBe(0);
    expect(c.lock.query("SELECT COUNT(*) AS n FROM requests WHERE state='started'").get()).toEqual({ n: 0 });
  } finally { if (c.lock.inTransaction) c.lock.run("ROLLBACK"); proxy.stop(); c.close(); }
});

for (const status of [401, 403, 429]) test(`HTTP ${status} cooldown is persisted asynchronously before any recovery`, async () => {
  const c = fixture(); let calls = 0, locked = false;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => {
    calls++;
    if (calls === 1) {
      c.lock.run("BEGIN IMMEDIATE"); locked = true;
      return new Response("rejected", { status, headers: { "retry-after": "60" } });
    }
    expect(status).toBe(429);
    expect(c.lock.query("SELECT COUNT(*) AS n FROM cooldowns WHERE identity='source'").get()).toEqual({ n: 1 });
    return new Response(done, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const response = fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body) });
    for (let i = 0; !locked && i < 50; i++) await pause(10);
    expect(locked).toBe(true);
    expect((await bounded(fetch(proxy.baseUrl + "/quotapie-health"))).status).toBe(200);
    expect(calls).toBe(1);
    c.lock.run("COMMIT"); locked = false;
    const result = await response;
    expect(result.status).toBe(status === 429 ? 200 : status); await result.text();
    if (status !== 429) expect(c.lock.query("SELECT COUNT(*) AS n FROM auth_cooldowns WHERE identity='source'").get()).toEqual({ n: 1 });
    expect(calls).toBe(status === 429 ? 2 : 1);
  } finally { if (locked) c.lock.run("ROLLBACK"); proxy.stop(); await pause(10); c.close(); }
});

test("failed cooldown persistence preserves the original 429 without dispatching failover", async () => {
  const c = fixture(80); let calls = 0, locked = false;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => {
    calls++; c.lock.run("BEGIN IMMEDIATE"); locked = true;
    return new Response("rejected", { status: 429 });
  } });
  try {
    const response = await bounded(fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body) }));
    expect(response.status).toBe(429); expect(await response.text()).toBe("rejected"); expect(calls).toBe(1);
  } finally { if (locked) c.lock.run("ROLLBACK"); proxy.stop(); await pause(60); c.close(); }
});

test("observed exhaustion survives stale telemetry, token refresh and restart until fresh positive quota", async () => {
  const c = fixture();
  c.accounts[0]!.remaining = 0; c.accounts[1]!.remaining = 0;
  try {
    expect(() => c.pool.select(c.input())).toThrow("pool_source_quota_exhausted");
    Object.assign(c.accounts[0]!, { remaining: null, validUntil: 0, accessToken: "refreshed" });
    const input = c.input(); input.headers.set("authorization", "Bearer refreshed");
    await expect(c.pool.selectAsync(input)).rejects.toThrow("pool_source_quota_exhausted");
    const restarted = new AccountPool(c.options);
    try {
      expect(() => restarted.select({ ...input, requestId: randomUUID() })).toThrow("pool_source_quota_exhausted");
      c.accounts[0]!.remaining = 90; // Expired positive data is not a reset.
      expect(() => restarted.select({ ...input, requestId: randomUUID() })).toThrow("pool_source_quota_exhausted");
      c.accounts[0]!.validUntil = Date.now() + 60000;
      expect(restarted.select({ ...input, requestId: randomUUID() })?.route.account).toBe("source");
    } finally { restarted.close(); }
  } finally { c.close(); }
});

test("a different authenticated identity does not inherit another login's exhaustion", () => {
  const c = fixture();
  try {
    c.accounts[0]!.remaining = 0; c.accounts[1]!.remaining = 0;
    expect(() => c.pool.select(c.input())).toThrow("pool_source_quota_exhausted");
    Object.assign(c.accounts[0]!, { identity: "new-login", accessToken: "new-token", upstreamAccount: "new-login", remaining: null, validUntil: 0 });
    const input = c.input(); input.headers.set("authorization", "Bearer new-token"); input.headers.set("chatgpt-account-id", "new-login");
    expect(c.pool.select(input)?.route.account).toBe("source");
  } finally { c.close(); }
});

test("an exhausted bound alternate cannot spend credits after its quota snapshot expires", () => {
  const c = fixture();
  try {
    c.accounts[0]!.remaining = 0;
    c.accounts[0]!.observedAtMs = Date.now();
    const input = c.input();
    expect(c.pool.select(input)?.route.account).toBe("other");
    c.accounts[1]!.remaining = 0;
    expect(() => c.pool.select({ ...input, requestId: randomUUID() })).toThrow("pool_target_quota_exhausted");
    Object.assign(c.accounts[1]!, { remaining: null, validUntil: 0, accessToken: "other-refreshed" });
    expect(() => c.pool.select({ ...input, requestId: randomUUID() })).toThrow("pool_target_quota_exhausted");
    // Fresh recovery elsewhere still allows portable history to move safely.
    c.accounts[0]!.remaining = 25;
    // Recovery is a newer observation even when this test finishes within one millisecond.
    c.accounts[0]!.observedAtMs! += 1;
    expect(c.pool.select({ ...input, requestId: randomUUID() })?.route).toMatchObject({ account: "source", reason: "recovered" });
  } finally { c.close(); }
});

test("routing rechecks quota after waiting for a writer instead of dispatching stale eligibility", async () => {
  const c = fixture();
  c.lock.run("BEGIN IMMEDIATE");
  try {
    const selecting = c.pool.selectAsync(c.input());
    await pause(25);
    c.accounts[0]!.remaining = 0; c.accounts[1]!.remaining = 0;
    c.lock.run("COMMIT");
    await expect(selecting).rejects.toThrow("pool_source_quota_exhausted");
    expect(c.lock.query("SELECT COUNT(*) AS n FROM requests WHERE state='started'").get()).toEqual({ n: 0 });
  } finally { if (c.lock.inTransaction) c.lock.run("ROLLBACK"); c.close(); }
});

test("closing a pool rejects pending routing and ordered telemetry without touching its closed database", async () => {
  const c = fixture();
  c.lock.run("BEGIN IMMEDIATE");
  const pending = [c.pool.selectAsync(c.input()), c.pool.responseAsync("pending", "source", 200, null), c.pool.finishAsync("pending", "completed")];
  const results = Promise.allSettled(pending);
  try {
    await pause(20); c.pool.close(); c.lock.run("ROLLBACK");
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.code).toBe("pool_closed");
    }
  } finally { if (c.lock.inTransaction) c.lock.run("ROLLBACK"); c.close(); }
});

test("cancellation while waiting for a 429 replacement binding never dispatches the replacement", async () => {
  const c = fixture(); let calls = 0, selections = 0, locked = false;
  const select = c.pool.selectAsync.bind(c.pool);
  c.pool.selectAsync = (input, signal) => {
    if (++selections === 2) { c.lock.run("BEGIN IMMEDIATE"); locked = true; }
    return select(input, signal);
  };
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => { calls++; return new Response("rejected", { status: 429 }); } });
  const abort = new AbortController();
  try {
    const response = fetch(proxy.baseUrl + "/responses", { method: "POST", headers: c.headers(), body: JSON.stringify(body), signal: abort.signal }).catch(() => null);
    for (let i = 0; !locked && i < 50; i++) await pause(10);
    expect(locked).toBe(true);
    abort.abort(); await response; await pause(25);
    c.lock.run("COMMIT"); locked = false;
    await pause(70);
    expect(calls).toBe(1);
    expect(c.lock.query("SELECT COUNT(*) AS n FROM requests WHERE state='started'").get()).toEqual({ n: 0 });
  } finally { if (locked) c.lock.run("ROLLBACK"); proxy.stop(); c.close(); }
});

test("older positive snapshots from another relay cannot erase a newer exhausted observation", () => {
  const c = fixture(), observed = Date.now();
  let second: AccountPool | undefined;
  try {
    const staleAccounts = c.accounts.map(account => ({ ...account, observedAtMs: observed - 1000 }));
    c.accounts[0]!.remaining = 0; c.accounts[0]!.observedAtMs = observed;
    c.accounts[1]!.remaining = 0; c.accounts[1]!.observedAtMs = observed;
    expect(() => c.pool.select(c.input())).toThrow("pool_source_quota_exhausted");
    second = new AccountPool({ ...c.options, accounts: () => staleAccounts });
    expect(() => second!.select(c.input())).toThrow("pool_source_quota_exhausted");
    expect(c.lock.query("SELECT observed_ms FROM quota_observations WHERE identity='source'").get()).toEqual({ observed_ms: observed });
    staleAccounts[1]!.observedAtMs = observed + 1;
    expect(second.select(c.input())?.route.account).toBe("other");
    staleAccounts[0]!.observedAtMs = observed + 1;
    expect(second.select(c.input())?.route.account).toBe("source");
    // A late old zero observation must not invalidate a newer recovery either.
    expect(c.pool.select(c.input())?.route.account).toBe("source");
    expect(c.lock.query("SELECT exhausted FROM quota_observations WHERE identity='source'").get()).toEqual({ exhausted: 0 });
  } finally { second?.close(); c.close(); }
});

test("exhaustion wins timestamp ties in either observation order and only newer quota clears it", () => {
  const c = fixture(), observed = Date.now() + 100;
  try {
    for (const account of c.accounts) { account.remaining = 40; account.observedAtMs = observed; }
    expect(c.pool.select(c.input())?.route.account).toBe("source");
    for (const account of c.accounts) account.remaining = 0;
    expect(() => c.pool.select(c.input())).toThrow("pool_source_quota_exhausted");
    for (const account of c.accounts) account.remaining = 40;
    expect(() => c.pool.select(c.input())).toThrow("pool_source_quota_exhausted");
    expect(c.lock.query("SELECT exhausted FROM quota_observations WHERE identity='source'").get()).toEqual({ exhausted: 1 });
    c.accounts[0]!.observedAtMs = observed + 1;
    expect(c.pool.select(c.input())?.route.account).toBe("source");
  } finally { c.close(); }
});
