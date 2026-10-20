import { sessionEfficiencyInsights } from "./session-efficiency";
import { readdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { IncrementalJsonlReader } from "./incremental-jsonl";
import { createHash, randomUUID } from "node:crypto";
import type { ModelNotificationEvent } from "./model-notifications";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionRequestEvent } from "./codex-compaction";
import { CompactionPolicySettings, relayHealth } from "./compaction-policy-settings";
import { TaskSavingsSettings } from "./task-savings-settings";
import { inspectRelaySettings, type RelaySettingsEntry } from "./relay-settings";
import { summarizeRouting, staleRouting, type RequestRoute } from "./request-routing";

import { parseCompactionRequestEvent as event } from "../packages/quota-core/src/events.js";
import { summarizeRequestEvents } from "../packages/quota-core/src/observations.js";
const ongoing = (phase: string) => phase === "started" || phase === "response_headers";
const EXPECTED_SUBSCRIPTION_GUARD_REVISION = 3;
const guardReasons = new Set(["ready", "account-unavailable", "collection-unavailable", "quota-unknown", "quota-stale",
  "reset-unconfirmed", "reserve-reached", "quota-exhausted", "reserve-invalid", "budget-baseline-invalid", "budget-baseline-changed",
  "subscription-auth-required", "subscription-auth-unavailable", "account-identity-changed", "request-identity-mismatch",
  "model-unverified", "profile-mismatch", "upstream-quota-hold", "guard-unavailable", "route-unsupported",
  "background-unsupported", "request-invalid", "request-unsupported", "pool-closed", "pool-source-auth-unavailable", "pool-source-identity-mismatch",
  "pool-lineage-invalid", "pool-source-history-unverified", "pool-thread-identity-required", "pool-source-continuation-mismatch",
  "pool-lineage-conflict", "pool-lineage-unavailable", "source-continuation-unverified"]);
const guardReason = (value: unknown) => {
  const reason = typeof value === "string" ? value.replaceAll("_", "-") : "";
  return guardReasons.has(reason) ? reason : "unknown";
};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const percent = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
function reasonCounts(value: unknown) {
  const result: Record<string, number> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [rawReason, rawCount] of Object.entries(value)) {
      const reason = guardReason(rawReason), n = count(rawCount);
      if (n) result[reason] = (result[reason] ?? 0) + n;
    }
  }
  return result;
}

function subscriptionProtection(generations: Array<{ reachable: boolean; health: any; records: CompactionRequestEvent[] }>, nowMs: number) {
  // Health is an untrusted transport response. Project only diagnostic fields;
  // profile paths, auth data, endpoint URLs and arbitrary error text stay local.
  const relays = generations.map((generation, index) => {
    const health = generation.reachable ? generation.health : null;
    const guard = health?.subscriptionGuardVersion === 1 && health.subscriptionGuard?.version === 1 ? health.subscriptionGuard : null;
    const revision = Number.isSafeInteger(health?.subscriptionGuardRevision) && health.subscriptionGuardRevision >= 0
      ? health.subscriptionGuardRevision as number : null;
    return { generation: index + 1, reachable: generation.reachable, revision,
      executionMode: health?.executionMode === "interactive" ? "interactive" : "managed",
      enforcement: ["source-identity", "explicit-reserve", "managed-budget"].includes(guard?.enforcement) ? guard.enforcement : null,
      nativePolicyCurrent: health?.nativeRequestPolicyVersion === 1 && health?.nativeRequestPolicy === "source-origin" && health?.sourceContinuationRevision === 3,
      listenerPolicyCurrent: health?.listenerPolicyVersion === 2,
      outOfDate: generation.reachable && (revision !== EXPECTED_SUBSCRIPTION_GUARD_REVISION || !guard),
      account: typeof guard?.account === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(guard.account) ? guard.account as string : null,
      ready: typeof guard?.ready === "boolean" ? guard.ready as boolean : null,
      reason: !generation.reachable ? "relay-unreachable" : !guard ? "guard-unavailable" : guardReason(guard.reason),
      blockedRequests: count(guard?.blockedRequests), abortedRequests: count(guard?.abortedRequests),
      blockedByReason: reasonCounts(guard?.blockedByReason),
      activeRequests: count(health?.activeRequests),
      windows: (Array.isArray(guard?.windows) ? guard.windows : []).slice(0, 64).flatMap((window: any) =>
        typeof window?.bucket === "string" && /^[a-z0-9_.-]+:(?:primary|secondary):\d+$/i.test(window.bucket)
          ? [{ bucket: window.bucket as string, remainingPercent: percent(window.remainingPercent), reservePercent: percent(window.reservePercent),
            observedAgeMs: Number.isFinite(window.observedAtMs) && window.observedAtMs >= 0 && window.observedAtMs <= nowMs
              ? nowMs - window.observedAtMs : null }] : []),
    };
  });
  // These counts are evidence from retained relay events, not lifetime counters.
  // One request can appear in both a log and health, or multiple generations.
  const blocks = new Map<string, CompactionRequestEvent>();
  for (const record of generations.flatMap(g => g.records)) {
    if (record.phase !== "failed" || !record.errorCode?.startsWith("subscription_")) continue;
    const previous = blocks.get(record.requestId);
    if (!previous || Date.parse(record.at) >= Date.parse(previous.at)) blocks.set(record.requestId, record);
  }
  const observedBlocksByReason: Record<string, number> = {};
  for (const record of blocks.values()) {
    const code = record.errorCode!.slice("subscription_".length).replaceAll("_", "-");
    const reason = guardReason(code === "auth-required" || code === "auth-unavailable" ? `subscription-${code}` : code);
    observedBlocksByReason[reason] = (observedBlocksByReason[reason] ?? 0) + 1;
  }
  const blockedByReason: Record<string, number> = {};
  for (const relay of relays) for (const [reason, n] of Object.entries(relay.blockedByReason))
    blockedByReason[reason] = (blockedByReason[reason] ?? 0) + n;
  return { expectedRevision: EXPECTED_SUBSCRIPTION_GUARD_REVISION, relays,
    reachable: relays.filter(r => r.reachable).length, outOfDate: relays.filter(r => r.outOfDate).length,
    revisionMismatch: new Set(relays.filter(r => r.reachable).map(r => r.revision)).size > 1,
    blockedRequests: relays.reduce((sum, r) => sum + r.blockedRequests, 0),
    abortedRequests: relays.reduce((sum, r) => sum + r.abortedRequests, 0),
    activeRequests: relays.reduce((sum, r) => sum + r.activeRequests, 0), blockedByReason, observedBlocksByReason };
}

