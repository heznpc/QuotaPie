import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
