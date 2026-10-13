import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { createSubscriptionGuard } from "../src/subscription-guard";
import { profileReference } from "../src/work-boundary";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
import { PoolError } from "../src/account-pool";

const model = "gpt-6-astra";
const input = { model, stream: true, input: [{ role: "user", content: "fixture" }] };
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qp-subscription-"));
  let now = Date.now() + 1000;
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "fixture", label: "fixture", enabled: true, codexHome: root }];
  const token = (subject: string) => `fixture.${Buffer.from(JSON.stringify({ sub: subject, exp: (now + 3600000) / 1000 })).toString("base64url")}.fixture`;
  const auth = { auth_mode: "chatgpt", OPENAI_API_KEY: null as string | null,
    tokens: { account_id: "fixture-workspace", access_token: token("fixture-person") } };
  const authPath = join(root, "auth.json"), path = join(root, "work-state.json");
  const writeAuth = () => writeFileSync(authPath, JSON.stringify(auth));
  writeAuth();
  writeFileSync(join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: model }, { slug: "gpt-5.6-sol" }] }));
  const state = { schemaVersion: 1, generatedAtMs: now, expiresAtMs: now + 600000,
    accounts: [{ provider: "codex", account: "fixture", profileKey: profileReference(root), collectionState: "recent-success",
      windows: [300, 10080].map((duration, i) => ({ bucket: `codex:${i ? "secondary" : "primary"}:${duration}`,
        windowSeconds: duration * 60, quality: "authoritative", freshness: "fresh", remainingPercent: 80,
        reservePercent: i ? 15 : 10, observedAtMs: now, resetsAtMs: now + 3600000, validUntilMs: now + 600000 })) }] };
  const write = () => writeFileSync(path, JSON.stringify(state)); write();
  let poolReserve = 0;
  const options = { codexHome: root, sourceAccount: "fixture", config: () => config, boundaryPath: path, now: () => now,
    intervalMs: 10, poolPolicy: () => ({ enabled: false, accounts: ["fixture"], reservePercent: { fixture: poolReserve } }) };
  const guard = createSubscriptionGuard(options);
  return { root, config, auth, state, guard, token, write, writeAuth, options,
    now: () => now, advance: (ms: number) => { now += ms; }, reserve: (n: number) => { poolReserve = n; },
    headers: () => ({ authorization: `Bearer ${auth.tokens.access_token}`, "chatgpt-account-id": auth.tokens.account_id }),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("managed report-only requests suppress inherited tools on both response routes", async () => {
  const f = fixture(); const bodies: any[] = [];
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard, reportOnly: true,
    route: { from: model, to: model }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" },
    fetchUpstream: async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ output: [] }); } });
  try {
    for (const route of ["/responses", "/responses/compact"]) {
      const response = await fetch(proxy.baseUrl + route, { method: "POST", headers: { ...f.headers(), "content-type": "application/json" },
        body: JSON.stringify({ ...input, stream: false, tools: [{ type: "function", name: "inherited_writer" }],
          tool_choice: { type: "function", name: "inherited_writer" } }) });
      expect(response.status).toBe(200); await response.text();
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.every(body => body.tool_choice === "none" && body.tools.length === 0)).toBeTrue();
    expect(bodies.every(body => JSON.stringify(body.input) === JSON.stringify(input.input))).toBeTrue();
    expect(() => startCompactionProxy({ reportOnly: true })).toThrow("requires a subscription guard");
  } finally { proxy.stop(); f.close(); }
});

test("subscription reserves apply with pool off and zero reserve still leaves one percent", () => {
  const f = fixture();
  try {
    expect(f.guard.check({ headers: new Headers(f.headers()), model }).ready).toBe(true);
    f.reserve(35); f.state.accounts[0]!.windows[0]!.remainingPercent = 35; f.write();
    expect(f.guard.check()).toMatchObject({ ready: false, reason: "reserve-reached" });
    f.reserve(0); f.config.reservePercent.codex = { short: 0, weekly: 0, other: 0 };
    for (const w of f.state.accounts[0]!.windows) { w.reservePercent = 0; w.remainingPercent = 1; } f.write();
    expect(f.guard.check()).toMatchObject({ ready: false, reason: "reserve-reached" });
    for (const w of f.state.accounts[0]!.windows) w.remainingPercent = 2; f.write();
    expect(f.guard.check().windows.every(w => w.reservePercent === 1)).toBe(true);
    expect(f.guard.check().ready).toBe(true);
  } finally { f.close(); }
});