export class CompactionStatusReader {
  private logs = new IncrementalJsonlReader(event, item => item.requestId);
  private cached: Awaited<ReturnType<CompactionStatusReader["collect"]>> | null = null;
  private pending: ReturnType<CompactionStatusReader["collect"]> | null = null;
  private evidence = new Map<string, CompactionRequestEvent>();
  private notificationEvidence: ModelNotificationEvent[] = [];
  notificationEvents() { return this.notificationEvidence; }
  private evidenceLoaded = false;
  private savedEvidence = "";
  private routingEvidence: RequestRoute[] = [];
  readonly policy: CompactionPolicySettings;
  readonly savingsPolicy: TaskSavingsSettings;
  constructor(private root = join(homedir(), ".local/lib/quotapie-compaction"), private fetcher: typeof fetch = fetch) {
    this.policy = new CompactionPolicySettings(root, fetcher);
    this.savingsPolicy = new TaskSavingsSettings(root, fetcher);
  }
  async status(nowMs = Date.now()) {
    if (this.cached && nowMs - this.cached.checkedAtMs < 2000) return this.cached;
    if (!this.pending) this.pending = this.collect(nowMs).then(result => this.cached = result).finally(() => this.pending = null);
    return this.pending;
  }
  snapshot(nowMs = Date.now()) {
    const cached = this.cached;
    if (!cached) return { checkedAtMs: 0, generations: 0, reachable: 0, policy: null,
      subscriptionProtection: subscriptionProtection([], nowMs), routing: { ...summarizeRouting([], nowMs), checkedAtMs: 0 }, active: [], recent: [] };
    if (nowMs - cached.checkedAtMs <= 10_000) return cached;
    // A stale observer cannot assert that an old request is still running or
    // that a previously acknowledged policy is still live.
    return { ...cached, reachable: 0,
      routing: staleRouting(cached.routing),
      subscriptionProtection: { ...cached.subscriptionProtection, reachable: 0, outOfDate: 0, revisionMismatch: false, activeRequests: 0,
        relays: cached.subscriptionProtection.relays.map(r => ({ ...r, reachable: false, ready: null, reason: "observer-state-stale",
          outOfDate: false, activeRequests: 0 })) },
      savings: {policy: cached.savings.policy ? {...cached.savings.policy,configurable:false,applied:0} : null, active: [], recent: cached.savings.recent, insights: []},
      policy: cached.policy ? { ...cached.policy, configurable: false, applied: 0 } : null,
      active: [], recent: [...cached.active.map(r => ({ ...r, active: false, phase: "unverified",
        errorCode: "observer_state_stale" })), ...cached.recent].slice(0, 50) };
  }
  private async collect(nowMs: number) {
    if (!this.evidenceLoaded) {
      this.evidenceLoaded = true;
      try {
        const stored = JSON.parse(await readFile(join(this.root, "observations.json"), "utf8"));
        if (Array.isArray(stored)) for (const raw of stored.slice(0, 200)) {
          const item = event(raw); if (item) this.evidence.set(item.requestId, item);
        }
      } catch { /* First run or unreadable evidence is not proof of resumption. */ }
    }
    // Validate the managed settings once for both policy projections. Configure
    // operations still re-read them while holding the management lock.
    let validatedEntries: RelaySettingsEntry[] | null = null;
    try { validatedEntries = await inspectRelaySettings(this.root, async entry => entry); }
    catch { /* Invalid current installation cannot expose configurable policies. */ }
    const settingsByPath = new Map(validatedEntries?.map(entry => [entry.path, entry.settings]));
    // Older desktop tasks still use retired endpoints. Read every generation without restarting any.
    const directories = [this.root];
    try {
      for (const entry of await readdir(join(this.root, "releases"), { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) directories.push(join(this.root, "releases", entry.name));
      }
    } catch { /* Not installed yet. */ }
    this.logs.retain(new Set(directories.map(directory => join(directory, "relay.log"))));
    const generations = await Promise.all(directories.map(async directory => {
      let settings: any;
      try { settings = settingsByPath.get(join(directory, "settings.json")) ?? JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); }
      catch { return null; }
      const records = new Map<string, CompactionRequestEvent>();
      try {
        for (const item of await this.logs.read(join(directory, "relay.log"))) records.set(item.requestId, item);
      } catch { /* Live state may still be available. */ }
      let reachable = false;
      let health: any = null;
      const activeIds = new Set<string>();
      const healthRequestIds = new Set<string>();
      try {
        health = await relayHealth(settings, this.fetcher);
        if (!(health.schemaVersion >= 2)) throw new Error();
        reachable = true;
        for (const raw of [...(health.recent ?? []), ...(health.active ?? [])]) {
          const item = event(raw); if (!item) continue;
          healthRequestIds.add(item.requestId);
          records.set(item.requestId, item);
          if (ongoing(item.phase)) activeIds.add(item.requestId);
        }
      } catch { /* Never include endpoint/token-bearing transport errors in status. */ }
      // This namespace comes from local profile settings, never response metadata.
      // Unknown/legacy profiles remain distinct by relay generation.
      const scope = typeof settings.codex_home === "string" && settings.codex_home.startsWith("/")
        ? settings.codex_home : directory;
      const notificationScope = createHash("sha256").update(`quotapie:relay-profile:${scope}`).digest("hex");
      return { reachable, records: [...records.values()], activeIds, healthRequestIds, health, notificationScope, path: join(directory, "settings.json") };
    }));
    const installed = generations.filter(g => g !== null);
    const routing = summarizeRouting(installed, nowMs, this.routingEvidence);
    this.routingEvidence = [...routing.active, ...routing.recent];
    const merged = new Map(this.evidence);
    for (const item of installed.flatMap(g => g.records)) {
      const previous = merged.get(item.requestId);
      if (!previous || Date.parse(item.at) >= Date.parse(previous.at)) merged.set(item.requestId, item);
    }
    const activeIds = new Set(installed.flatMap(g => [...g.activeIds]));
    const { records, savingsRecords, retained, notificationEvidence } = summarizeRequestEvents([...merged.values()], activeIds, nowMs);
    const insights = sessionEfficiencyInsights([...merged.values()], nowMs);
    for (const id of insights.flatMap(i => i.requestIds).slice(-200)) {
      const evidence = merged.get(id); if (evidence) retained.set(id, evidence);
    }
    const notificationScopes = new Map(installed.flatMap(g => g.records.map(record => [record.requestId, g.notificationScope] as const)));
    this.notificationEvidence = notificationEvidence.map(record => ({...record, notificationScope: notificationScopes.get(record.requestId)}));
    this.evidence = retained;
    const serialized = JSON.stringify([...retained.values()]);
    if (installed.length && serialized !== this.savedEvidence) {
      const path = join(this.root, "observations.json"), temp = path + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temp, serialized, { mode: 0o600, flag: "wx" });
        await rename(temp, path);
        this.savedEvidence = serialized;
      } catch { /* Keep memory evidence if persistence is unavailable. */ }
      finally { await unlink(temp).catch(() => {}); }
    }
    const healthByPath = new Map(installed.map(g => [g.path, g.health]));
    return { checkedAtMs: nowMs, generations: installed.length, reachable: installed.filter(g => g.reachable).length,
      routing,
      subscriptionProtection: subscriptionProtection(installed, nowMs),
      policy: validatedEntries ? await this.policy.status(healthByPath, validatedEntries) : null,
      savings: {insights, policy: validatedEntries ? await this.savingsPolicy.status(healthByPath, validatedEntries) : null, active: savingsRecords.filter(r=>r.active), recent: savingsRecords.filter(r=>!r.active)},
      active: records.filter(r => r.active), recent: records.filter(r => !r.active) };
  }
}
