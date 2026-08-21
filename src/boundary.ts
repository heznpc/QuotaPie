import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AccountState, CollectionHealth, CollectionStateRow, Headline } from "./types";

// The integration boundary with external consumers such as Modore. This one
// file is the whole contract: consumers only read quota.json, and hide their
// display entirely when the file is missing or generatedAt has gone stale.
// Removing a field or changing its meaning requires bumping schemaVersion.
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
  // One line a consumer can display as-is without making its own judgement
  // (an added field, backward compatible).
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
    // No git, deleted directory, and so on — the directory name is enough.
  }
  remoteCache.set(cwd, remote);
  return remote;
}

// Uses only the token, path, and timestamp fields from transcripts.
// Conversation content is never used, stored, or transmitted. The files are
// line-delimited JSON, though, so reaching those fields does mean parsing the
// lines that hold them — the accurate claim is "the content is not used", not
// "the content is never touched". This keeps that contact surface small:
// lines without the fields of interest are not parsed at all, and the file is
// not materialised in memory in one piece.
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
      // The file mtime is only a first pass. One message added today
      // refreshes the mtime of a months-old transcript, so the actual tally
      // is cut by each line's own timestamp.
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
        // A line with no timestamp is not counted as recent usage. Letting
        // tokens from outside the window leak in would make the ranking
        // itself a lie.
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
  // The leaderboard is file I/O, so the caller computes it and passes it in.
  // Assembling the document itself stays pure.
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
  // Healthy only when collection for the displayed window recently
  // succeeded. Better that a consumer hides the display than shows an old
  // number as if it were current.
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
