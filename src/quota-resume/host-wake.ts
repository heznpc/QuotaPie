import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexProfileRoot, type AppConfig } from "../config";
import { metadataPath } from "../dots/thread-reader";

export interface HostWakeResult { status: "sent" | "unavailable"; reason?: string }
export interface HostWakeRequest {
  config: AppConfig; account: string; threadId: string; stillAuthorized?: () => boolean;
  /** Revalidate that only this already-acknowledged queue row remains. */
  beforeSend?: () => Promise<void>;
}
interface HelperRequest { account: string; codexHome: string; threadId: string }
interface WakeChild {
  stdin: { write(value: string): unknown; flush(): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>; kill(): unknown;
}
export interface HostWakeDependencies {
  platform?: string;
  launch?: () => WakeChild;
  timeoutMs?: number;
  repairProvider?: (input: HelperRequest, signal: AbortSignal) => Promise<boolean>;
}
const unavailable = (reason: string): HostWakeResult => ({ status: "unavailable", reason });
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const helper = fileURLToPath(new URL("../../script/codex-host-wake.py", import.meta.url));
const manager = fileURLToPath(new URL("../../scripts/codex-compaction-local.py", import.meta.url));

function needsProviderRepair(input: HelperRequest): boolean {
  const rollout = metadataPath(input.codexHome, input.threadId);
  const filename = readdirSync(input.codexHome).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0];
  if (!filename) throw new Error("thread-profile-unverified");
  const database = realpathSync(join(input.codexHome, filename));
  if (!database.startsWith(input.codexHome + "/")) throw new Error("thread-profile-unverified");
  const db = new Database(database, { readonly: true, strict: true });
  try {
    const row = db.query<{ model_provider: string; rollout_path: string }, [string]>(
      "SELECT model_provider,rollout_path FROM threads WHERE id=?").get(input.threadId);
    if (!row || typeof row.model_provider !== "string" || realpathSync(row.rollout_path) !== rollout)
      throw new Error("thread-profile-unverified");
    return row.model_provider === "quotapie_compaction";
  } finally { db.close(); }
}

export function legacyProviderRepairCommand(wrapper: string, input: Pick<HelperRequest, "codexHome" | "threadId">): string[] {
  // Use the installation's already selected Python (tomllib requires 3.11+),
  // but execute this collector generation's manager, never a stale manage.py.
  const match = /^#!\/bin\/sh\nexec '([^'\n]+)' '([^'\n]+)' "\$@"\n$/.exec(wrapper);
  if (!match || !match[1]!.startsWith("/") || !/\/python3(?:\.\d+)?$/.test(match[1]!)
      || match[2] !== join(homedir(), ".local/lib/quotapie-compaction/manage.py")) throw new Error();
  accessSync(match[1]!, constants.X_OK);
  return [realpathSync(match[1]!), "-B", manager, "repair-legacy-provider",
    "--codex-home", input.codexHome, "--thread-id", input.threadId];
}

async function repairProvider(input: HelperRequest, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (!needsProviderRepair(input)) return true;
  const wrapper = join(homedir(), ".local/bin/quotapie-compaction");
  if (!lstatSync(wrapper).isFile() || lstatSync(wrapper).isSymbolicLink()) return false;
  const child = Bun.spawn(legacyProviderRepairCommand(readFileSync(wrapper, "utf8"), input),
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const stop = () => { try { child.kill(); } catch {} };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 8000);
  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      if (output.length > 4096) return false;
    }
    if (signal.aborted || await child.exited !== 0) return false;
    const result = JSON.parse(output);
    return result?.status === "ready" && typeof result.changed === "boolean"
      || result?.status === "not-needed" && result.changed === false;
  } catch { return false; }
  finally {
    clearTimeout(timer); signal.removeEventListener("abort", stop); stop();
    await child.exited.catch(() => {});
  }
}

/** Only wake the existing, profile-bound desktop process after a durable queue
 * receipt. `sent` means OS event delivery, never queue acceptance or execution.
 * There is no generic URL opener, app launch, turn start, or send retry here. */
export async function wakeHostQueuedThread(request: HostWakeRequest, deps: HostWakeDependencies = {}): Promise<HostWakeResult> {
  if ((deps.platform ?? process.platform) !== "darwin") return unavailable("host-wake-platform-unavailable");
  if (!UUID.test(request.threadId)) return unavailable("host-wake-thread-invalid");
  const binding = (): HelperRequest => {
    const profiles = request.config.accounts.codex.filter(p => p.enabled && p.id === request.account);
    if (profiles.length !== 1) throw new Error();
    return { account: request.account, codexHome: realpathSync(codexProfileRoot(profiles[0]!)), threadId: request.threadId };
  };
  let input: HelperRequest;
  try { input = binding(); } catch { return unavailable("host-wake-profile-unavailable"); }
  const authorized = () => {
    try { return request.stillAuthorized?.() !== false && JSON.stringify(binding()) === JSON.stringify(input); }
    catch { return false; }
  };
  if (!authorized()) return unavailable("host-wake-authorization-changed");
  const abort = new AbortController();
  let child: WakeChild | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = deps.launch?.() ?? Bun.spawn(["/usr/bin/python3", "-B", "-u", helper], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" },
    });
    const current = child;
    const exchange = async (): Promise<HostWakeResult> => {
      current.stdin.write(JSON.stringify(input) + "\n"); current.stdin.flush();
      let buffer = "", total = 0, ready = false;
      const decoder = new TextDecoder();
      for await (const chunk of current.stdout) {
        total += chunk.byteLength;
        if (total > 4096) throw new Error();
        buffer += decoder.decode(chunk, { stream: true });
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const raw = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
          if (raw.status === "ready" && !ready) {
            ready = true;
            try { await request.beforeSend?.(); }
            catch { current.stdin.end(); return unavailable("host-wake-queue-changed"); }
            if (abort.signal.aborted || !authorized()) { current.stdin.end(); return unavailable("host-wake-authorization-changed"); }
            // Only a verified historical provider alias may be restored. The
            // manager never selects it globally or edits the thread database.
            let providerReady = false;
            try { providerReady = await (deps.repairProvider ?? repairProvider)(input, abort.signal); } catch { /* Fail closed. */ }
            if (!providerReady) {
              current.stdin.end(); return unavailable("host-wake-provider-unavailable");
            }
            try { await request.beforeSend?.(); }
            catch { current.stdin.end(); return unavailable("host-wake-queue-changed"); }
            // The helper has already resolved the exact owner. Recheck consent
            // after those potentially slow OS reads, before authorizing send.
            if (abort.signal.aborted || !authorized()) { current.stdin.end(); return unavailable("host-wake-authorization-changed"); }
            current.stdin.write("send\n"); current.stdin.flush(); current.stdin.end();
          } else if (raw.status === "sent" && ready) return { status: "sent" };
          else if (raw.status === "unavailable" && typeof raw.reason === "string" && /^host-wake-[a-z-]{1,60}$/.test(raw.reason))
            return unavailable(raw.reason);
          else throw new Error();
        }
      }
      return unavailable("host-wake-helper-unavailable");
    };
    return await Promise.race([exchange(), new Promise<HostWakeResult>(resolve => {
      timer = setTimeout(() => { abort.abort(); current.kill(); resolve(unavailable("host-wake-timeout")); }, deps.timeoutMs ?? 45_000);
    })]);
  } catch { return unavailable("host-wake-helper-unavailable"); }
  finally {
    abort.abort();
    if (timer) clearTimeout(timer);
    // Only this short-lived helper is owned here, never the desktop process.
    if (child) {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      await child.exited.catch(() => {});
    }
  }
}
