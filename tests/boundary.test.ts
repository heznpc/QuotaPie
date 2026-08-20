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
import type { AccountState, CollectionSourceState, CollectionStateRow, WindowAnalysis } from "../src/types";

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

function source(overrides: Partial<CollectionSourceState> = {}): CollectionSourceState {
  return {
    source: "codex-appserver",
    health: "recent-success",
    lastAttemptAtMs: NOW - 1_000,
    lastSuccessAtMs: NOW - 1_000,
    errorCategory: null,
    errorDetail: null,
    ...overrides,
  };
}

type AccountOverrides = Partial<Omit<AccountState, "collection">> & { sources?: CollectionSourceState[] };

function account(overrides: AccountOverrides = {}): AccountState {
  const windows = overrides.windows ?? [window()];
  const sources = overrides.sources ?? [source()];
  return {
    provider: "codex",
    account: "default",
    accountLabel: "Main",
    enabled: true,
    windows,
    bottleneckBucket: windows[0]?.bucket ?? null,
    updatedAtMs: windows.length ? Math.max(...windows.map((item) => item.observedAtMs)) : null,
    ...overrides,
    collection: {
      health: sources[0]?.health ?? "never-attempted",
      activeSource: sources[0]?.lastSuccessAtMs != null ? sources[0].source : null,
      lastSuccessAtMs: sources[0]?.lastSuccessAtMs ?? null,
      errorCategory: sources.find((item) => item.errorCategory != null)?.errorCategory ?? null,
      errorDetail: sources.find((item) => item.errorDetail != null)?.errorDetail ?? null,
      sources,
    },
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
    riskLevel: "none",
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
    const document = buildQuotaBoundary([account()], null, NOW, []);
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
    const dead = account({
      sources: [source({ health: "attempted-then-failed", errorDetail: "poll failed" })],
    });
    const document = buildQuotaBoundary([dead], null, NOW, []);
    expect(document.collection.healthy).toBeFalse();
    expect(document.collection.providers.codex).toBe("attempted-then-failed");
  });

  test("no fresh window means window=null and healthy=false", () => {
    const document = buildQuotaBoundary([account({ windows: [window({ freshness: "stale" })] })], null, NOW, []);
    expect(document.window).toBeNull();
    expect(document.collection.healthy).toBeFalse();
  });

  test("picks the highest bottleneck across providers for the single window", () => {
    const document = buildQuotaBoundary(
      [
        account({ windows: [window({ bottleneckScore: 0.4 })] }),
        account({
          provider: "claude",
          windows: [window({ provider: "claude", bucket: "seven_day", usedPercent: 91, bottleneckScore: 1.2 })],
          sources: [source({ source: "claude-oauth" })],
        }),
      ],
      null,
      NOW,
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
    const document = buildQuotaBoundary([account()], null, NOW, []);
    writeQuotaBoundary(document, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["quota.json"]);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schemaVersion).toBe(QUOTA_BOUNDARY_SCHEMA_VERSION);
    expect(parsed.collection.healthy).toBeTrue();
  });
});
