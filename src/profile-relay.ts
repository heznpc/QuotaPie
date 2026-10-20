import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { codexSessionLocation, SessionLocationUnavailableError, type SessionLocationOptions } from "./session-location";

type Runner = (home: string) => Promise<boolean>;
/** Extend an already enabled relay to a registered profile. Quota-only installs stay quota-only. */
export async function connectProfileRelay(home: string, root = join(homedir(), ".local/lib/quotapie-compaction"),
  runner: Runner = async home => {
    const process = Bun.spawn([join(homedir(), ".local/bin/quotapie-compaction"), "ensure-profile", "--codex-home", home],
      { stdout: "pipe", stderr: "ignore" });
    // The manager performs an atomic install under its own lock. Do not kill it
    // at a client timeout, which could abandon a half-installed generation.
    const output = await new Response(process.stdout).text();
    if (await process.exited !== 0) throw new Error("profile_relay_failed");
    return JSON.parse(output).relayConnected === true;
  }): Promise<boolean> {
  try { await access(join(root, "current.json")); }
  catch { return false; }
  try { return await runner(home); }
  catch { throw new Error("profile_relay_failed"); }
}

/** Credential registration remains on the requested account. Only its verified
 * physical conversation owner is allowed to configure a work relay. */
export async function connectAccountSessionRelay(config: AppConfig, account: string, options: {
  root?: string; runner?: Runner; sessionLocation?: SessionLocationOptions;
} = {}): Promise<{ relayConnected: boolean; sessionOwner: string; sessionConsolidated: boolean }> {
  const location = () => {
    try {
      const value = codexSessionLocation(config, account, undefined, options.sessionLocation);
      if (!value) throw new SessionLocationUnavailableError();
      return value;
    } catch { throw new Error("session_location_unavailable"); }
  };
  const before = location();
  const relayConnected = await connectProfileRelay(before.sessionRoot, options.root, options.runner);
  const after = location();
  if (before.ownerAccount !== after.ownerAccount || before.sessionRoot !== after.sessionRoot ||
      before.credentialRoot !== after.credentialRoot || before.manifestSHA256 !== after.manifestSHA256)
    throw new Error("session_location_unavailable");
  return { relayConnected, sessionOwner: before.ownerAccount, sessionConsolidated: before.consolidated };
}
