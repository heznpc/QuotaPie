import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountPool, configurePoolPolicy, readPoolPolicy, savePoolPolicy, validatePoolPolicy, type PoolAccount, type PoolPolicy } from "../src/account-pool";
import { startCompactionProxy } from "../src/codex-compaction";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";

const model = "gpt-6-astra", now = Date.now();
const body = { model, input: [{ role: "user", content: "Continue" }] };
function fixture() {
  const accounts = ["a", "b"].map((id): PoolAccount => ({ id, label: id, identity: id,
    upstreamAccount: id, accessToken: id, tokenExpiresAt: now + 3600_000, models: [model], remaining: 80, validUntil: now + 600_000 }));
  const policy: PoolPolicy = { enabled: true, accounts: ["a", "b"], reservePercent: { a: 30, b: 10 } };
  const pool = new AccountPool({ path: ":memory:", sourceAccount: "a", accounts: () => accounts, policy: () => policy, now: () => now });
  const headers = new Headers({ authorization: "Bearer a", "chatgpt-account-id": "a" });
  const select = (threadId = randomUUID(), input: unknown = body) => pool.select({ threadId, requestId: randomUUID(), body: input, model, headers });
  return { accounts, policy, pool, headers, select };
}

test("threshold routes new work and existing complete history before exhaustion, without returning after a reset", () => {
  const c = fixture();
  try {
    const thread = randomUUID(); expect(c.select(thread)?.route.account).toBe("a");
    c.accounts[0]!.remaining = 30;
    expect(c.select()?.route).toMatchObject({ account: "b", reason: "reserve" });
    expect(c.select(thread, { ...body, input: [...body.input, { role: "assistant", content: "saved progress" }, ...body.input] })?.route)
      .toMatchObject({ account: "b", reason: "reserve", previousAccountLabel: "a" });
    c.accounts[0]!.remaining = 100;
    expect(c.select(thread)?.route).toMatchObject({ account: "b", reason: "pinned" });
  } finally { c.pool.close(); }
});

test("no eligible destination pauses instead of consuming either reserve; headroom prevents oscillation", () => {
  const c = fixture();
  try {
    c.accounts[0]!.remaining = 29; c.accounts[1]!.remaining = 14;
    expect(() => c.select()).toThrow("pool_reserve_reached");
    c.accounts[1]!.remaining = 15;
    expect(c.select()?.route.account).toBe("b");
    c.accounts[1]!.remaining = 10;
    expect(() => c.select()).toThrow("pool_reserve_reached");
  } finally { c.pool.close(); }
});

test("unknown or stale protected quota is never treated as spendable; zero and disabled reserves retain legacy behavior", () => {
  const c = fixture();
  try {
    c.accounts[0]!.remaining = null; c.accounts[1]!.remaining = null;
    expect(() => c.select()).toThrow("pool_reserve_quota_unavailable");
    c.accounts[0]!.remaining = 80; c.accounts[0]!.validUntil = now - 1;
    expect(() => c.select()).toThrow("pool_reserve_quota_unavailable");
    c.policy.reservePercent = { a: 0, b: 0 };
    const thread = randomUUID(); expect(c.select(thread)?.route.account).toBe("a");
    c.policy.reservePercent = { a: 100 }; c.policy.enabled = false;
    expect(c.select(thread)?.route.account).toBe("a");
    expect(c.select()).toBeNull();
  } finally { c.pool.close(); }
});

test("100 percent preserves the whole account; portable history is required for a protected transfer", () => {
  const c = fixture();
  try {
    const thread = randomUUID(); c.select(thread);
    c.accounts[0]!.remaining = 30;
    expect(() => c.select(thread, { ...body, previous_response_id: "opaque" })).toThrow("pool_recovery_requires_full_history");
    c.policy.reservePercent = { a: 100, b: 100 }; c.accounts[0]!.remaining = 100; c.accounts[1]!.remaining = 100;
    expect(() => c.select()).toThrow("pool_reserve_reached");
  } finally { c.pool.close(); }
});

