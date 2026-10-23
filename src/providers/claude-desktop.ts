import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { accessSummary, type ClaudeAccessSummary } from "../claude-access";
import { createHash } from "node:crypto";
import { ACCOUNT_PLAN_KINDS, type AccountPlanKind, type CollectionErrorCategory, type QuotaObservation } from "../types";
import { mapClaudeUsage } from "./claude-oauth";

export const CLAUDE_DESKTOP_SOURCE = "claude-desktop";
export const CLAUDE_DESKTOP_MIN_INTERVAL_MS = 5 * 60_000;
export const CLAUDE_DESKTOP_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface ClaudeDesktopIdentity { accountId: string; organizationId: string }
export interface ClaudeDesktopRead extends ClaudeDesktopIdentity { usage: Record<string, unknown>; plan: AccountPlanKind; access?: ClaudeAccessSummary; sessionFingerprint?: string }
export interface ClaudeDesktopOptions {
  helperPath?: string;
  timeoutMs?: number;
  read?: (connect: boolean) => Promise<unknown>;
}

const MESSAGES: Partial<Record<CollectionErrorCategory, string>> = {
  "claude-desktop-unavailable": "Claude desktop connection is unavailable. Connect the signed-in Claude app from QuotaPie.",
  "claude-desktop-keychain": "Allow QuotaPie to access Claude desktop's saved session when connecting. Background checks never request Keychain interaction.",
  "account-mismatch": "The Claude app account or organization changed. Connect the current account separately.",
  "auth-required": "Sign in to the Claude desktop app, then connect it from QuotaPie.",
  "auth-expired": "The Claude desktop session expired. Sign in to the Claude app again.",
  "access-denied": "The Claude desktop session does not have permission to read usage limits.",
  "rate-limited": "Claude temporarily limited usage queries. The next background check will wait at least five minutes.",
  "network": "The Claude desktop usage request could not complete. QuotaPie will try again later.",
  "provider-error": "The Claude desktop usage response could not be verified.",
  "no-windows": "Claude desktop is connected, but the account did not provide numeric usage limits.",
};

export class ClaudeDesktopError extends Error {
  constructor(readonly category: CollectionErrorCategory) {
    super(MESSAGES[category] ?? MESSAGES["provider-error"]!);
    this.name = "ClaudeDesktopError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sameClaudeDesktopIdentity(a: ClaudeDesktopIdentity, b: ClaudeDesktopIdentity): boolean {
  return a.accountId.toLowerCase() === b.accountId.toLowerCase() &&
    a.organizationId.toLowerCase() === b.organizationId.toLowerCase();
}

export function claudeDesktopIdentityKey(identity: ClaudeDesktopIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.accountId.toLowerCase(), identity.organizationId.toLowerCase()])).digest("hex");
}

function helperPath(option?: string): string {
  if (option) return option;
  if (process.env.QUOTAPIE_CLAUDE_SESSION_HELPER) return process.env.QUOTAPIE_CLAUDE_SESSION_HELPER;
  const bundled = join(dirname(process.execPath), "..", "Helpers", "QuotaPieClaudeSessionHelper");
  const local = join(homedir(), "Applications", "QuotaPie.app", "Contents", "Helpers", "QuotaPieClaudeSessionHelper");
  return [bundled, local].find(path => existsSync(path)) ?? "/Applications/QuotaPie.app/Contents/Helpers/QuotaPieClaudeSessionHelper";
}

async function runHelper(connect: boolean, options: ClaudeDesktopOptions): Promise<unknown> {
  const child = Bun.spawn([helperPath(options.helperPath), ...(connect ? ["--connect"] : [])], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: options.timeoutMs ?? (connect ? 120_000 : 45_000),
  });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of child.stdout) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) {
      child.kill(); await child.exited;
      throw new ClaudeDesktopError("provider-error");
    }
    chunks.push(chunk);
  }
  const code = await child.exited;
  if (child.signalCode) throw new ClaudeDesktopError("claude-desktop-unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ClaudeDesktopError("provider-error"); }
  if (code !== 0 && (!object(parsed) || parsed.ok !== false)) throw new ClaudeDesktopError("provider-error");
  return parsed;
}

