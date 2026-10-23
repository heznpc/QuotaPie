import { expect, test } from "bun:test";
import { parseCodexResetSnapshot } from "../src/signals/codexreset-source";
import { parseAnnouncementTime, localAnnouncementTime } from "../src/signals/time";
import { resetOpportunities } from "../src/signals/opportunities";
import { ResetSignalStore } from "../src/storage/reset-signal-store";
import { QuotaStorage } from "../src/storage/database";
import { WorkStore } from "../src/work/store";
import { WorkController } from "../src/work/controller";
import { DEFAULT_CONFIG } from "../src/config";
import type { WorkPolicyInput, WorkResult } from "../src/work/types";
import type { WindowAnalysis } from "../src/types";
import { ResetSignalCollector } from "../src/signals/collector";
import { QuotaPieService } from "../src/service";
import { QuotaDatabase } from "../src/db";
import { startDashboard } from "../src/server";

const published = Date.parse("2026-10-15T04:56:07Z");
const parent = "The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset";
const text = "Landing within the next 2 hours";
function page(reply = text, context = parent, author = "thsottiaux") {
  const posts = [{ id: "2110595554036400151", handle: "@thsottiaux", text: reply,
    createdAt: new Date(published).toISOString(), sourceUrl: "https://x.com/thsottiaux/status/2110595554036400151",
    replyTo: { id: "2110595484180214059", handle: `@${author}`, text: context, status: "complete",
      sourceUrl: `https://x.com/${author}/status/2110595484180214059` } }];
  return `<script id="$tsr-stream-barrier">activeSignals:[],monitoredPosts:${JSON.stringify(posts)}</script>`;
}
function snapshot(reply = text, context = parent, author = "thsottiaux") {
  return parseCodexResetSnapshot(page(reply, context, author), published + 3 * 60_000);
}

test("the actual October 15 reply is retained at the first collection, including saved revalidation", () => {
  const result = snapshot();
  expect(result.reviews[0]!.reason).toBeNull();
  const signal = result.signals[0]!;
  expect(signal.state).toBe("announced");
  expect(signal.targetAtMs).toBe(published + 2 * 3600_000);
  const db = new QuotaStorage(":memory:");
  try {
    const store = new ResetSignalStore(db);
    store.save([signal], published + 3 * 60_000);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.targetAtMs).toBe(published + 2 * 3600_000);
    expect(store.pending(published + 3 * 60_000)).toHaveLength(1);
  } finally { db.close(); }
});

test("relative deadlines use publication time, preserve within semantics and reject ambiguity", () => {
  expect(parseAnnouncementTime(text, published)).toMatchObject({targetAtMs: published + 2 * 3600_000, qualifier: "by"});
  expect(parseAnnouncementTime("Codex reset in 30 minutes", published)?.targetAtMs).toBe(published + 30 * 60_000);
  for (const value of ["in 2 hours or 3 hours", "within 0 hours", "in 999999 hours", "in -2 hours", "within 2 hours and 30 minutes"])
    expect(parseAnnouncementTime(value, published)).toBeNull();
  const signal = snapshot().signals[0]!;
  expect(localAnnouncementTime(signal, "ko", "Asia/Seoul")).toContain("까지");
});

test("a scoped promotion, unrelated reply and untrusted context cannot authorize reset work", () => {
  expect(snapshot(text, "New model ships today").signals).toHaveLength(0);
  expect(snapshot(text, parent, "unknown_author").signals).toHaveLength(0);
  expect(snapshot("The new model is landing within the next 2 hours").signals).toHaveLength(0);
  expect(snapshot("Maybe landing within the next 2 hours").signals.some(s => s.state === "announced")).toBeFalse();
  const targeted = snapshot(text, "Codex reset for Plus only").signals;
  expect(resetOpportunities(targeted, [], "codex", "default", published + 60_000)).toHaveLength(0);
});

test("an unscoped official reset announcement creates urgency without inventing a global scope", () => {
  const signal = snapshot().signals[0]!;
  expect(signal).toBeDefined();
  const opportunities = resetOpportunities([signal], [], "codex", "default", published + 3 * 60_000);
  expect(opportunities).toHaveLength(1);
  expect(opportunities[0]).toMatchObject({actionableFromMs: published, expiresAtMs: published + 2 * 3600_000});
  expect(resetOpportunities([signal], [], "codex", "default", published + 2 * 3600_000)).toHaveLength(0);
  const withdrawn = {...signal, fingerprint: "withdrawn-revision", state: "withdrawn" as const};
  expect(resetOpportunities([signal, withdrawn], [], "codex", "default", published + 3 * 60_000)).toHaveLength(0);
});