test("an account named constructor has no reserve unless explicitly configured", () => {
  const c = fixture();
  try {
    c.accounts[0]!.remaining = 20;
    c.accounts[1]!.id = "constructor";
    c.policy.accounts = ["a", "constructor"];
    c.policy.reservePercent = { a: 30 };
    expect(c.select()?.route.account).toBe("constructor");
  } finally { c.pool.close(); }
});

test("a dispatched response completes even when the threshold is crossed; only the next request pauses", async () => {
  const c = fixture(); let calls = 0;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => {
    calls++; c.accounts[0]!.remaining = 25; c.accounts[1]!.remaining = 0;
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const headers = new Headers(c.headers); headers.set("session_id", randomUUID());
    const request = () => fetch(proxy.baseUrl + "/responses", { method: "POST", headers, body: JSON.stringify(body) });
    const first = await request(); expect(first.status).toBe(200); await first.text();
    const second = await request(); expect(second.status).toBe(409);
    expect((await second.json() as any).error.code).toBe("pool_reserve_reached");
    expect(calls).toBe(1);
  } finally { proxy.stop(); c.pool.close(); }
});

test("reserve policy validates account membership and percentages, persists edits, and preserves other settings", () => {
  expect(validatePoolPolicy({ enabled: true, accounts: ["a", "b"] }).reservePercent).toBeUndefined();
  for (const reserve of [-1, 101, 5.5, "20", null, NaN])
    expect(() => validatePoolPolicy({ enabled: true, accounts: ["a"], reservePercent: { a: reserve } })).toThrow();
  expect(() => validatePoolPolicy({ enabled: true, accounts: ["a"], reservePercent: { unknown: 20 } })).toThrow();
  const root = mkdtempSync(join(tmpdir(), "qp-reserve-")), path = join(root, "policy.json");
  try {
    savePoolPolicy({ enabled: true, accounts: ["a", "b"], reservePercent: { b: 10 } }, path);
    configurePoolPolicy({ account: "a", reservePercent: 30 }, path);
    configurePoolPolicy({ enabled: false }, path);
    expect(readPoolPolicy(path)).toEqual({ enabled: false, accounts: ["a", "b"], reservePercent: { a: 30, b: 10 } });
    expect(() => configurePoolPolicy({ account: "a", reservePercent: 110 }, path)).toThrow();
    expect(readPoolPolicy(path).reservePercent?.a).toBe(30);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local settings endpoint requires its capability, refuses web origins and never alters unrelated accounts", async () => {
  const root = mkdtempSync(join(tmpdir(), "qp-reserve-api-")), path = join(root, "policy.json");
  const config = structuredClone(DEFAULT_CONFIG); config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  savePoolPolicy({ enabled: true, accounts: ["a", "b"], reservePercent: { b: 10 } }, path);
  const server = startDashboard(service, config, { poolPolicyPath: path, poolDatabasePath: join(root, "missing.sqlite3"), compactionRoot: root });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const status = await (await fetch(origin + "/api/status")).json() as any;
    const change = (headers: Record<string, string>, data: unknown) => fetch(origin + "/api/account-pool/policy", {
      method: "POST", headers, body: JSON.stringify(data) });
    const patch = { account: "a", reservePercent: 30 };
    expect((await change({}, patch)).status).toBe(403);
    const headers = { "x-quotapie-action-token": status.actionToken };
    expect((await change({ ...headers, origin: "https://example.com" }, patch)).status).toBe(403);
    const saved = await change(headers, patch); expect(saved.status).toBe(200);
    expect((await saved.json() as any).pool.reservePercent).toEqual({ a: 30, b: 10 });
    expect((await change(headers, { ...patch, account: "other" })).status).toBe(400);
    expect(readPoolPolicy(path).reservePercent).toEqual({ a: 30, b: 10 });
  } finally { server.stop(true); service.close(); rmSync(root, { recursive: true, force: true }); }
});
