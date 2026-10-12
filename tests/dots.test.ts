import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DotBridge } from "../src/dots/bridge";
import { DotStore, type DotPolicy } from "../src/dots/store";
import { publicAddress, callbackURL, signature, verifyCallback, type WebhookPost } from "../src/dots/webhook";
import { parsePolicy, gateAllows } from "../src/dots/policy";
import { DEFAULT_CONFIG } from "../src/config";
import type { ResumeGate } from "../src/resume-gate";

const NOW = 2_000_000_000_000;
const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
function policy(id = "original"): DotPolicy {
  return { id, threadId: "11111111-2222-3333-4444-555555555555", account: "fixture", profileKey: "fixture-key", accountKey: "fixture-login",
    continuation: "Report the preserved stopping point, then stop.", enabled: false, trigger: "quota.ready",
    resetWithinMinutes: 30, reservePercent: 20, maxTurns: 1, maxUsagePercent: 5,
    expiresAtMs: NOW + 3600000, priority: 0 };
}
function gate(): ResumeGate {
  return { schemaVersion: 1, provider: "codex", account: "fixture", profileKey: "fixture-key", accountKey: "fixture-login",
    ready: true, reason: "ready", checkedAtMs: NOW, retryAtMs: null,
    windows: [{ bucket: "codex:primary:300", remainingPercent: 80, reservePercent: 10,
      observedAtMs: NOW, resetsAtMs: NOW + 3600000 }] };
}
function fixture() {
  const store = new DotStore(":memory:"); store.create(policy());
  let now = NOW, snapshot = gate(), calls: Array<{ headers: Record<string, string>; body: any }> = [];
  const post: WebhookPost = async (_url, headers, body) => {
    const parsed = JSON.parse(body); calls.push({ headers, body: parsed });
    return { status: 200, body: JSON.stringify(parsed.type === "verification" ? { challenge: parsed.challenge } : {}) };
  };
  const bridge = new DotBridge(store, async () => snapshot, post, () => now);
  const subscribe = (url = "https://callback.example/event", ttlMs?: number) => bridge.method("events/subscribe", {
    name: "quota.ready", arguments: { targetId: "original" },
    delivery: { mode: "webhook", url, secret }, ...(ttlMs == null ? {} : { ttlMs }),
  });
  return { store, bridge, calls, subscribe, setGate: (v: ResumeGate) => { snapshot = v; }, setNow: (v: number) => { now = v; } };
}

test("disabled policies allow discovery and verification, but never deliver work", async () => {
  const f = fixture();
  try {
    expect(await f.bridge.method("server/discover")).toMatchObject({ supportedVersions: ["2026-07-28"], capabilities: { events: {} } });
    const a = await f.subscribe(), b = await f.subscribe();
    expect(a.id).toBe(b.id); expect(f.store.subscriptions()).toHaveLength(1);
    await f.bridge.tick();
    expect(f.calls.every(c => c.body.type === "verification")).toBeTrue();
    expect((await f.bridge.status("original")).ready).toBeFalse();
  } finally { f.store.close(); }
});

test("one event leads to one claim across duplicate subscriptions and concurrent calls", async () => {
  const f = fixture();
  try {
    f.store.setEnabled("original", true); await f.subscribe(); await f.subscribe("https://callback.example/second");
    await f.bridge.tick(); await f.bridge.tick();
    const events = f.calls.filter(c => c.body.eventId);
    expect(events).toHaveLength(2);
    expect(events[0]!.body.eventId).toBe(events[1]!.body.eventId);
    const id = events[0]!.body.eventId;
    const claims = await Promise.all([f.bridge.claim("original", id), f.bridge.claim("original", id)]);
    expect(claims.filter(c => c.granted)).toHaveLength(1);
    const grant = claims.find(c => c.granted)! as any;
    expect(grant).toMatchObject({ threadId: policy().threadId, maxFollowups: 1, exactConsumptionCap: false });
    f.store.setEnabled("original", false);
    expect(f.bridge.finish("original", grant.claimId, "completed")).toMatchObject({ enabled: false });
    await f.bridge.tick(); expect(f.calls.filter(c => c.body.eventId)).toHaveLength(2);
    expect(() => f.store.setEnabled("original", true)).toThrow("target-needs-review");
  } finally { f.store.close(); }
});

