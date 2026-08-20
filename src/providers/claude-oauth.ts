import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CollectionErrorCategory, QuotaObservation } from "../types";
import { durationFor, labelFor } from "./claude-statusline";

// Claude Code CLI의 로컬 OAuth 자격증명으로 공식 usage 엔드포인트를 읽는다.
// 토큰은 매 호출 시 로컬 저장소에서 읽기만 하고 어디에도 저장하지 않는다.
// 데스크톱 앱만 쓰는 환경에서는 statusline이 영원히 침묵하므로 이 경로가 주 수집원이다.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
// 자격증명 조회와 네트워크 호출 모두 상한을 둔다. Claude 소스가 멈춰도
// Codex 폴링·알림·보존·quota.json 발행이 지연되면 안 된다.
const KEYCHAIN_TIMEOUT_MS = 3_000;
const USAGE_TIMEOUT_MS = 10_000;

export interface ClaudeCredentialLookup {
  accessToken: string | null;
  error: string | null;
  errorCategory: CollectionErrorCategory | null;
}

// Claude Code는 기본 프로필을 "Claude Code-credentials"에 넣고, 별도 config
// 디렉터리를 쓰는 프로필은 디렉터리를 붙인 서비스 이름을 쓴다. 기본 서비스로
// 폴백하면 다른 계정의 토큰을 이 계정 것으로 오인하므로 폴백하지 않는다.
export function keychainServiceCandidates(dir: string, configured?: string | null): string[] {
  if (configured) return [configured];
  const base = "Claude Code-credentials";
  if (resolve(dir) === join(homedir(), ".claude")) return [base];
  return [`${base}-${resolve(dir)}`, `${base}-${basename(resolve(dir))}`];
}

function parseCredentialPayload(raw: string): ClaudeCredentialLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accessToken: null, error: "credential payload is not JSON", errorCategory: "provider-error" };
  }
  const oauth = (parsed as Record<string, unknown>)?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth) {
    return { accessToken: null, error: "no claudeAiOauth block in credentials", errorCategory: "auth-required" };
  }
  const token = oauth.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    return {
      accessToken: null,
      error: "no Claude login found — run `claude auth login` in a terminal",
      errorCategory: "auth-required",
    };
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt === "number" && expiresAt > 0 && expiresAt < Date.now() + 60_000) {
    return {
      accessToken: null,
      error: "Claude login expired — run `claude` in a terminal to refresh",
      errorCategory: "auth-expired",
    };
  }
  return { accessToken: token, error: null, errorCategory: null };
}

export function readClaudeCredentials(
  configDir = "~/.claude",
  keychainService?: string | null,
): ClaudeCredentialLookup {
  const dir = configDir.startsWith("~") ? join(homedir(), configDir.slice(1)) : resolve(configDir);
  const file = join(dir, ".credentials.json");
  // 파일에서 읽은 실패 사유(만료 등)는 키체인 폴백이 실패해도 잃지 않는다.
  // 잃으면 "만료됐으니 갱신하라"가 "처음 로그인하라"로 잘못 안내된다.
  let lastFailure: ClaudeCredentialLookup | null = null;
  if (existsSync(file)) {
    try {
      const fromFile = parseCredentialPayload(readFileSync(file, "utf8"));
      if (fromFile.accessToken) return fromFile;
      lastFailure = fromFile;
    } catch (error) {
      return {
        accessToken: null,
        error: `credentials file unreadable: ${String(error)}`,
        errorCategory: "provider-error",
      };
    }
  }
  if (process.platform !== "darwin") {
    return lastFailure
      ?? { accessToken: null, error: `no credentials at ${file}`, errorCategory: "auth-required" };
  }
  for (const service of keychainServiceCandidates(dir, keychainService)) {
    let result: { exitCode: number | null; stdout: Buffer };
    try {
      result = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"], {
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
    } catch (error) {
      lastFailure = {
        accessToken: null,
        error: `keychain lookup failed: ${String(error)}`,
        errorCategory: "provider-error",
      };
      continue;
    }
    if (result.exitCode !== 0) continue;
    const parsed = parseCredentialPayload(result.stdout.toString().trim());
    if (parsed.accessToken) return parsed;
    lastFailure = parsed;
  }
  return lastFailure ?? {
    accessToken: null,
    error: "no Claude login found — run `claude auth login` in a terminal",
    errorCategory: "auth-required",
  };
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

export class ClaudeUsageError extends Error {
  constructor(message: string, readonly category: CollectionErrorCategory) {
    super(message);
    this.name = "ClaudeUsageError";
  }
}

export async function fetchClaudeUsage(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = USAGE_TIMEOUT_MS,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(USAGE_URL, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": BETA_HEADER,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ClaudeUsageError(`usage endpoint unreachable: ${message}`, "network");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ClaudeUsageError(
      `usage endpoint rejected the login (HTTP ${response.status})`,
      "auth-expired",
    );
  }
  if (response.status === 429) {
    throw new ClaudeUsageError("usage endpoint rate limited (HTTP 429)", "rate-limited");
  }
  if (!response.ok) {
    throw new ClaudeUsageError(`usage endpoint failed (HTTP ${response.status})`, "provider-error");
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ClaudeUsageError(`usage response was not JSON: ${String(error)}`, "provider-error");
  }
}
