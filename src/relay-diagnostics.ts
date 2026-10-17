import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { CompactionRequestEvent, NativeRequestEvent } from "./codex-compaction";
import type { OwnershipProvenance } from "./codex-response-ownership";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BACKUPS = 2;

/** A relay owns this file, unlike launchd's permanently open stdout descriptor.
 * Open only for each append so rotation cannot leave writers on an old inode. */
export function rotatingRelayLog(path: string, maxBytes = DEFAULT_MAX_BYTES, backups = DEFAULT_BACKUPS) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isSafeInteger(backups) || backups < 0 || backups > 8)
    throw new Error("Invalid relay log bounds");
  return (line: string) => {
    const bytes = Buffer.from(line + "\n");
    // Diagnostics must never become an unbounded payload store.
    if (bytes.length > Math.min(maxBytes, 16 * 1024)) return;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const open = () => openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      fd = open();
      const stat = fstatSync(fd);
      if (!stat.isFile()) return;
      if (stat.size + bytes.length > maxBytes) {
        closeSync(fd); fd = undefined;
        for (let index = backups; index > 1; index--) {
          try { renameSync(`${path}.${index - 1}`, `${path}.${index}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (backups) renameSync(path, `${path}.1`);
        else {
          fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
        }
        fd ??= open();
      }
      writeSync(fd, bytes);
    } catch { /* A full disk or unavailable log must never interrupt a response. */ }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Diagnostic only. */ } } }
  };
}

interface Summary {
  inspectedEvents: number; queuedBytes: number; skippedEvents: number; blockedEvents: number;
  ownership: Record<OwnershipProvenance["ownership"], number>;
}

/** Per-request counters replace two disk writes per token delta. Active state
 * is bounded too, including clients that disconnect before a terminal event. */
export function createRelayDiagnostics(sink: (line: string) => void, maxActive = 128) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new Error("Invalid relay diagnostic bound");
  const summaries = new Map<string, Summary>();
  const write = (value: unknown) => { try { sink(JSON.stringify(value)); } catch { /* Diagnostic only. */ } };
  const flush = (requestId: string, reason: string) => {
    const summary = summaries.get(requestId);
    if (!summary) return;
    summaries.delete(requestId);
    write({ kind: "response_ownership_summary", requestId, ...summary, reason, at: new Date().toISOString() });
  };
  return {
    onProvenance(event: OwnershipProvenance & { requestId: string }) {
      let summary = summaries.get(event.requestId);
      if (!summary) {
        if (summaries.size >= maxActive) flush(summaries.keys().next().value!, "capacity");
        summary = { inspectedEvents: 0, queuedBytes: 0, skippedEvents: 0, blockedEvents: 0,
          ownership: { matched: 0, partial: 0, unattributed: 0 } };
        summaries.set(event.requestId, summary);
      }
      if (event.stage === "validated") { summary.inspectedEvents++; summary.ownership[event.ownership]++; }
      if (event.stage === "queued") summary.queuedBytes += event.bytes;
      if (event.stage === "blocked") { summary.blockedEvents++; write({ kind: "response_provenance", ...event }); }
      if (event.stage === "unverified") summary.skippedEvents++;
    },
    onRequest(event: CompactionRequestEvent) {
      if (!["started", "response_headers"].includes(event.phase)) flush(event.requestId, event.phase);
      write(event);
    },
    onNativeRequest(event: NativeRequestEvent) {
      flush(event.requestId, event.reason);
      write(event);
    },
    status: () => ({ mode: "request-summary", maxActive, active: summaries.size,
      maxFileBytes: DEFAULT_MAX_BYTES, backups: DEFAULT_BACKUPS }),
  };
}
export type RelayDiagnostics = ReturnType<typeof createRelayDiagnostics>;
