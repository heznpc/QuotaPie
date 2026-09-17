import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";

interface RelaySettingsEntry {
  path: string;
  raw: string;
  settings: Record<string, any>;
  current: boolean;
}

/** Current/profile settings are required; unreadable retired generations are optional. */
export async function inspectRelaySettings<T>(root: string, inspect: (entry: RelaySettingsEntry) => Promise<T>): Promise<T[]> {
  const realRoot = await realpath(root);
  const manifest = JSON.parse(await readFile(join(realRoot, "current.json"), "utf8"));
  const active = [...new Set<unknown>([manifest.settings_path, ...Object.values(manifest.profile_settings ?? {})])];
  const retired = Array.isArray(manifest.retired_settings) ? manifest.retired_settings : [];
  const paths = [...active, ...new Set<unknown>(retired.filter((path: unknown) => !active.includes(path)))];
  const results: Array<T | undefined> = new Array(paths.length);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const index = next++;
      const path = paths[index];
      try {
        if (typeof path !== "string") throw new Error("invalid_installation");
        const suffix = relative(resolve(root), resolve(path));
        if (!/^(?:settings\.json|releases\/\d+\/settings\.json)$/.test(suffix) ||
            await realpath(path) !== join(realRoot, suffix)) throw new Error("invalid_installation");
        const raw = await readFile(path, "utf8");
        const settings = JSON.parse(raw);
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("invalid_installation");
        results[index] = await inspect({ path, raw, settings, current: index === 0 });
      } catch (error) {
        if (index < active.length) throw error;
        // Missing/corrupt historical files must not disable the active installation.
      }
    }
  }
  // Bound simultaneous file/health reads, rather than rejecting an older installation.
  await Promise.all(Array.from({ length: Math.min(32, paths.length) }, worker));
  return results.filter((entry): entry is T => entry !== undefined);
}

const LOCK_SCRIPT = `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print("locked", flush=True)
sys.stdin.buffer.read()
`;

/** Share the manager's flock across both policy writers and other daemon processes.
 * The pipe releases it on exit/crash too; the persistent lock file must never be unlinked.
 */
export async function withRelaySettingsLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const path = join(await realpath(root), "management.lock");
  const child = Bun.spawn(["python3", "-c", LOCK_SCRIPT, path], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
  try {
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("policy_busy");
      line += new TextDecoder().decode(value);
    }
    if (line !== "locked\n") throw new Error("policy_busy");
    clearTimeout(timer);
    return await operation();
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await child.exited;
    reader.releaseLock();
  }
}

/** Call only while holding management.lock, including during rollback. */
export async function replaceRelaySettings(path: string, expected: string, content: string): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    if (await readFile(path, "utf8") !== expected) throw new Error("settings_changed");
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
