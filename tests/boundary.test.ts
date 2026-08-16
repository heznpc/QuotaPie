import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQuotaBoundary,
  collectionHealth,
  writeQuotaBoundary,
  QUOTA_BOUNDARY_SCHEMA_VERSION,
} from "../src/boundary";
import type { CollectionStateRow, WindowAnalysis } from "../src/types";

const NOW = 1_000_000_000;
const STALE_AFTER = 600_000;

function state(overrides: Partial<CollectionStateRow> = {}): CollectionStateRow {
  return {
    provider: "codex",
    account: "default",
    lastAttemptMs: NOW - 1_000,
    lastSuccessMs: NOW - 1_000,
    lastError: null,
    ...overrides,
  };
}

function window(overrides: Partial<WindowAnalysis> = {}): WindowAnalysis {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:10080",
    label: "Codex weekly",
    windowSeconds: 604_800,
    source: "test",
    quality: "authoritative",
    freshness: "fresh",
    observedAtMs: NOW - 1_000,
    usedPercent: 66,
    remainingPercent: 34,
    resetsAtMs: NOW + 3_600_000,
    timeToResetMs: 3_600_000,
    reservePercent: 15,
    recentBurnPerHour: 1,
    personalBurnPerHour: 1,
    blendedBurnPerHour: 1,
    safePacePerActiveHour: 2,
    paceRatio: 0.5,
    exhaustsAtMs: null,
    minutesBeforeReset: null,
    confidence: "high",
    sampleCount: 100,
    activeHoursUntilReset: 10,
    bottleneckScore: 0.66,
    ...overrides,
  };
}

describe("collection heartbeat 4-state", () => {
  test("no row means never-attempted", () => {
    expect(collectionHealth(undefined, NOW, STALE_AFTER)).toBe("never-attempted");
  });

  test("attempt without success means attempted-then-failed", () => {
    expect(collectionHealth(state({ lastSuccessMs: null, lastError: "boom" }), NOW, STALE_AFTER))
      .toBe("attempted-then-failed");
  });

  test("failure after a past success means attempted-then-failed, not stale-success", () => {
    const row = state({
      lastSuccessMs: NOW - 30_000,
      lastAttemptMs: NOW - 1_000,
      lastError: "poll failed",
    });
    expect(collectionHealth(row, NOW, STALE_AFTER)).toBe("attempted-then-failed");
  });

  test("old success without newer failure means stale-success", () => {
    const row = state({ lastSuccessMs: NOW - STALE_AFTER - 1, lastAttemptMs: NOW - STALE_AFTER - 1 });
    expect(collectionHealth(row, NOW, STALE_AFTER)).toBe("stale-success");
  });

  test("recent success means recent-success", () => {
    expect(collectionHealth(state(), NOW, STALE_AFTER)).toBe("recent-success");
  });
});

describe("quota boundary document", () => {
  test("includes contract fields and marks healthy from the bottleneck provider state", () => {
    const document = buildQuotaBoundary([window()], [state()], NOW, STALE_AFTER, []);
    expect(document.schemaVersion).toBe(QUOTA_BOUNDARY_SCHEMA_VERSION);
    expect(document.generatedAt).toBe(new Date(NOW).toISOString());
    expect(document.collection.healthy).toBeTrue();
    expect(document.collection.lastSampleAt).toBe(new Date(NOW - 1_000).toISOString());
    expect(document.collection.providers.codex).toBe("recent-success");
    expect(document.window).toEqual({
      provider: "codex",
      usedPercent: 66,
      resetsAt: new Date(NOW + 3_600_000).toISOString(),
    });
  });

  test("collection dead means healthy=false so consumers show 수집 끊김 instead of stale numbers", () => {
    const dead = state({ lastError: "poll failed", lastAttemptMs: NOW - 100, lastSuccessMs: NOW - 900_000 });
    const document = buildQuotaBoundary([window()], [dead], NOW, STALE_AFTER, []);
    expect(document.collection.healthy).toBeFalse();
    expect(document.collection.providers.codex).toBe("attempted-then-failed");
  });

  test("no fresh window means window=null and healthy=false", () => {
    const document = buildQuotaBoundary([window({ freshness: "stale" })], [state()], NOW, STALE_AFTER, []);
    expect(document.window).toBeNull();
    expect(document.collection.healthy).toBeFalse();
  });

  test("picks the highest bottleneck across providers for the single window", () => {
    const document = buildQuotaBoundary(
      [
        window({ bottleneckScore: 0.4 }),
        window({ provider: "claude", bucket: "seven_day", usedPercent: 91, bottleneckScore: 1.2 }),
      ],
      [state(), state({ provider: "claude" })],
      NOW,
      STALE_AFTER,
      [],
    );
    expect(document.window?.provider).toBe("claude");
    expect(document.window?.usedPercent).toBe(91);
  });
});

describe("quota boundary file write", () => {
  test("writes atomically with 0600 and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-boundary-"));
    const path = join(dir, "quota.json");
    const document = buildQuotaBoundary([window()], [state()], NOW, STALE_AFTER, []);
    writeQuotaBoundary(document, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["quota.json"]);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schemaVersion).toBe(QUOTA_BOUNDARY_SCHEMA_VERSION);
    expect(parsed.collection.healthy).toBeTrue();
  });
});
