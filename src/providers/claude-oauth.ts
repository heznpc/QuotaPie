import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CollectionErrorCategory } from "../types";
export { mapClaudeUsage } from "../../packages/quota-core/src/claude-usage.js";

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
// Claude Code 2.x hashes the NFC-normalized config directory into the service
// name. Guessing directory basenames can miss the login or select another
// profile with the same basename. Never fall back to the default account.
export function keychainServiceCandidates(dir: string, configured?: string | null): string[] {
  if (configured) return [configured];
  const base = "Claude Code-credentials";
  if (resolve(dir) === join(homedir(), ".claude")) return [base];
  const suffix = createHash("sha256").update(resolve(dir).normalize("NFC")).digest("hex").slice(0, 8);
  return [`${base}-${suffix}`];
}

interface ClaudeKeychainResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr?: Buffer;
  signalCode?: string | number | null;
}

interface ClaudeCredentialReadOptions {
  platform?: NodeJS.Platform;
  keychainLookup?: (service: string, includeData: boolean) => ClaudeKeychainResult;
}

interface ClaudeCredentialAsyncReadOptions {
  platform?: NodeJS.Platform;
  keychainLookup?: (service: string, includeData: boolean) => Promise<ClaudeKeychainResult>;
  keychainCommand?: string;
  timeoutMs?: number;
}

function keychainFailure(result: ClaudeKeychainResult): ClaudeCredentialLookup | null {
  // `security` exposes OSStatus modulo 256. Only errSecItemNotFound (-25300)
  // establishes that no login exists; access errors and timeouts do not.
  if (result.exitCode === 44 && !result.signalCode) return null;
  let reason: string;
  if (result.signalCode || result.exitCode === null) {
    reason = "keychain lookup did not finish before its timeout";
  } else if (result.exitCode === 36) {
    reason = "keychain is locked or requires user interaction";
  } else if (result.exitCode === 35 || result.exitCode === 128) {
    reason = "keychain access was denied";
  } else {
    reason = `keychain lookup failed (exit ${result.exitCode})`;
  }
  // Never include raw keychain output, which may contain credential data.
  return { accessToken: null, error: reason, errorCategory: "provider-error" };
}

function keychainMetadataFailure(result: ClaudeKeychainResult): ClaudeCredentialLookup | null {
  if (result.exitCode === 0) {
    return {
      accessToken: null,
      error: "keychain item exists but its credentials could not be read",
      errorCategory: "provider-error",
    };
  }
  return keychainFailure(result);
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
      error: "Claude credentials contain no access token — run `claude auth login` in a terminal",
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
  options: ClaudeCredentialReadOptions = {},
): ClaudeCredentialLookup {
  const dir = configDir.startsWith("~") ? join(homedir(), configDir.slice(1)) : resolve(configDir);
  // Match Claude Code's source priority. A leftover plaintext fallback must
  // not override the current keychain login (including an explicit logout).
  if ((options.platform ?? process.platform) === "darwin") {
    const deadlineMs = Date.now() + KEYCHAIN_TIMEOUT_MS;
    const lookup = options.keychainLookup ?? ((service: string, includeData: boolean) => Bun.spawnSync(
      ["security", "find-generic-password", "-s", service, ...(includeData ? ["-w"] : [])],
      { timeout: Math.max(1, deadlineMs - Date.now()), stderr: "ignore" },
    ));
    for (const service of keychainServiceCandidates(dir, keychainService)) {
      let result: ClaudeKeychainResult;
      try { result = lookup(service, true); }
      catch {
        return { accessToken: null, error: "keychain lookup could not be started", errorCategory: "provider-error" };
      }
      if (result.exitCode === 0) return parseCredentialPayload(result.stdout.toString().trim());
      const failure = keychainFailure(result);
      if (failure) return failure;
      // A protected item's data may be hidden as errSecItemNotFound. Its
      // metadata remains readable without requesting a password or auth UI.
      try {
        const metadataFailure = keychainMetadataFailure(lookup(service, false));
        if (metadataFailure) return metadataFailure;
      } catch {
        return { accessToken: null, error: "keychain metadata lookup could not be started", errorCategory: "provider-error" };
      }
    }
  }
  return readFileCredentials(dir);
}

function readFileCredentials(dir: string): ClaudeCredentialLookup {
  const file = join(dir, ".credentials.json");
  if (existsSync(file)) {
    try {
      return parseCredentialPayload(readFileSync(file, "utf8"));
    } catch (error) {
      return {
        accessToken: null,
        error: `credentials file unreadable: ${String(error)}`,
        errorCategory: "provider-error",
      };
    }
  }
  return {
    accessToken: null,
    error: "no Claude login found — run `claude auth login` in a terminal",
    errorCategory: "auth-required",
  };
}

/** The daemon must remain responsive to status/API requests during Keychain access. */
export async function readClaudeCredentialsAsync(
  configDir = "~/.claude",
  keychainService?: string | null,
  options: ClaudeCredentialAsyncReadOptions = {},
): Promise<ClaudeCredentialLookup> {
  const dir = configDir.startsWith("~") ? join(homedir(), configDir.slice(1)) : resolve(configDir);
  if ((options.platform ?? process.platform) === "darwin") {
    const deadlineMs = Date.now() + (options.timeoutMs ?? KEYCHAIN_TIMEOUT_MS);
    const lookup = options.keychainLookup ?? (async (service: string, includeData: boolean): Promise<ClaudeKeychainResult> => {
      const child = Bun.spawn(
        [options.keychainCommand ?? "security", "find-generic-password", "-s", service, ...(includeData ? ["-w"] : [])],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: Math.max(1, deadlineMs - Date.now()) },
      );
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
      ]);
      return { exitCode, stdout: Buffer.from(stdout), signalCode: child.signalCode };
    });
    for (const service of keychainServiceCandidates(dir, keychainService)) {
      let result: ClaudeKeychainResult;
      try { result = await lookup(service, true); }
      catch {
        return { accessToken: null, error: "keychain lookup could not be started", errorCategory: "provider-error" };
      }
      if (result.exitCode === 0) return parseCredentialPayload(result.stdout.toString().trim());
      const failure = keychainFailure(result);
      if (failure) return failure;
      try {
        const metadataFailure = keychainMetadataFailure(await lookup(service, false));
        if (metadataFailure) return metadataFailure;
      } catch {
        return { accessToken: null, error: "keychain metadata lookup could not be started", errorCategory: "provider-error" };
      }
    }
  }
  return readFileCredentials(dir);
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
