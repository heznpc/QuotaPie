import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectionHealth, CollectionStateRow, WindowAnalysis } from "./types";

// Modore 등 외부 소비자와의 통합 경계면. 이 파일 하나가 계약의 전부다:
// 소비자는 quota.json을 읽기만 하고, 파일이 없거나 generatedAt이 오래됐으면
// 표시 자체를 숨긴다. 필드 제거·의미 변경은 schemaVersion을 올려야 한다.
export const QUOTA_BOUNDARY_SCHEMA_VERSION = 1;

export interface QuotaBoundaryDocument {
  schemaVersion: number;
  generatedAt: string;
  collection: {
    lastSampleAt: string | null;
    healthy: boolean;
    providers: Record<string, CollectionHealth>;
  };
  window: {
    provider: string;
    usedPercent: number | null;
    resetsAt: string | null;
  } | null;
  topBurn: Array<{ remote: string; percent: number; lastActiveAt: string }>;
}

export function collectionHealth(
  row: CollectionStateRow | undefined,
  nowMs: number,
  staleAfterMs: number,
): CollectionHealth {
  if (!row || row.lastAttemptMs == null) return "never-attempted";
  if (row.lastSuccessMs == null) return "attempted-then-failed";
  if (row.lastError != null && row.lastAttemptMs > row.lastSuccessMs) return "attempted-then-failed";
  if (nowMs - row.lastSuccessMs > staleAfterMs) return "stale-success";
  return "recent-success";
}

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

interface BurnAccumulator {
  tokens: number;
  lastActiveMs: number;
}

const remoteCache = new Map<string, string>();

function remoteFor(cwd: string): string {
  const cached = remoteCache.get(cwd);
  if (cached) return cached;
  let remote = basename(cwd) || cwd;
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, "config", "--get", "remote.origin.url"]);
    const url = result.stdout.toString().trim();
    if (result.exitCode === 0 && url) {
      remote = url.replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/:/, "/").replace(/\.git$/, "");
    }
  } catch {
    // git 없음/디렉터리 삭제 등 — 디렉터리 이름으로 충분하다.
  }
  remoteCache.set(cwd, remote);
  return remote;
}

// 전사 파일에서 토큰 수·경로 메타데이터만 읽는다. 대화 본문(content)은 파싱하지 않는다.
export function scanBurnLeaderboard(
  nowMs: number,
  lookbackMs = 7 * 24 * 3_600_000,
  projectsDir = join(homedir(), ".claude", "projects"),
  limit = 5,
): QuotaBoundaryDocument["topBurn"] {
  if (!existsSync(projectsDir)) return [];
  const cutoffMs = nowMs - lookbackMs;
  const byRemote = new Map<string, BurnAccumulator>();
  let total = 0;
  for (const project of readdirSync(projectsDir)) {
    const dir = join(projectsDir, project);
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const path = join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoffMs) continue;
      let cwd: string | null = null;
      let tokens = 0;
      let lastActiveMs = mtimeMs;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const wantsCwd = cwd == null && line.includes('"cwd"');
        const wantsUsage = line.includes('"usage"');
        if (!wantsCwd && !wantsUsage) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (cwd == null && typeof parsed.cwd === "string") cwd = parsed.cwd;
        const message = parsed.message as { usage?: Record<string, unknown> } | undefined;
        const usage = message?.usage;
        if (usage) {
          for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens"]) {
            const value = usage[key];
            if (typeof value === "number") tokens += value;
          }
          const stamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
          if (Number.isFinite(stamp)) lastActiveMs = Math.max(lastActiveMs, stamp);
        }
      }
      if (!cwd || tokens <= 0) continue;
      const remote = remoteFor(cwd);
      const entry = byRemote.get(remote) ?? { tokens: 0, lastActiveMs: 0 };
      entry.tokens += tokens;
      entry.lastActiveMs = Math.max(entry.lastActiveMs, lastActiveMs);
      byRemote.set(remote, entry);
      total += tokens;
    }
  }
  if (total <= 0) return [];
  return [...byRemote.entries()]
    .sort((left, right) => right[1].tokens - left[1].tokens)
    .slice(0, limit)
    .map(([remote, entry]) => ({
      remote,
      percent: Math.round((entry.tokens / total) * 1000) / 10,
      lastActiveAt: new Date(entry.lastActiveMs).toISOString(),
    }));
}

let leaderboardCache: { computedAtMs: number; value: QuotaBoundaryDocument["topBurn"] } | null = null;
const LEADERBOARD_TTL_MS = 15 * 60_000;

function cachedLeaderboard(nowMs: number): QuotaBoundaryDocument["topBurn"] {
  if (!leaderboardCache || nowMs - leaderboardCache.computedAtMs > LEADERBOARD_TTL_MS) {
    leaderboardCache = { computedAtMs: nowMs, value: scanBurnLeaderboard(nowMs) };
  }
  return leaderboardCache.value;
}

export function buildQuotaBoundary(
  windows: WindowAnalysis[],
  states: CollectionStateRow[],
  nowMs: number,
  staleAfterMs: number,
  topBurn?: QuotaBoundaryDocument["topBurn"],
): QuotaBoundaryDocument {
  const providers: Record<string, CollectionHealth> = {};
  let lastSampleMs: number | null = null;
  for (const state of states) {
    const key = state.account === "default" ? state.provider : `${state.provider}/${state.account}`;
    providers[key] = collectionHealth(state, nowMs, staleAfterMs);
    if (state.lastSuccessMs != null && (lastSampleMs == null || state.lastSuccessMs > lastSampleMs)) {
      lastSampleMs = state.lastSuccessMs;
    }
  }
  const bottleneck = windows
    .filter((window) => window.freshness === "fresh")
    .sort((left, right) => right.bottleneckScore - left.bottleneckScore)[0] ?? null;
  const bottleneckState = bottleneck
    ? states.find((state) => state.provider === bottleneck.provider && state.account === bottleneck.account)
    : undefined;
  const healthy = bottleneck != null &&
    collectionHealth(bottleneckState, nowMs, staleAfterMs) === "recent-success";
  return {
    schemaVersion: QUOTA_BOUNDARY_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    collection: { lastSampleAt: iso(lastSampleMs), healthy, providers },
    window: bottleneck
      ? {
        provider: bottleneck.account === "default"
          ? bottleneck.provider
          : `${bottleneck.provider}/${bottleneck.account}`,
        usedPercent: bottleneck.usedPercent,
        resetsAt: iso(bottleneck.resetsAtMs),
      }
      : null,
    topBurn: topBurn ?? cachedLeaderboard(nowMs),
  };
}

export function defaultBoundaryPath(): string {
  return join(homedir(), "Library", "Application Support", "TimeQuota", "quota.json");
}

export function writeQuotaBoundary(document: QuotaBoundaryDocument, path = defaultBoundaryPath()): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.quota.json.tmp-${process.pid}`);
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
