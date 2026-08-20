import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AccountState, CollectionHealth, CollectionStateRow, Headline } from "./types";

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
  // 소비자가 자체 판단 없이 그대로 보여줄 수 있는 결론 한 줄(추가 필드, 하위호환).
  headline: { kind: Headline["kind"]; title: string; detail: string | null } | null;
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

// 전사 파일에서 토큰 수·경로·시각 필드만 사용한다. 대화 본문은 어떤 경로로도
// 사용·저장·전송하지 않는다. 다만 파일은 줄 단위 JSON이라 해당 필드에 닿으려면
// 그 줄을 파싱해야 하므로, "본문을 읽지 않는다"가 아니라 "본문을 쓰지 않는다"가
// 정확한 표현이다. 아래는 그 접촉면을 최소화한다: 관심 필드가 없는 줄은 파싱조차
// 하지 않고, 파일 전체를 한 번에 메모리에 올리지 않는다.
export async function scanBurnLeaderboard(
  nowMs: number,
  lookbackMs = 7 * 24 * 3_600_000,
  projectsDir = join(homedir(), ".claude", "projects"),
  limit = 5,
): Promise<QuotaBoundaryDocument["topBurn"]> {
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
      // 파일 수정 시각은 1차 필터일 뿐이다. 오래 이어온 대화는 오늘 한 줄만
      // 추가돼도 mtime이 갱신되므로, 실제 집계는 줄마다의 timestamp로 자른다.
      if (mtimeMs < cutoffMs) continue;
      let cwd: string | null = null;
      let tokens = 0;
      let lastActiveMs = 0;
      let text: string;
      try {
        text = await Bun.file(path).text();
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
        if (!usage) continue;
        const stamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
        // 시각을 모르는 줄은 최근 사용으로 셈하지 않는다. 창 밖의 토큰이
        // 최근 소진으로 흘러들면 순위 자체가 거짓이 된다.
        if (!Number.isFinite(stamp) || stamp < cutoffMs) continue;
        for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens"]) {
          const value = usage[key];
          if (typeof value === "number") tokens += value;
        }
        lastActiveMs = Math.max(lastActiveMs, stamp);
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

export async function cachedLeaderboard(nowMs: number): Promise<QuotaBoundaryDocument["topBurn"]> {
  if (!leaderboardCache || nowMs - leaderboardCache.computedAtMs > LEADERBOARD_TTL_MS) {
    leaderboardCache = { computedAtMs: nowMs, value: await scanBurnLeaderboard(nowMs) };
  }
  return leaderboardCache.value;
}

export function buildQuotaBoundary(
  accounts: AccountState[],
  headline: Headline | null,
  nowMs: number,
  // 리더보드는 파일 I/O라 호출자가 계산해 넘긴다. 문서 조립 자체는 순수하게 둔다.
  topBurn: QuotaBoundaryDocument["topBurn"] = [],
): QuotaBoundaryDocument {
  const providers: Record<string, CollectionHealth> = {};
  let lastSampleMs: number | null = null;
  for (const account of accounts) {
    const key = account.account === "default" ? account.provider : `${account.provider}/${account.account}`;
    providers[key] = account.collection.health;
    const success = account.collection.lastSuccessAtMs;
    if (success != null && (lastSampleMs == null || success > lastSampleMs)) lastSampleMs = success;
  }
  const ranked = accounts
    .flatMap((account) =>
      account.windows
        .filter((window) => window.freshness === "fresh")
        .map((window) => ({ account, window }))
    )
    .sort((left, right) => right.window.bottleneckScore - left.window.bottleneckScore);
  const bottleneck = ranked[0] ?? null;
  // 표시할 창의 수집이 최근에 성공했을 때만 healthy다. 오래된 숫자를 정상값처럼
  // 보여주느니 소비자가 표시를 숨기는 편이 낫다.
  const healthy = bottleneck != null && bottleneck.account.collection.health === "recent-success";
  return {
    schemaVersion: QUOTA_BOUNDARY_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    collection: { lastSampleAt: iso(lastSampleMs), healthy, providers },
    window: bottleneck
      ? {
        provider: bottleneck.account.account === "default"
          ? bottleneck.account.provider
          : `${bottleneck.account.provider}/${bottleneck.account.account}`,
        usedPercent: bottleneck.window.usedPercent,
        resetsAt: iso(bottleneck.window.resetsAtMs),
      }
      : null,
    headline: headline ? { kind: headline.kind, title: headline.title, detail: headline.detail } : null,
    topBurn,
  };
}

export function defaultBoundaryPath(): string {
  return join(homedir(), "Library", "Application Support", "QuotaPie", "quota.json");
}

export function writeQuotaBoundary(document: QuotaBoundaryDocument, path = defaultBoundaryPath()): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.quota.json.tmp-${process.pid}`);
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
