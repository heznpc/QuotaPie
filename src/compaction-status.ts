import { open, readdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionRequestEvent } from "./codex-compaction";
import { CompactionPolicySettings, relayHealth } from "./compaction-policy-settings";
import { safeEffort } from "./codex-compaction-policy";

const phases = new Set(["started", "response_headers", "completed", "failed", "cancelled", "unverified"]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const label = /^[a-z0-9_.-]{1,80}$/i;
const ongoing = (phase: string) => phase === "started" || phase === "response_headers";

// Explicit metadata projection: credentials, URLs and request bodies never leave this reader.
function event(value: any): CompactionRequestEvent | null {
  if (!["compaction", "response"].includes(value?.kind) || !uuid.test(value.requestId) || !phases.has(value.phase) ||
      typeof value.from !== "string" || typeof value.to !== "string" ||
      !label.test(value.from) || !label.test(value.to) || !Number.isFinite(Date.parse(value.at)) ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0) return null;
  return { requestId: value.requestId, threadId: uuid.test(value.threadId) ? value.threadId : null,
    turnId: uuid.test(value.turnId) ? value.turnId : null, kind: value.kind, from: value.from, to: value.to,
    routed: value.routed === true, phase: value.phase, status: Number.isInteger(value.status) ? value.status : 0,
    requestedEffort: safeEffort(value.requestedEffort),
    reasoningEffort: safeEffort(value.reasoningEffort),
    at: value.at, durationMs: value.durationMs,
    ...(label.test(value.errorCode ?? "") ? { errorCode: value.errorCode } : {}) };
}

async function logTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 2_000_000);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { await file.close(); }
}

export class CompactionStatusReader {
  private cached: Awaited<ReturnType<CompactionStatusReader["collect"]>> | null = null;
  private pending: ReturnType<CompactionStatusReader["collect"]> | null = null;
  private evidence = new Map<string, CompactionRequestEvent>();
  private evidenceLoaded = false;
  private savedEvidence = "";
  readonly policy: CompactionPolicySettings;
  constructor(private root = join(homedir(), ".local/lib/quotapie-compaction"), private fetcher: typeof fetch = fetch) {
    this.policy = new CompactionPolicySettings(root, fetcher);
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
    const generations = await Promise.all(directories.map(async directory => {
      let settings: any;
      try { settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); }
      catch { return null; }
      const records = new Map<string, CompactionRequestEvent>();
      try {
        for (const line of (await logTail(join(directory, "relay.log"))).split("\n")) {
          try { const item = event(JSON.parse(line)); if (item) records.set(item.requestId, item); } catch { /* Partial log line. */ }
        }
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
    const all = [...merged.values()];
    const compactions = all.filter(r => r.kind === "compaction").sort((a,b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50);
    const retained = new Map<string, CompactionRequestEvent>();
    const records = compactions.map(item => {
      retained.set(item.requestId, item);
      const active = ongoing(item.phase) && activeIds.has(item.requestId);
      const end = Date.parse(item.at);
      const nextCompaction = all.filter(r => r.kind === "compaction" && r.threadId === item.threadId && r.requestId !== item.requestId)
        .map(r => Date.parse(r.at) - r.durationMs).filter(start => start >= end).sort((a,b) => a-b)[0] ?? Infinity;
      // Match actual requests, never saved composer settings. A different turn,
      // an overlapping request or another task cannot establish continuation.
      const followup = item.threadId && !ongoing(item.phase) && item.phase !== "unverified"
        ? all.filter(r => r.kind === "response" && r.threadId === item.threadId &&
            (!item.turnId || r.turnId === item.turnId) && Date.parse(r.at) - r.durationMs >= end &&
            Date.parse(r.at) - r.durationMs < nextCompaction)
            .sort((a,b) => (Date.parse(a.at)-a.durationMs) - (Date.parse(b.at)-b.durationMs))[0] : undefined;
      if (followup) retained.set(followup.requestId, followup);
      return { ...item, phase: ongoing(item.phase) && !active ? "unverified" : item.phase,
        ...(ongoing(item.phase) && !active ? { errorCode: "relay_state_unavailable" } : {}),
        active, startedAtMs: end - item.durationMs,
        finishedAtMs: ongoing(item.phase) ? null : end,
        elapsedMs: active ? Math.max(item.durationMs, nowMs - end + item.durationMs) : item.durationMs,
        followup: followup ? { requestId: followup.requestId, model: followup.to, effort: followup.reasoningEffort,
          startedAtMs: Date.parse(followup.at) - followup.durationMs } : null };
    });
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
      active: records.filter(r => r.active), recent: records.filter(r => !r.active) };
  }
}
