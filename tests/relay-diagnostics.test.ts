import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayDiagnostics, rotatingRelayLog } from "../src/relay-diagnostics";
import type { OwnershipProvenance } from "../src/codex-response-ownership";

const sample = { requestId: "request", ordinal: 1, bytes: 100, digest: "process-local-digest", ownership: "unattributed",
  response: null, item: null } as const;

test("token-event provenance is summarized once per request; blocked evidence is retained", () => {
  const logs: any[] = [], logger = createRelayDiagnostics(line => logs.push(JSON.parse(line)));
  for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
    logger.onProvenance({ ...sample, ordinal, stage: "validated" });
    logger.onProvenance({ ...sample, ordinal, stage: "queued" });
  }
  expect(logs).toHaveLength(0);
  logger.onProvenance({ ...sample, stage: "blocked", errorCode: "response_ownership_mismatch" });
  expect(logs).toHaveLength(1);
  logger.onNativeRequest({ kind: "native_request", requestId: sample.requestId, method: "POST", routeFamily: "responses", status: 200,
    origin: "relay", reason: "response_ownership_mismatch", at: new Date().toISOString() });
  expect(logs).toHaveLength(3);
  expect(logs[1]).toMatchObject({ kind: "response_ownership_summary", inspectedEvents: 10_000, queuedBytes: 1_000_000,
    blockedEvents: 1, ownership: { matched: 0, partial: 0, unattributed: 10_000 } });
  expect(logger.status().active).toBe(0);
});

test("native inspection skips cannot be logged as verified ownership and active summaries are bounded", () => {
  const logs: any[] = [], logger = createRelayDiagnostics(line => logs.push(JSON.parse(line)), 2);
  for (let request = 0; request < 5; request++) logger.onProvenance({ ...sample, requestId: String(request), stage: "unverified" });
  expect(logger.status().active).toBe(2); expect(logs).toHaveLength(3);
  expect(logs.every(log => log.reason === "capacity" && log.skippedEvents === 1 && log.inspectedEvents === 0)).toBe(true);
});

test("relay event files rotate within byte and backup bounds, keep complete JSON and reject giant records", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-log-")), path = join(root, "events.jsonl");
  try {
    const write = rotatingRelayLog(path, 512, 2);
    for (let ordinal = 0; ordinal < 100; ordinal++) write(JSON.stringify({ ordinal, value: "x".repeat(50) }));
    expect(readdirSync(root).sort()).toEqual(["events.jsonl", "events.jsonl.1", "events.jsonl.2"]);
    for (const file of readdirSync(root)) {
      expect(statSync(join(root, file)).size).toBeLessThanOrEqual(512);
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      for (const line of readFileSync(join(root, file), "utf8").trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
    const before = readFileSync(path, "utf8"); write("x".repeat(513)); expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(before.trim().split("\n").at(-1)!).ordinal).toBe(99);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("log failures and symlinks cannot modify another file or interrupt response diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-log-"));
  try {
    const target = join(root, "private"), link = join(root, "events.jsonl"); writeFileSync(target, "unchanged"); symlinkSync(target, link);
    expect(() => rotatingRelayLog(link)("event")).not.toThrow(); expect(readFileSync(target, "utf8")).toBe("unchanged");
    const logger = createRelayDiagnostics(() => { throw new Error("disk unavailable"); });
    expect(() => logger.onProvenance({ ...sample, stage: "blocked" } as OwnershipProvenance & { requestId: string })).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
