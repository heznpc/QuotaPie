import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool, poolStatus, type PoolAccount } from "../src/account-pool";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";

const model = "gpt-6-astra";
const body = { model, input: [{ role: "user", content: "Continue the investigation" }] };
const completed = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  { headers: { "content-type": "text/event-stream" } });

async function fixture(run: (context: {
  accounts: PoolAccount[]; events: CompactionRequestEvent[]; dbPath: string; policyPath: string;
  advance: (ms: number) => void;
  upstream: (handler: (headers: Headers) => Response) => void;
  request: (thread: string, input?: unknown) => Promise<Response>;
  health: () => Promise<any>;
}) => Promise<void>) {
  let now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "qp-recovery-"));
  const dbPath = join(directory, "pool.sqlite3"), policyPath = join(directory, "absent-policy.json");
  const accounts = ["source", "other"].map((id, index): PoolAccount => ({
    id, label: id, identity: id + "-identity", accessToken: id + "-token", upstreamAccount: id + "-upstream",
    tokenExpiresAt: now + 3600_000, models: [model], remaining: index ? 80 : 0, validUntil: now + 600_000,
  }));
  const events: CompactionRequestEvent[] = [];
  let handler = (_headers: Headers) => completed();
  const pool = new AccountPool({ path: dbPath, sourceAccount: "source", accounts: () => accounts,
    policy: () => ({ enabled: true, accounts: ["source", "other"] }), now: () => now });
  const proxy = startCompactionProxy({ accountPool: pool, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" },
    onRequest: e => events.push(e), fetchUpstream: async (_url, init) => handler(new Headers(init.headers)) });
  try {
    await run({ accounts, events, dbPath, policyPath, advance: ms => { now += ms; }, upstream: next => { handler = next; },
      request: (thread, input = body) => fetch(proxy.baseUrl + "/responses", { method: "POST",
        headers: { authorization: "Bearer source-token", "chatgpt-account-id": "source-upstream", session_id: thread },
        body: typeof input === "string" ? input : JSON.stringify(input) }),
      health: () => fetch(proxy.baseUrl + "/quotapie-health").then(r => r.json()),
    });
  } finally { proxy.stop(); pool.close(); rmSync(directory, { recursive: true, force: true }); }
}

test("an exhausted binding moves full history to an account with capacity", async () => fixture(async c => {
  const thread = randomUUID(), served: string[] = [];
  c.upstream(headers => { served.push(headers.get("authorization")!); return completed(); });
  await (await c.request(thread)).text();
  c.accounts[1]!.remaining = 0;
  c.accounts[0]!.remaining = 95;
  c.advance(1);
  const resumed = await c.request(thread);
  expect(resumed.status).toBe(200); await resumed.text();
  await (await c.request(randomUUID())).text();
  expect(served).toEqual(["Bearer other-token", "Bearer source-token", "Bearer source-token"]);
  expect(c.events.filter(e => e.phase === "completed").map(e => e.accountRouting?.reason)).toEqual(["new", "recovered", "new"]);
}));

test("a new text task stops before paid fallback when source quota is exhausted", async () => fixture(async c => {
  c.accounts[0]!.remaining = 0;
  c.accounts[1]!.remaining = null;
  c.upstream(() => { throw new Error("An exhausted request reached the provider"); });
  const response = await c.request(randomUUID(), { ...body, input: [{ role: "user", content: `codex://threads/${randomUUID()}` }] });
  expect(response.status).toBe(409);
  expect((await response.json() as any).error.code).toBe("pool_source_quota_exhausted");
}));

test("real rate limits retain their account and expose bounded cooldown rejection evidence", async () => fixture(async c => {
  let calls = 0;
  c.upstream(headers => {
    expect(headers.get("authorization")).toBe("Bearer other-token");
    return ++calls === 1 ? new Response("provider rate limit", { status: 429, headers: { "retry-after": "60" } }) : completed();
  });
  const thread = randomUUID();
  const first = await c.request(thread); expect(first.status).toBe(429); await first.text();
  const retry = await c.request(thread);
  expect(retry.status).toBe(429);
  expect(retry.headers.get("retry-after")).toBe("60");
  const error = await retry.json() as any;
  expect(error.error.code).toBe("pool_account_cooldown");
  expect(error.error.message).toContain("60 seconds");
  expect(calls).toBe(1);
  expect(c.events.at(-1)).toMatchObject({ threadId: thread, phase: "failed", errorCode: "pool_account_cooldown", status: 429 });
  const health = await c.health();
  expect(health.activeRequests).toBe(0);
  expect(health.rejectedRequests).toBe(1);
  expect(health.recent.at(-1).errorCode).toBe("pool_account_cooldown");
  expect(JSON.stringify(poolStatus(c.dbPath, c.policyPath))).toContain("pool_account_cooldown");
  expect(JSON.stringify(c.events)).not.toContain("other-token");
  c.advance(60_001);
  c.accounts[1]!.remaining = 0;
  const exhausted = await c.request(thread); expect(exhausted.status).toBe(409);
  expect((await exhausted.json() as any).error.code).toBe("pool_target_quota_exhausted");
  expect(calls).toBe(1);
  c.advance(1); c.accounts[1]!.remaining = 35;
  const recovered = await c.request(thread); expect(recovered.status).toBe(200); await recovered.text();
  expect(calls).toBe(2);
  expect(c.events.at(-1)?.accountRouting?.account).toBe("other");
}));

test("credential refresh recovers authentication rejection without quota misclassification", async () => fixture(async c => {
  let calls = 0;
  c.upstream(headers => {
    calls++;
    return headers.get("authorization") === "Bearer other-token" ? new Response("unauthorized", { status: 401 }) : completed();
  });
  const thread = randomUUID();
  const first = await c.request(thread); expect(first.status).toBe(401); await first.text();
  expect(poolStatus(c.dbPath, c.policyPath).error).toBe("pool_auth_cooldown");
  const second = await c.request(thread); expect(second.status).toBe(401);
  expect((await second.json() as any).error.code).toBe("pool_auth_cooldown");
  expect(calls).toBe(1);
  c.accounts[1]!.accessToken = "other-refreshed-token";
  const recovered = await c.request(thread); expect(recovered.status).toBe(200); await recovered.text();
  expect(calls).toBe(2);
  expect(poolStatus(c.dbPath, c.policyPath).error).toBeNull();
}));

test("invalid request JSON stays a client error with an enabled account pool", async () => fixture(async c => {
  let calls = 0;
  c.upstream(() => { calls++; return completed(); });
  const response = await c.request(randomUUID(), "{broken-json");
  expect(response.status).toBe(400); await response.text();
  expect(calls).toBe(0);
  const health = await c.health();
  expect(health.activeRequests).toBe(0);
  expect(health.rejectedRequests).toBe(0);
}));
