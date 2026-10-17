import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexProfileRoot, type AppConfig } from "../config";
import type { DotPolicy } from "./store";
import type { ContinuationPreflight } from "./bridge";
import { readConfiguredThread } from "./thread-reader";
import { prepareManagedContinuation } from "./managed-continuation";

/** Inspect only the registered loopback endpoint. Neither health nor a stored
 * thread read proves that the native desktop owner will use this generation. */
export async function readContinuationPreflight(config: AppConfig, policy: DotPolicy,
  purpose: "status" | "claim" | "event" = "status"): Promise<ContinuationPreflight> {
  if (purpose !== "status" && policy.executionMode !== "profile-managed") return { ready: false, reason: "execution-host-unverified" };
  let thread;
  try { thread = await readConfiguredThread(config, policy); }
  catch { return { ready: false, reason: "thread-profile-unverified" }; }
  try {
    const profile = config.accounts.codex.find(p => p.enabled && p.id === policy.account);
    if (!profile) return { ready: false, reason: "profile-unavailable", thread };
    const root = realpathSync(codexProfileRoot(profile));
    const manifest = JSON.parse(readFileSync(join(homedir(), ".local/lib/quotapie-compaction/current.json"), "utf8"));
    const settingsPath = manifest.profile_settings?.[root] ?? manifest.settings_path;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (realpathSync(settings.codex_home) !== root || !Number.isInteger(settings.port) ||
        settings.port < 1024 || settings.port > 65535 || !/^[a-f0-9]{48}$/.test(settings.token))
      return { ready: false, reason: "profile-relay-unverified", thread };
    const endpoint = `http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex`;
    const source = readFileSync(join(root, "config.toml"), "utf8");
    // The managed block is emitted at the beginning by the relay installer.
    const configured = source.match(/^# BEGIN QuotaPie compaction relay\nopenai_base_url = ("[^\n]+")\n# END QuotaPie compaction relay\n/);
    if (!configured || JSON.parse(configured[1]!) !== endpoint)
      return { ready: false, reason: "profile-relay-not-configured", thread };
    const response = await fetch(endpoint + "/quotapie-health", { redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("relay-unavailable");
    const health: any = await response.json(), guard = health.subscriptionGuard;
    if (health.service !== "quotapie-compaction" || health.subscriptionGuardVersion !== 1 ||
        guard?.version !== 1 || guard.account !== policy.account || guard.profileKey !== policy.profileKey)
      return { ready: false, reason: "subscription-guard-unverified", thread };
    const relay = { guarded: true, accountMatched: true, profileMatched: true, ready: guard.ready === true,
      reason: guard.reason, windows: guard.windows, exactConsumptionCap: false,
      nativeOwnerRouteVerified: false };
    if (!guard.ready) return { ready: false, reason: "subscription-guard-hold", thread, relay };
    if (policy.executionMode === "profile-managed") {
      const managed = await prepareManagedContinuation(config, policy, { threadStatus: thread });
      return { ready: managed.ready, reason: managed.reason, thread,
        relay: { ...relay, managedRouteFixed: true }, managed: { ...managed } };
    }
    if (!Array.isArray(guard.windows) || !guard.windows.length || guard.windows.some((w: any) =>
      !Number.isFinite(w.reservePercent) || w.reservePercent < policy.reservePercent))
      return { ready: false, reason: "relay-policy-reserve-unverified", thread, relay };
    // The connected Dot and the original desktop may belong to different
    // accounts. Never turn a successful profile read into permission to send
    // through an unverified default host or a new CLI execution process.
    return { ready: false, reason: "execution-host-unverified", thread, relay };
  } catch { return { ready: false, reason: "profile-relay-unavailable", thread }; }
}
