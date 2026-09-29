import { readdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { IncrementalJsonlReader } from "./incremental-jsonl";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionRequestEvent } from "./codex-compaction";
import { CompactionPolicySettings, relayHealth } from "./compaction-policy-settings";
import { TaskSavingsSettings } from "./task-savings-settings";

import { parseCompactionRequestEvent as event } from "../packages/quota-core/src/events.js";
import { summarizeRequestEvents } from "../packages/quota-core/src/observations.js";
const ongoing = (phase: string) => phase === "started" || phase === "response_headers";

export class CompactionStatusReader {
  private logs = new IncrementalJsonlReader(event, item => item.requestId);
  private cached: Awaited<ReturnType<CompactionStatusReader["collect"]>> | null = null;
  private pending: ReturnType<CompactionStatusReader["collect"]> | null = null;
  private evidence = new Map<string, CompactionRequestEvent>();
  private notificationEvidence: CompactionRequestEvent[] = [];
  notificationEvents() { return this.notificationEvidence; }
  private evidenceLoaded = false;
  private savedEvidence = "";
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
    if (!cached) return { checkedAtMs: 0, generations: 0, reachable: 0, policy: null, active: [], recent: [] };
    if (nowMs - cached.checkedAtMs <= 10_000) return cached;
    // A stale observer cannot assert that an old request is still running or
    // that a previously acknowledged policy is still live.
    return { ...cached, reachable: 0,
      savings: {policy: cached.savings.policy ? {...cached.savings.policy,configurable:false,applied:0} : null, active: [], recent: cached.savings.recent},
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
      try { settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); }
      catch { return null; }
      const records = new Map<string, CompactionRequestEvent>();
      try {
        for (const item of await this.logs.read(join(directory, "relay.log"))) records.set(item.requestId, item);
      } catch { /* Live state may still be available. */ }
      let reachable = false;
      let health: any = null;
      const activeIds = new Set<string>();
      try {
        health = await relayHealth(settings, this.fetcher);
        if (!(health.schemaVersion >= 2)) throw new Error();
        reachable = true;
        for (const raw of [...(health.recent ?? []), ...(health.active ?? [])]) {
          const item = event(raw); if (!item) continue;
          records.set(item.requestId, item);
          if (ongoing(item.phase)) activeIds.add(item.requestId);
        }
      } catch { /* Never include endpoint/token-bearing transport errors in status. */ }
      return { reachable, records: [...records.values()], activeIds, health, path: join(directory, "settings.json") };
    }));
    const installed = generations.filter(g => g !== null);
    const merged = new Map(this.evidence);
    for (const item of installed.flatMap(g => g.records)) {
      const previous = merged.get(item.requestId);
      if (!previous || Date.parse(item.at) >= Date.parse(previous.at)) merged.set(item.requestId, item);
    }
    const activeIds = new Set(installed.flatMap(g => [...g.activeIds]));
    const { records, savingsRecords, retained, notificationEvidence } = summarizeRequestEvents([...merged.values()], activeIds, nowMs);
    this.notificationEvidence = notificationEvidence;
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
    return { checkedAtMs: nowMs, generations: installed.length, reachable: installed.filter(g => g.reachable).length,
      policy: await this.policy.status(new Map(installed.map(g => [g.path, g.health]))),
      savings: {policy: await this.savingsPolicy.status(new Map(installed.map(g => [g.path, g.health]))), active: savingsRecords.filter(r=>r.active), recent: savingsRecords.filter(r=>!r.active)},
      active: records.filter(r => r.active), recent: records.filter(r => !r.active) };
  }
}