test("a frozen one-turn usage budget raises each reserve without lowering global or pool protection", () => {
  const f = fixture();
  try {
    const windows = f.state.accounts[0]!.windows;
    const minimumReserveByBucket = Object.fromEntries(windows.map(w => [w.bucket, w.remainingPercent - 5]));
    const baselineResetsAtByBucket = Object.fromEntries(windows.map(w => [w.bucket, w.resetsAtMs]));
    const guard = createSubscriptionGuard({ ...f.options, minimumReserveByBucket, baselineResetsAtByBucket });
    expect(guard.check().ready).toBe(true);
    expect(guard.check().windows.every(w => w.reservePercent === 75)).toBe(true);
    // Caller mutations cannot relax an already admitted turn's cutoff.
    for (const key of Object.keys(minimumReserveByBucket)) minimumReserveByBucket[key] = 0;
    windows[0]!.remainingPercent = 75; f.write();
    expect(guard.check()).toMatchObject({ ready: false, reason: "reserve-reached" });
    windows[0]!.remainingPercent = 80; f.write();
    f.reserve(85); expect(guard.check().windows.every(w => w.reservePercent === 85)).toBe(true);
    f.reserve(0); f.config.reservePercent.codex.weekly = 90;
    expect(guard.check().windows[1]!.reservePercent).toBe(90);
  } finally { f.close(); }
});

test("a changed reset period or quota bucket set cannot rebase an active turn's budget", () => {
  for (const change of ["reset", "missing", "new"] as const) {
    const f = fixture();
    try {
      const windows = f.state.accounts[0]!.windows;
      const minimumReserveByBucket = Object.fromEntries(windows.map(w => [w.bucket, w.remainingPercent - 5]));
      const baselineResetsAtByBucket = Object.fromEntries(windows.map(w => [w.bucket, w.resetsAtMs]));
      const guard = createSubscriptionGuard({ ...f.options, minimumReserveByBucket, baselineResetsAtByBucket });
      if (change === "reset") {
        windows[0]!.resetsAtMs += 3600000;
        baselineResetsAtByBucket[windows[0]!.bucket] = windows[0]!.resetsAtMs;
      } else if (change === "missing") windows.pop();
      else windows.push({ ...windows[0]!, bucket: "new-model:primary:300" });
      f.write();
      expect(guard.check()).toMatchObject({ ready: false, reason: "budget-baseline-changed" });
      // The normal resident guard retains its existing behavior without a budget.
      expect(f.guard.check().ready).toBe(true);
    } finally { f.close(); }
  }
});

test("incomplete or malformed budget bindings fail closed", () => {
  const f = fixture();
  try {
    const windows = f.state.accounts[0]!.windows;
    const minimumReserveByBucket = Object.fromEntries(windows.map(w => [w.bucket, w.remainingPercent - 5]));
    const baselineResetsAtByBucket = Object.fromEntries(windows.map(w => [w.bucket, w.resetsAtMs]));
    for (const budget of [
      { minimumReserveByBucket }, { baselineResetsAtByBucket },
      { minimumReserveByBucket: {}, baselineResetsAtByBucket: {} },
      { minimumReserveByBucket: { ...minimumReserveByBucket, [windows[0]!.bucket]: NaN }, baselineResetsAtByBucket },
      { minimumReserveByBucket, baselineResetsAtByBucket: { ...baselineResetsAtByBucket, [windows[0]!.bucket]: 0 } },
    ]) expect(createSubscriptionGuard({ ...f.options, ...budget }).check()).toMatchObject({ ready: false, reason: "budget-baseline-invalid" });
  } finally { f.close(); }
});

test("unknown, stale, expired, future, reset and wrong-profile observations fail closed", () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.state.accounts[0]!.windows = []; },
    f => { f.state.accounts[0]!.collectionState = "attempted-then-failed"; },
    f => { f.state.accounts[0]!.windows[0]!.quality = "inferred"; },
    f => { f.state.accounts[0]!.windows[0]!.remainingPercent = NaN; },
    f => { f.state.accounts[0]!.windows[0]!.observedAtMs = f.now() + 1; },
    f => { f.state.accounts[0]!.windows[0]!.resetsAtMs = f.now(); },
    f => { f.state.accounts[0]!.windows[0]!.validUntilMs = f.now(); },
    f => { f.state.accounts[0]!.profileKey = "wrong"; },
    f => { f.state.expiresAtMs = f.now(); },
    f => { f.state.generatedAtMs = f.now() + 1; },
    f => { f.advance(120001); },
  ];
  for (const change of changes) {
    const f = fixture();
    try { change(f); f.write(); expect(f.guard.check().ready).toBe(false); }
    finally { f.close(); }
  }
});