/** The helper alone owns cookies, Keychain access and HTTPS. No credentials or
 * raw helper errors cross this boundary or enter logs/config/observations. */
export async function readClaudeDesktop(connect = false, options: ClaudeDesktopOptions = {}): Promise<ClaudeDesktopRead> {
  let result: unknown;
  try { result = await (options.read ? options.read(connect) : runHelper(connect, options)); }
  catch (error) {
    throw error instanceof ClaudeDesktopError ? error : new ClaudeDesktopError("claude-desktop-unavailable");
  }
  if (!object(result)) throw new ClaudeDesktopError("provider-error");
  if (result.ok === false) {
    const category = typeof result.category === "string" && Object.hasOwn(MESSAGES, result.category)
      ? result.category as CollectionErrorCategory : "provider-error";
    throw new ClaudeDesktopError(category);
  }
  if (result.ok !== true || typeof result.accountId !== "string" || !CLAUDE_DESKTOP_UUID.test(result.accountId) ||
      typeof result.organizationId !== "string" || !CLAUDE_DESKTOP_UUID.test(result.organizationId) || !object(result.usage))
    throw new ClaudeDesktopError("provider-error");
  // Validate before a successful connection can be persisted.
  mapClaudeDesktopUsage(result.usage, "validation", 0);
  // Older helpers have no plan field. Missing or unrecognized metadata must
  // never turn an empty usage response into a guessed Free subscription.
  const plan = typeof result.plan === "string" && ACCOUNT_PLAN_KINDS.includes(result.plan as AccountPlanKind)
    ? result.plan as AccountPlanKind : "unknown";
  const sessionFingerprint = typeof result.sessionFingerprint === "string" && /^[a-f0-9]{64}$/.test(result.sessionFingerprint)
    ? result.sessionFingerprint : undefined;
  return { accountId: result.accountId.toLowerCase(), organizationId: result.organizationId.toLowerCase(), usage: result.usage, plan,
    ...(sessionFingerprint ? { sessionFingerprint } : {}),
    ...(result.access == null ? {} : { access: accessSummary(result.access) }) };
}

const LEGACY_BUCKETS = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_oauth_apps",
  "seven_day_cowork", "seven_day_omelette", "omelette_promotional", "seven_day_sonnet"]);