test("reset preparation waits for the selected window and honors higher-priority subscribed work", async () => {
  const f = fixture();
  try {
    const higher = { ...policy("priority-work"), priority: 10, trigger: "quota.reset_approaching" as const,
      resetBucket: "codex:primary:300" };
    f.store.create(higher); f.store.setEnabled(higher.id, true); f.store.setEnabled("original", true);
    await f.subscribe();
    await f.bridge.method("events/subscribe", { name: higher.trigger, arguments: { targetId: higher.id },
      delivery: { mode: "webhook", url: "https://callback.example/priority", secret } });
    await f.bridge.tick();
    expect(f.store.target(higher.id).event).toBeNull();
    f.setGate({ ...gate(), windows: [{ ...gate().windows[0]!, resetsAtMs: NOW + 15 * 60000 }] });
    await f.bridge.tick();
    expect(f.store.target(higher.id).event).not.toBeNull();
    expect(await f.bridge.claim("original", f.store.target("original").event!.eventId))
      .toMatchObject({ granted: false, reason: "higher-priority-work" });
    const claim = await f.bridge.claim(higher.id, f.store.target(higher.id).event!.eventId);
    expect(claim.granted).toBeTrue();
    expect((await f.bridge.claim("original", f.store.target("original").event!.eventId)).granted).toBeFalse();
  } finally { f.store.close(); }
});

