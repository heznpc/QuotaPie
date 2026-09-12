import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactionRequestEvent } from "./codex-compaction";

const phases = new Set(["started", "response_headers", "completed", "failed", "cancelled", "unverified"]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const label = /^[a-z0-9_.-]{1,80}$/i;
const ongoing = (phase: string) => phase === "started" || phase === "response_headers";

// Explicit metadata projection: credentials, URLs and request bodies never leave this reader.
function event(value: any): CompactionRequestEvent | null {
  if (value?.kind !== "compaction" || !uuid.test(value.requestId) || !phases.has(value.phase) ||
      !label.test(value.from) || !label.test(value.to) || !Number.isFinite(Date.parse(value.at)) ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0) return null;
  return { requestId: value.requestId, threadId: uuid.test(value.threadId) ? value.threadId : null,
    turnId: uuid.test(value.turnId) ? value.turnId : null, kind: "compaction", from: value.from, to: value.to,
    routed: value.routed === true, phase: value.phase, status: Number.isInteger(value.status) ? value.status : 0,
    requestedEffort: label.test(value.requestedEffort ?? "") ? value.requestedEffort : null,
    reasoningEffort: label.test(value.reasoningEffort ?? "") ? value.reasoningEffort : null,
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
  constructor(private root = join(homedir(), ".local/lib/quotapie-compaction"), private fetcher: typeof fetch = fetch) {}
  async status(nowMs = Date.now()) {
    if (this.cached && nowMs - this.cached.checkedAtMs < 2000) return this.cached;
    if (!this.pending) this.pending = this.collect(nowMs).then(result => this.cached = result).finally(() => this.pending = null);
    return this.pending;
  }
  private async collect(nowMs: number) {
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
      const activeIds = new Set<string>();
      try {
        if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535 || !/^[a-f0-9]{48}$/.test(settings.token)) throw new Error();
        const response = await this.fetcher(`http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex/quotapie-health`,
          { redirect: "error", signal: AbortSignal.timeout(1500) });
        const health = await response.json() as any;
        if (!response.ok || health.service !== "quotapie-compaction" || !(health.schemaVersion >= 2)) throw new Error();
        reachable = true;
        for (const raw of [...(health.recent ?? []), ...(health.active ?? [])]) {
          const item = event(raw); if (!item) continue;
          records.set(item.requestId, item);
          if (ongoing(item.phase)) activeIds.add(item.requestId);
        }
      } catch { /* Never include endpoint/token-bearing transport errors in status. */ }
      return { reachable, records: [...records.values()].map(item => {
        const active = ongoing(item.phase) && activeIds.has(item.requestId);
        return { ...item, phase: ongoing(item.phase) && !active ? "unverified" : item.phase,
          ...(ongoing(item.phase) && !active ? { errorCode: "relay_state_unavailable" } : {}),
          active, startedAtMs: Date.parse(item.at) - item.durationMs,
          elapsedMs: active ? Math.max(item.durationMs, nowMs - Date.parse(item.at) + item.durationMs) : item.durationMs };
      }) };
    }));
    const installed = generations.filter(g => g !== null);
    const records = installed.flatMap(g => g.records).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { checkedAtMs: nowMs, generations: installed.length, reachable: installed.filter(g => g.reachable).length,
      active: records.filter(r => r.active), recent: records.filter(r => !r.active).slice(0, 50) };
  }
}
