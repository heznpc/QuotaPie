import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CollectionErrorCategory, QuotaObservation } from "../types";
import { durationFor, labelFor } from "./claude-statusline";

// Reads the official usage endpoint using Claude Code's local OAuth
// credentials. The token is read per call and never stored anywhere.
// If only the desktop app is used, the status line never runs, which makes
// this the primary source rather than a supplement.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA_HEADER = "oauth-2025-04-20";
// Both the credential lookup and the network call are bounded. A stuck
// Claude source must not delay Codex polling, alerts, retention, or the
// quota.json publication.
const KEYCHAIN_TIMEOUT_MS = 3_000;
const USAGE_TIMEOUT_MS = 10_000;

export interface ClaudeCredentialLookup {
  accessToken: string | null;
  error: string | null;
  errorCategory: CollectionErrorCategory | null;
}

// Claude Code keeps the default profile under "Claude Code-credentials", and
// profiles with their own config directory under a service name derived from
// that directory. Falling back to the default item would attribute another
// account's token to this one, so there is no fallback.
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
  // A failure reason found in the file (expiry, for instance) survives a
  // failed keychain fallback. Losing it would turn "refresh your expired
  // login" into "log in for the first time".
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

  // Newer responses carry weekly caps in a limits array instead of flat
  // fields. Buckets already filled from the flat form are left alone, which
  // keeps this stable while both shapes coexist.
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