test("source profile, ChatGPT credentials and supported models are enforced without exposing credentials", () => {
  const f = fixture();
  try {
    expect(f.guard.check({ headers: new Headers({ ...f.headers(), authorization: "Bearer foreign-token" }), model }).reason)
      .toBe("request-identity-mismatch");
    expect(f.guard.check({ headers: new Headers({ ...f.headers(), "chatgpt-account-id": "foreign" }), model }).reason)
      .toBe("request-identity-mismatch");
    expect(f.guard.check({ model: "unverified-model" }).ready).toBe(false);
    writeFileSync(join(f.root, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-reserve" }] }));
    expect(f.guard.check({ model: "gpt-reserve" }).ready).toBe(false);
    f.auth.OPENAI_API_KEY = "synthetic-api-key"; f.writeAuth();
    expect(f.guard.check().reason).toBe("subscription-auth-required");
    f.auth.OPENAI_API_KEY = null; f.auth.tokens.access_token = f.token("other-person"); f.writeAuth();
    expect(f.guard.check().reason).toBe("account-identity-changed");
    expect(JSON.stringify(f.guard.check())).not.toContain("synthetic");
    expect(createSubscriptionGuard({ ...f.options, sourceAccount: undefined }).check().ready).toBe(false);
    f.config.accounts.codex[0]!.enabled = false;
    expect(f.guard.check().reason).toBe("account-unavailable");
  } finally { f.close(); }
});

test("the relay rejects exhausted, unsupported and background requests before any upstream call", async () => {
  const f = fixture(); let calls = 0;
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard, fetchUpstream: async () => { calls++; return new Response("wrong"); } });
  const request = (body: unknown = input, path = "/responses") => fetch(proxy.baseUrl + path, {
    method: "POST", headers: f.headers(), body: JSON.stringify(body) });
  try {
    for (const body of [{ stream: true }, { ...input, background: true }, { ...input, background: "true" }, { ...input, model: "unknown" }])
      expect((await request(body)).status).toBe(409);
    expect((await request(input, "/responses/background")).status).toBe(409);
    expect((await fetch(proxy.baseUrl + "/responses/remote-id", { headers: f.headers() })).status).toBe(409);
    f.state.accounts[0]!.windows[0]!.remainingPercent = 10; f.write();
    expect((await request()).status).toBe(409);
    const health = await (await fetch(proxy.baseUrl + "/quotapie-health")).json() as any;
    expect(health.subscriptionGuard).toMatchObject({ version: 1, account: "fixture", ready: false, blockedRequests: 7, abortedRequests: 0 });
    expect(health.activeRequests).toBe(0); expect(calls).toBe(0);
  } finally { proxy.stop(); f.close(); }
});

test("observed reserve crossing cancels a silent upstream stream and emits one quota failure", async () => {
  const f = fixture(); const events: CompactionRequestEvent[] = []; let aborted = 0, cancelled = 0;
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard, onRequest: e => events.push(e), fetchUpstream: async (_url, init) => {
    init.signal!.addEventListener("abort", () => aborted++);
    return new Response(new ReadableStream({ start(c) { c.enqueue(frame({ type: "response.output_text.delta", delta: "first" })); },
      cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    f.state.accounts[0]!.windows[0]!.remainingPercent = 9; f.write();
    let text = "";
    while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    expect(text).toContain("subscription_reserve_reached");
    expect(text.split("response.failed")).toHaveLength(2);
    expect(aborted).toBe(1); expect(cancelled).toBe(1);
    expect(events.filter(e => e.phase === "failed")).toHaveLength(1);
    expect(events.filter(e => e.phase === "completed")).toHaveLength(0);
    const health = await (await fetch(proxy.baseUrl + "/quotapie-health")).json() as any;
    expect(health.subscriptionGuard.abortedRequests).toBe(1); expect(health.activeRequests).toBe(0);
    expect((await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) })).status).toBe(409);
  } finally { proxy.stop(); f.close(); }
});

