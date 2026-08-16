import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { QuotaObservation } from "../types";
import { durationFor, labelFor } from "./claude-statusline";

// Claude Code CLI의 로컬 OAuth 자격증명으로 공식 usage 엔드포인트를 읽는다.
// 토큰은 매 호출 시 로컬 저장소에서 읽기만 하고 어디에도 저장하지 않는다.
// 데스크톱 앱만 쓰는 환경에서는 statusline이 영원히 침묵하므로 이 경로가 주 수집원이다.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";

export interface ClaudeCredentialLookup {
  accessToken: string | null;
  error: string | null;
}

function parseCredentialPayload(raw: string): ClaudeCredentialLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accessToken: null, error: "credential payload is not JSON" };
  }
  const oauth = (parsed as Record<string, unknown>)?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth) return { accessToken: null, error: "no claudeAiOauth block in credentials" };
  const token = oauth.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    return { accessToken: null, error: "OAuth token empty — run `claude auth login` in a terminal" };
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt === "number" && expiresAt > 0 && expiresAt < Date.now() + 60_000) {
    return { accessToken: null, error: "OAuth token expired — run `claude` in a terminal to refresh" };
  }
  return { accessToken: token, error: null };
}

export function readClaudeCredentials(configDir = "~/.claude"): ClaudeCredentialLookup {
  const dir = configDir.startsWith("~") ? join(homedir(), configDir.slice(1)) : resolve(configDir);
  const file = join(dir, ".credentials.json");
  if (existsSync(file)) {
    try {
      return parseCredentialPayload(readFileSync(file, "utf8"));
    } catch (error) {
      return { accessToken: null, error: `credentials file unreadable: ${String(error)}` };
    }
  }
  // 파일이 없으면 macOS 키체인(기본 프로필 전용). 별도 프로필은 파일 저장을 쓴다.
  const isDefaultDir = resolve(dir) === join(homedir(), ".claude");
  if (process.platform === "darwin" && isDefaultDir) {
    try {
      const result = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
      if (result.exitCode === 0) return parseCredentialPayload(result.stdout.toString().trim());
      return { accessToken: null, error: "no keychain credentials — run `claude auth login` in a terminal" };
    } catch (error) {
      return { accessToken: null, error: `keychain lookup failed: ${String(error)}` };
    }
  }
  return { accessToken: null, error: `no credentials at ${file}` };
}

interface FlatLimit {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ScopedLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

function resetMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export function mapClaudeUsage(
  payload: unknown,
  account = "default",
  observedAtMs = Date.now(),
): QuotaObservation[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const buckets = new Map<string, { usedPercent: number; resetsAtMs: number | null }>();

  for (const [key, value] of Object.entries(root)) {
    if (!/^(five_hour|seven_day)/.test(key)) continue;
    if (!value || typeof value !== "object") continue;
    const flat = value as FlatLimit;
    if (typeof flat.utilization !== "number" || !Number.isFinite(flat.utilization)) continue;
    buckets.set(key, { usedPercent: flat.utilization, resetsAtMs: resetMs(flat.resets_at) });
  }

  // 신형 응답은 weekly 상한이 flat 필드 대신 limits 배열로 온다. flat이 이미
  // 채운 버킷은 건드리지 않아 두 형식이 공존하는 과도기에도 안정적이다.
  const limits = root.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits as ScopedLimit[]) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue;
      let bucket: string | null = null;
      if (entry.kind === "session") bucket = "five_hour";
      else if (entry.kind === "weekly_all") bucket = "seven_day";
      else if (entry.kind === "weekly_scoped") {
        const name = entry.scope?.model?.display_name;
        if (typeof name === "string" && name.length > 0) {
          bucket = `seven_day_${name.toLowerCase().replaceAll(/\s+/g, "_")}`;
        }
      }
      if (!bucket || buckets.has(bucket)) continue;
      buckets.set(bucket, { usedPercent: entry.percent, resetsAtMs: resetMs(entry.resets_at) });
    }
  }

  return [...buckets.entries()].map(([bucket, value]) => ({
    provider: "claude" as const,
    account,
    bucket,
    label: labelFor(bucket),
    windowSeconds: durationFor(bucket),
    usedPercent: value.usedPercent,
    resetsAtMs: value.resetsAtMs,
    observedAtMs,
    source: "claude-oauth",
    quality: "authoritative" as const,
  }));
}

export async function fetchClaudeUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(USAGE_URL, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": BETA_HEADER,
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`usage endpoint auth rejected (HTTP ${response.status}) — run \`claude\` to refresh login`);
  }
  if (response.status === 429) {
    throw new Error("usage endpoint rate limited (HTTP 429)");
  }
  if (!response.ok) {
    throw new Error(`usage endpoint failed (HTTP ${response.status})`);
  }
  return response.json();
}
