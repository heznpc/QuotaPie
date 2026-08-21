import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildQuotaBoundary,
  collectionHealth,
  readLines,
  scanBurnLeaderboard,
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

describe("burn leaderboard window", () => {
  function transcript(dir: string, name: string, lines: Array<Record<string, unknown>>) {
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    const path = join(project, name);
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return path;
  }

  function usageLine(isoTimestamp: string, tokens: number, cwd?: string) {
    return {
      ...(cwd ? { cwd } : {}),
      timestamp: isoTimestamp,
      message: { usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0 } },
    };
  }

  test("a long-running transcript only contributes tokens spent inside the window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-burn-"));
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    // A three-month-old conversation with one line added today. The mtime is
    // recent, but the old tokens are not recent burn.
    transcript(dir, "old-and-new.jsonl", [
      usageLine("2026-05-20T12:00:00.000Z", 1_000_000, "/tmp/project-a"),
      usageLine("2026-06-20T12:00:00.000Z", 1_000_000),
      usageLine("2026-08-20T11:00:00.000Z", 10, undefined),
    ]);
    const board = await scanBurnLeaderboard(now, 7 * 24 * 3_600_000, dir);
    expect(board).toHaveLength(1);
    expect(board[0]!.percent).toBe(100);
    expect(Date.parse(board[0]!.lastActiveAt)).toBe(Date.parse("2026-08-20T11:00:00.000Z"));
  });

  test("ranking reflects recent spend, not lifetime spend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-burn-"));
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    transcript(dir, "veteran.jsonl", [
      usageLine("2026-01-01T00:00:00.000Z", 9_000_000, "/tmp/veteran"),
      usageLine("2026-08-19T00:00:00.000Z", 100),
    ]);
    transcript(dir, "newcomer.jsonl", [
      usageLine("2026-08-19T00:00:00.000Z", 900, "/tmp/newcomer"),
    ]);
    const board = await scanBurnLeaderboard(now, 7 * 24 * 3_600_000, dir);
    expect(board[0]!.remote).toBe("newcomer");
    expect(board[0]!.percent).toBe(90);
  });

  test("entries whose usage lines carry no timestamp are not counted as recent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-burn-"));
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    transcript(dir, "undated.jsonl", [
      { cwd: "/tmp/undated", message: { usage: { input_tokens: 5_000 } } },
    ]);
    expect(await scanBurnLeaderboard(now, 7 * 24 * 3_600_000, dir)).toEqual([]);
  });
});

describe("streaming line reader", () => {
  function stream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  async function collect(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of readLines(stream(chunks))) out.push(line);
    return out;
  }

  test("a line split across chunk boundaries is reassembled", async () => {
    expect(await collect(['{"a":', '1}\n{"b":2}', "\n"])).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("a final line without a trailing newline is still emitted", async () => {
    expect(await collect(['{"a":1}\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("empty lines are preserved as empty strings rather than dropped or merged", async () => {
    expect(await collect(["a\n\nb\n"])).toEqual(["a", "", "b"]);
  });

  test("a multi-byte character split across chunks is not corrupted", async () => {
    const encoded = new TextEncoder().encode("한글\n");
    const encoder = new TextDecoder();
    const first = encoded.slice(0, 4);
    const second = encoded.slice(4);
    const parts = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const line of readLines(parts)) out.push(line);
    expect(out).toEqual(["한글"]);
    expect(encoder.decode(encoded).trim()).toBe("한글");
  });

  test("a very long single line survives being spread over many chunks", async () => {
    const long = "x".repeat(200_000);
    const chunks: string[] = [];
    for (let index = 0; index < long.length; index += 4_096) {
      chunks.push(long.slice(index, index + 4_096));
    }
    chunks.push("\n");
    const out = await collect(chunks);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(200_000);
  });

  test("an empty stream yields nothing", async () => {
    expect(await collect([])).toEqual([]);
  });
});