test("real stdio entrypoint advertises events without any provider or external connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-dots-stdio-"));
  try {
    const config = join(root, "config.json"); writeFileSync(config, JSON.stringify(DEFAULT_CONFIG));
    const child = Bun.spawn([process.execPath, "src/cli.ts", "dots", "mcp"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, QUOTAPIE_CONFIG: config, QUOTAPIE_HOME: join(root, "data") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events/list" }) + "\n");
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(stderr).toBe("");
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0].result.capabilities.events).toEqual({});
    expect(replies[1].result.events.map((e: any) => e.name)).toEqual(["quota.ready", "quota.reset_approaching"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("quota, profile, model bucket, reset and freshness are rechecked at claim time", async () => {
  const f = fixture();
  try {
    f.store.setEnabled("original", true); await f.subscribe(); await f.bridge.tick();
    const event = f.store.target("original").event!;
    const invalid = [
      { ...gate(), profileKey: "other-profile" }, { ...gate(), account: "other-account" },
      { ...gate(), accountKey: "other-login-in-same-profile" },
      { ...gate(), ready: false }, { ...gate(), checkedAtMs: NOW + 1 }, { ...gate(), windows: [] },
      { ...gate(), windows: [{ ...gate().windows[0]!, remainingPercent: 20 }] },
      { ...gate(), windows: [{ ...gate().windows[0]!, observedAtMs: NOW - 120001 }] },
      { ...gate(), windows: [{ ...gate().windows[0]!, resetsAtMs: NOW }] },
    ];
    for (const g of invalid) {
      f.setGate(g);
      expect((await f.bridge.claim("original", event.eventId)).granted).toBeFalse();
    }
    expect(f.store.target("original").turns).toBe(0);
    expect(gateAllows({ ...policy(), requiredBucket: "missing" }, gate(), NOW)).toBeFalse();
  } finally { f.store.close(); }
});

test("usage budget and policy expiry stop admission without pretending to cancel host work", async () => {
  const f = fixture();
  try {
    f.store.setEnabled("original", true); await f.subscribe(); await f.bridge.tick();
    const event = f.store.target("original").event!;
    f.setGate({ ...gate(), windows: [{ ...gate().windows[0]!, remainingPercent: 74 }] });
    expect((await f.bridge.claim("original", event.eventId)).granted).toBeFalse();
    expect(f.store.target("original").spent).toBe(6);
    f.setNow(policy().expiresAtMs);
    expect((await f.bridge.status("original")).ready).toBeFalse();
  } finally { f.store.close(); }
});

test("stable ready state never emits another event; a quota transition invalidates the old event", async () => {
  const f = fixture();
  try {
    f.store.setEnabled("original", true); await f.subscribe(); await f.bridge.tick();
    const first = f.store.target("original").event!.eventId;
    f.setNow(NOW + 180000);
    const fresh = { ...gate(), checkedAtMs: NOW + 180000, windows: [{ ...gate().windows[0]!, observedAtMs: NOW + 180000 }] };
    f.setGate(fresh); await f.bridge.tick();
    expect(f.calls.filter(c => c.body.eventId)).toHaveLength(1);
    f.setGate({ ...fresh, ready: false, reason: "reserve-reached" }); await f.bridge.tick();
    expect(f.store.target("original").event).toBeNull();
    f.setGate(fresh); await f.bridge.tick();
    expect(f.store.target("original").event!.eventId).not.toBe(first);
    expect((await f.bridge.claim("original", first)).granted).toBeFalse();
  } finally { f.store.close(); }
});

test("subscription expiry, unsubscribe and policy disable stop delivery", async () => {
  const f = fixture();
  try {
    f.store.setEnabled("original", true);
    const sub = await f.subscribe("https://callback.example/event", 1000);
    f.setNow(NOW + 1001); await f.bridge.tick();
    expect(f.store.subscriptions()).toHaveLength(0);
    await f.subscribe();
    await f.bridge.method("events/unsubscribe", { name: "quota.ready", arguments: { targetId: "original" },
      delivery: { mode: "webhook", url: "https://callback.example/event" } });
    await f.bridge.tick();
    expect(f.calls.filter(c => c.body.eventId)).toHaveLength(0);
    expect(sub.cursor).toBeNull();
    await f.subscribe(); await f.bridge.tick();
    const eventId = f.store.target("original").event!.eventId;
    await f.bridge.method("events/unsubscribe", { name: "quota.ready", arguments: { targetId: "original" },
      delivery: { mode: "webhook", url: "https://callback.example/event" } });
    expect(await f.bridge.claim("original", eventId)).toMatchObject({ granted: false, reason: "subscription-inactive" });
  } finally { f.store.close(); }
});

test("callback verification, HMAC and address restrictions protect event delivery", async () => {
  const body = '{"eventId":"one"}', time = "2000000000";
  expect(signature(secret, "one", time, body)).toBe("v1," +
    createHmac("sha256", Buffer.alloc(32, 7)).update("one." + time + "." + body).digest("base64"));
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::1"])
    expect(publicAddress(ip)).toBeFalse();
  expect(publicAddress("8.8.8.8")).toBeTrue();
  expect(publicAddress("2606:4700:4700::1111")).toBeTrue();
  for (const url of ["http://callback.example/x", "https://127.0.0.1/x", "https://user:pass@callback.example/x", "https://callback.example:8443/x"])
    expect(() => callbackURL(url)).toThrow();
  await expect(verifyCallback(async () => ({ status: 200, body: '{"challenge":"wrong"}' }),
    { id: "fixture", url: "https://callback.example/x", secret }, NOW)).rejects.toThrow("callback-verification-failed");
});

test("transient retries preserve the event ID and stop after three attempts", async () => {
  const f = fixture(); let attempts = 0;
  const ids: string[] = [];
  const bridge = new DotBridge(f.store, async () => gate(), async (_url, headers) => {
    ids.push(headers["webhook-id"]!); attempts++; return { status: 503, body: "{}" };
  }, () => NOW + attempts * 120000);
  try {
    f.store.setEnabled("original", true); await f.subscribe();
    // Drive delivery at explicit times; no network and no wall-clock sleeps.
    let now = NOW;
    const retry = new DotBridge(f.store, async () => ({ ...gate(), checkedAtMs: now,
      windows: [{ ...gate().windows[0]!, observedAtMs: now }] }),
      bridge.post, () => now);
    for (let i = 0; i < 5; i++) { await retry.tick(); now += 120000; }
    expect(attempts).toBe(3); expect(new Set(ids).size).toBe(1);
  } finally { f.store.close(); }
});

test("claims survive restart and result ambiguity remains blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-dots-store-")), path = join(root, "dots.sqlite");
  let store = new DotStore(path);
  try {
    store.create(policy()); store.setEnabled("original", true);
    const s = store.target("original"); s.claimed = "pending"; s.turns = 1; store.save(s);
    store.close(); store = new DotStore(path);
    const bridge = new DotBridge(store, async () => gate(), async () => { throw new Error("unexpected-network"); }, () => NOW);
    expect((await bridge.status("original")).ready).toBeFalse();
    expect(() => store.setEnabled("original", true)).toThrow();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("registration verifies the thread metadata in the selected profile and always starts disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-dots-policy-"));
  try {
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "sessions", policy().threadId + ".jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: policy().threadId } }) + "\n");
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.codex = [{ id: "fixture", label: "Fixture", codexHome: root, enabled: true }];
    const { enabled: _, profileKey: __, accountKey: ___, ...input } = policy();
    input.expiresAtMs = Date.now() + 3600000;
    expect(parsePolicy(input, config)).toMatchObject({ enabled: false, threadId: policy().threadId });
    expect(() => parsePolicy({ ...input, enabled: true }, config)).toThrow();
    expect(() => parsePolicy({ ...input, threadId: "22222222-2222-3333-4444-555555555555" }, config)).toThrow("thread-profile-unverified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