// Keep server decisions distinct from dates and displayed availability. Missing
// or null grant data is unknown, not proof that a ticket was consumed.
function resetGrantState(value: unknown): Record<string, unknown> {
  if (value === null) return { source: "claude-usage.cedar_ember", state: "not-provided" };
  const invalid = () => new ClaudeDesktopError("provider-error");
  if (!object(value) || !Array.isArray(value.grants) || value.grants.length > 128) throw invalid();
  const safe: Record<string, unknown> = { source: "claude-usage.cedar_ember", state: "reported" };
  for (const key of ["eligible", "at_limit"]) if (Object.hasOwn(value, key)) {
    if (typeof value[key] !== "boolean") throw invalid();
    safe[key] = value[key];
  }
  const ids = new Set<string>();
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 120 && !/[\x00-\x1f\x7f]/.test(v);
  safe.grants = value.grants.map(raw => {
    if (!object(raw) || !text(raw.id) || ids.has(raw.id)) throw invalid();
    ids.add(raw.id);
    const grant: Record<string, unknown> = { id: raw.id };
    for (const key of ["resets_total", "resets_left"]) {
      const count = raw[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw invalid();
      grant[key] = count;
    }
    if ((grant.resets_left as number) > (grant.resets_total as number)) throw invalid();
    for (const key of ["starts_at", "ends_at"]) if (Object.hasOwn(raw, key)) {
      const date = raw[key];
      if (date !== null && (typeof date !== "string" || !Number.isFinite(Date.parse(date)))) throw invalid();
      grant[key] = date;
    }
    for (const key of ["usable_now", "claimable", "paused"]) if (Object.hasOwn(raw, key)) {
      if (typeof raw[key] !== "boolean") throw invalid();
      grant[key] = raw[key];
    }
    for (const key of ["clears", "blocking"]) if (Object.hasOwn(raw, key)) {
      if (!Array.isArray(raw[key]) || raw[key].length > 128 || !raw[key].every(text)) throw invalid();
      grant[key] = [...raw[key]];
    }
    return grant;
  });
  return safe;
}

export function mapClaudeDesktopUsage(payload: unknown, account: string, observedAtMs = Date.now()): QuotaObservation[] {
  if (!object(payload)) throw new ClaudeDesktopError("provider-error");
  const accepted: Record<string, unknown> = {};
  let recognized = Object.keys(payload).length === 0;
  const resetGrant = Object.hasOwn(payload, "cedar_ember") ? resetGrantState(payload.cedar_ember) : undefined;
  if (resetGrant) recognized = true;
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const reset = (value: unknown) => value == null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  for (const [key, value] of Object.entries(payload)) {
    if (key === "extra_usage") { recognized = true; continue; }
    if (!LEGACY_BUCKETS.has(key)) continue;
    recognized = true;
    if (value == null) continue;
    if (!object(value) || !Object.hasOwn(value, "utilization") || (value.utilization != null && !numeric(value.utilization)) || !reset(value.resets_at))
      throw new ClaudeDesktopError("provider-error");
    if (value.utilization != null) accepted[key] = { utilization: value.utilization, resets_at: value.resets_at };
  }
  const limits: Record<string, unknown>[] = [];
  if (Object.hasOwn(payload, "limits")) {
    recognized = true;
    if (!Array.isArray(payload.limits)) throw new ClaudeDesktopError("provider-error");
    for (const entry of payload.limits) {
      if (!object(entry) || typeof entry.kind !== "string" || typeof entry.group !== "string" ||
          !numeric(entry.percent) || !reset(entry.resets_at)) throw new ClaudeDesktopError("provider-error");
      const scope = entry.scope;
      if (scope != null && !object(scope)) throw new ClaudeDesktopError("provider-error");
      const model = object(scope) ? scope.model : null;
      const surface = object(scope) ? scope.surface : null;
      for (const item of [model, surface]) if (item != null && (!object(item) || typeof item.display_name !== "string" ||
          !item.display_name.trim() || item.display_name.length > 120 || /[\x00-\x1f\x7f]/.test(item.display_name)))
        throw new ClaudeDesktopError("provider-error");
      const name = object(model) ? model.display_name : object(surface) ? surface.display_name : null;
      if (!["session", "weekly_all", "weekly_scoped"].includes(entry.kind)) throw new ClaudeDesktopError("provider-error");
      if (entry.kind === "weekly_scoped" && !name) throw new ClaudeDesktopError("provider-error");
      limits.push({ kind: entry.kind, percent: entry.percent, resets_at: entry.resets_at,
        scope: name ? { model: { display_name: name } } : null });
    }
  }
  if (!recognized) throw new ClaudeDesktopError("provider-error");
  const observations: QuotaObservation[] = mapClaudeUsage({ ...accepted, limits }, account, observedAtMs).map(observation => ({
    ...observation, source: CLAUDE_DESKTOP_SOURCE,
    ...(resetGrant ? { metadata: { ...observation.metadata, claudeResetGrantJSON: JSON.stringify(resetGrant) } } : {}),
  }));
  const canonical = observations.find(item => item.bucket === "five_hour") ?? observations[0];
  if (canonical && Array.isArray(resetGrant?.grants)) {
    canonical.resetCreditsAvailable = resetGrant.grants.reduce((total, grant) => total + grant.resets_left, 0);
  }
  const grant = accepted.omelette_promotional;
  if (object(grant) && typeof grant.utilization === "number") observations.push({
    provider: "claude", account, bucket: "omelette_promotional", label: "Claude Design grant", windowSeconds: null,
    usedPercent: grant.utilization, resetsAtMs: typeof grant.resets_at === "string" ? Date.parse(grant.resets_at) : null,
    observedAtMs, source: CLAUDE_DESKTOP_SOURCE, quality: "authoritative",
  });
  return observations;
}
