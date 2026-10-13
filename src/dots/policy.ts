import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { codexProfileRoot, type AppConfig } from "../config";
import { resumeProfileKey, type ResumeGate } from "../resume-gate";
import type { DotPolicy, TargetState } from "./store";

export function parsePolicy(input: unknown, config: AppConfig): DotPolicy {
  const p = input as DotPolicy;
  if (!p || typeof p !== "object" || Array.isArray(p) ||
      Object.keys(p).some(k => !["id", "threadId", "account", "continuation", "trigger", "resetBucket",
        "resetWithinMinutes", "requiredBucket", "reservePercent", "maxTurns", "maxUsagePercent", "expiresAtMs", "priority", "executionMode"].includes(k)) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id ?? "") ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(p.threadId ?? "") ||
      typeof p.account !== "string" || typeof p.continuation !== "string" ||
      p.continuation.length < 1 || p.continuation.length > 2000 ||
      !["quota.ready", "quota.reset_approaching"].includes(p.trigger)) throw new Error("invalid-policy");
  if (p.executionMode != null && !["native", "profile-managed"].includes(p.executionMode)) throw new Error("invalid-execution-mode");
  if (p.executionMode === "profile-managed" && p.maxTurns !== 1) throw new Error("managed-single-turn-required");
  for (const [key, min, max] of [
    ["reservePercent", 0, 99], ["maxTurns", 1, 100], ["maxUsagePercent", 1, 100],
    ["resetWithinMinutes", 1, 1440], ["priority", 0, 100],
  ] as const) {
    if (!Number.isFinite(p[key]) || p[key] < min || p[key] > max || !Number.isInteger(p[key]))
      throw new Error("invalid-policy-" + key);
  }
  if (!Number.isFinite(p.expiresAtMs) || p.expiresAtMs <= Date.now() ||
      p.expiresAtMs > Date.now() + 7 * 86400000) throw new Error("invalid-policy-expiry");
  for (const key of ["requiredBucket", "resetBucket"] as const) {
    if (p[key] != null && (typeof p[key] !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(p[key]!)))
      throw new Error("invalid-policy-bucket");
  }
  if (p.trigger === "quota.reset_approaching" && !p.resetBucket) throw new Error("reset-bucket-required");
  if (p.resetBucket && !p.resetBucket.startsWith("codex:")) throw new Error("general-reset-bucket-required");
  const profile = config.accounts.codex.find(a => a.id === p.account && a.enabled);
  const profileKey = resumeProfileKey(config, "codex", p.account);
  if (!profile || !profileKey) throw new Error("account-unavailable");
  // Prove this thread belongs to the selected local profile using only its
  // session metadata header. Never copy a conversation into the bridge.
  const root = realpathSync(codexProfileRoot(profile));
  const matches = new Glob("**/*" + p.threadId + "*.jsonl").scanSync({ cwd: join(root, "sessions"), onlyFiles: true, followSymlinks: false });
  let found = false, inspected = 0;
  for (const relative of matches) {
    if (++inspected > 100) break;
    const path = realpathSync(join(root, "sessions", relative));
    if (!path.startsWith(root + "/sessions/")) continue;
    const fd = openSync(path, "r"); const bytes = Buffer.alloc(65536);
    try {
      const n = readSync(fd, bytes, 0, bytes.length, 0), end = bytes.subarray(0, n).indexOf(10);
      if (end < 0) continue;
      const first = JSON.parse(bytes.subarray(0, end).toString("utf8"));
      if (first.type === "session_meta" && first.payload?.id === p.threadId) { found = true; break; }
    } finally { closeSync(fd); }
  }
  if (!found) throw new Error("thread-profile-unverified");
  return { ...p, enabled: false, profileKey, accountKey: "" };
}

export function gateAllows(policy: DotPolicy, gate: ResumeGate, now: number): boolean {
  if (gate.schemaVersion !== 1 || gate.provider !== "codex" || gate.account !== policy.account ||
      gate.profileKey !== policy.profileKey || !policy.accountKey || gate.accountKey !== policy.accountKey ||
      gate.ready !== true || gate.reason !== "ready" ||
      !Number.isFinite(gate.checkedAtMs) || gate.checkedAtMs > now || now - gate.checkedAtMs > 120000 ||
      !Array.isArray(gate.windows) || !gate.windows.length) return false;
  const required = [policy.requiredBucket, policy.resetBucket].filter(Boolean);
  if (!gate.windows.some(w => w.bucket.startsWith("codex:")) ||
      required.some(bucket => !gate.windows.some(w => w.bucket === bucket))) return false;
  return gate.windows.every(w => Number.isFinite(w.remainingPercent) && w.remainingPercent! <= 100 &&
    Number.isFinite(w.reservePercent) && w.reservePercent >= 0 && w.reservePercent <= 100 &&
    w.remainingPercent! > Math.max(policy.reservePercent, w.reservePercent) &&
    Number.isFinite(w.observedAtMs) && w.observedAtMs <= now && now - w.observedAtMs <= 120000 &&
    Number.isFinite(w.resetsAtMs) && w.resetsAtMs! > now);
}

export function eligible(state: TargetState, gate: ResumeGate, now: number): boolean {
  const p = state.policy;
  if (!p.enabled || p.expiresAtMs <= now || state.claimed || state.turns >= p.maxTurns ||
      state.spent >= p.maxUsagePercent || !gateAllows(p, gate, now)) return false;
  if (p.trigger === "quota.reset_approaching") {
    const window = gate.windows.find(w => w.bucket === p.resetBucket);
    return !!window && window.resetsAtMs! - now <= p.resetWithinMinutes * 60000;
  }
  return true;
}

export async function readGate(config: AppConfig, policy: DotPolicy): Promise<ResumeGate> {
  const host = config.dashboard.host.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("collector-not-local");
  if (resumeProfileKey(config, "codex", policy.account) !== policy.profileKey) throw new Error("profile-mismatch");
  const url = new URL("http://" + (host === "::1" ? "[::1]" : host) + ":" + config.dashboard.port + "/api/resume-check");
  url.searchParams.set("provider", "codex"); url.searchParams.set("account", policy.account);
  if (policy.requiredBucket) url.searchParams.set("bucket", policy.requiredBucket);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("collector-unavailable");
  return await response.json() as ResumeGate;
}