test("stale quota cancels a pending upstream fetch before headers arrive", async () => {
  const f = fixture(); let began!: () => void, aborted = 0;
  const started = new Promise<void>(resolve => { began = resolve; });
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard, fetchUpstream: async (_url, init) => {
    began(); return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); }));
  } });
  try {
    const response = fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) });
    await started; f.advance(120001);
    expect((await response).status).toBe(409); expect(aborted).toBe(1);
  } finally { proxy.stop(); f.close(); }
});

test("a guarded source never selects the pool or recovers a 429 onto another account", async () => {
  const f = fixture(); let calls = 0, poolCalls = 0;
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard,
    accountPool: { assertSourceContinuation() {}, selectAsync() { poolCalls++; throw new Error("no selection allowed"); }, canRecoverAsync() { poolCalls++; return true; } } as any,
    fetchUpstream: async (_url, init) => { calls++; expect(new Headers(init.headers).get("authorization")).toBe(f.headers().authorization);
      return new Response("subscription blocked", { status: 429 }); } });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) });
    expect(response.status).toBe(429); await response.text(); expect(calls).toBe(1); expect(poolCalls).toBe(0);
    const followup = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) });
    expect(followup.status).toBe(409); expect(calls).toBe(1);
    expect(f.guard.check().reason).toBe("upstream-quota-hold");
    f.advance(1); for (const w of f.state.accounts[0]!.windows) w.observedAtMs = f.now();
    f.write(); expect(f.guard.check().ready).toBe(true);
  } finally { proxy.stop(); f.close(); }
});

test("source continuation rejection stops a guarded request before dispatch", async () => {
  const f = fixture(); let calls = 0;
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard,
    accountPool: { assertSourceContinuation() { throw new PoolError("pool_bound_identity_changed", 409); } } as any,
    fetchUpstream: async () => { calls++; return new Response("wrong"); } });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) });
    expect(response.status).toBe(409); expect((await response.json() as any).error.code).toBe("subscription_pool_bound_identity_changed");
    expect(calls).toBe(0);
  } finally { proxy.stop(); f.close(); }
});

test("real loopback HTTP proves admission zero, one source stream, connection cancellation and no follow-up", async () => {
  const f = fixture(); let calls = 0, connectionCancelled = 0;
  let confirmCancel!: () => void;
  const cancelled = new Promise<void>(resolve => { confirmCancel = resolve; });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch(request) {
      calls++;
      expect(request.headers.get("authorization")).toBe(f.headers().authorization);
      request.signal.addEventListener("abort", () => { connectionCancelled++; confirmCancel(); }, { once: true });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(frame({ type: "response.output_text.delta", delta: "loopback-fixture" }));
      } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const proxy = startCompactionProxy({ subscriptionGuard: f.guard,
    fetchUpstream: (_url, init) => fetch(`http://127.0.0.1:${upstream.port}/fixture`, init) });
  const request = () => fetch(proxy.baseUrl + "/responses", { method: "POST", headers: f.headers(), body: JSON.stringify(input) });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    f.state.accounts[0]!.windows[0]!.remainingPercent = 10; f.write();
    expect((await request()).status).toBe(409); expect(calls).toBe(0);
    f.state.accounts[0]!.windows[0]!.remainingPercent = 80; f.write();
    const response = await request(), reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("loopback-fixture");
    expect(calls).toBe(1);
    f.state.accounts[0]!.windows[0]!.remainingPercent = 10; f.write();
    let text = "";
    while (true) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
    expect(text).toContain("subscription_reserve_reached");
    await Promise.race([cancelled, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("loopback upstream connection not cancelled")), 1000);
    })]);
    expect(connectionCancelled).toBe(1);
    expect((await request()).status).toBe(409); expect(calls).toBe(1);
    const health = await (await fetch(proxy.baseUrl + "/quotapie-health")).json() as any;
    expect(health.subscriptionGuard).toMatchObject({ blockedRequests: 2, abortedRequests: 1, ready: false });
    expect(health.accountPoolVersion).toBe(0); expect(health.activeRequests).toBe(0);
  } finally { clearTimeout(deadline); proxy.stop(); upstream.stop(true); f.close(); }
});