test("18% remaining starts registered work, then 100% reset revokes execution and prevents another turn", async () => {
  const db = new QuotaStorage(":memory:"), store = new WorkStore(db);
  let now = published + 3 * 60_000, calls = 0;
  const bucket = "codex:secondary:10080";
  let windows = [{provider: "codex", account: "default", bucket, remainingPercent: 18, reservePercent: 0,
    resetsAtMs: now + 7 * 86400_000, observedAtMs: now, quality: "authoritative", freshness: "fresh"} as WindowAnalysis];
  let authorized: (() => boolean) | undefined;
  let release!: (result: WorkResult) => void;
  const result = new Promise<WorkResult>(resolve => { release = resolve; });
  const signals = snapshot().signals;
  const controller = new WorkController(store, structuredClone(DEFAULT_CONFIG), {
    now: () => now, windows: () => windows, legacyBusy: () => false,
    announcement: () => resetOpportunities(signals, [], "codex", "default", now).length > 0,
    inspect: async () => ({profileKey: "profile", accountKey: "account", cwd: "/tmp"}),
    execute: async (_policy, _id, check) => { calls++; authorized = check; return result; },
  });
  const policy: WorkPolicyInput = {id: "reset-work", provider: "codex", account: "default", nativeSessionId: "session",
    profileKey: "profile", accountKey: "account", cwd: "/tmp", prompt: "Finish authorized work", objective: "Complete task",
    completionCriteria: ["check passes"], dispatchOwner: "local", enabled: true, trigger: "public-announcement",
    resetBucket: bucket, resetWithinMinutes: 30, budgetByBucket: {[bucket]: {reservePercent: 0, maxUsagePercent: 18}},
    maxTurns: 3, maxDurationSeconds: 120, maxTotalDurationSeconds: 360, expiresAtMs: now + 3600_000, priority: 0, onReset: "stop"};
  try {
    store.save(policy, null, "register");
    controller.tick();
    await Bun.sleep(1);
    expect(calls).toBe(1);
    expect(authorized?.()).toBeTrue();
    now += 60_000;
    windows = [{...windows[0]!, remainingPercent: 100, observedAtMs: now, resetsAtMs: now + 7 * 86400_000}];
    controller.observe();
    expect(authorized?.()).toBeFalse();
    expect(store.get(policy.id)!.enabled).toBeFalse();
    release({status: "activity-paused", reason: "authorization-ended"});
    await controller.settle();
    controller.tick();
    expect(calls).toBe(1);
    expect(store.get(policy.id)!.state.spentByBucket[bucket] ?? 0).toBe(0);
  } finally { release({status: "activity-paused"}); await controller.close(); db.close(); }
});

test("collection wakes the execution loop once and the status API exposes an empty automatic queue", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.resetSignals.enabled = true;
  config.collection.codexEnabled = false;
  config.alerts.enabled = false;
  config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const now = published + 3 * 60_000;
  const fetcher = (async (url: string | URL | Request) => String(url).includes("codexreset.org") ? new Response(page())
    : String(url).includes("resetbeacon") ? Response.json({version: 1, generatedAt: new Date(now).toISOString(), items: []})
    : String(url).includes("claudereset") ? Response.json({schema_version: 1, events: []})
    : Response.json({version: "1.0.0", events: []})) as typeof fetch;
  const collector = new ResetSignalCollector(service.resetSignals, config.resetSignals, fetcher);
  service.signalCollector.poll = () => collector.poll(true, now);
  let wakes = 0;
  service.requestCollection = () => { wakes++; };
  (service as any).jobsEnabled = true;
  const server = startDashboard(service, config);
  try {
    await service.collectResetSignals();
    expect(wakes).toBe(1);
    expect(service.resetSignals.list()[0]!.state).toBe("announced");
    await service.collectResetSignals();
    expect(wakes).toBe(1);
    const response = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as any;
    expect(response.resetSignals.automation.find((a: any) => a.provider === "codex"))
      .toMatchObject({state: "not-configured", registeredCount: 0, enabledCount: 0, runningCount: 0});
    expect(service.work.store.executions()).toHaveLength(0);
  } finally { server.stop(true); await service.close(); }
});
