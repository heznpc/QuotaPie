import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config";
import { resolveUserPath } from "./config";

const EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "PermissionRequest"];
const root = resolve(import.meta.dir, "..");
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const marker = "quotapie-awake-hook.py";

type Handler = { type?: string; command?: string; [key: string]: unknown };
type Group = { hooks?: Handler[]; [key: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [key: string]: unknown };

export function mergedAwakeHooks(settings: Settings, provider: "codex" | "claude", command: string, install: boolean): Settings {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid agent settings");
  if (settings.hooks != null && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) throw new Error("Invalid agent hooks");
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid hooks for ${event}`);
    hooks[event] = groups.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter(
      (handler) => !(handler.type === "command" && handler.command?.includes(marker)),
    ) })).filter((group) => group.hooks.length > 0);
  }
  if (install) {
    for (const event of [...EVENTS, ...(provider === "codex" ? ["Interrupt", "PostCompact"] : ["StopFailure"])]) {
      hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command, timeout: 3 }] }];
    }
  }
  return { ...settings, hooks };
}

export function configureAwakeHooks(config: AppConfig, install: boolean): string[] {
  const directory = resolve(homedir(), "Library/Application Support/QuotaPie/hooks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bridge = resolve(directory, marker);
  if (install) {
    const content = readFileSync(resolve(root, "script/awake_hook.py"));
    writeFileSync(bridge, content, { mode: 0o600 });
  }
  const profiles = [
    ...config.accounts.codex.filter(p => p.enabled).map(p => ({
      provider: "codex" as const, path: resolve(resolveUserPath(p.codexHome ?? "~/.codex"), "hooks.json"),
    })),
    ...config.accounts.claude.filter(p => p.enabled).map(p => ({
      provider: "claude" as const, path: resolve(resolveUserPath(p.configDir), "settings.json"),
    })),
  ];
  const changed: string[] = [];
  for (const { provider, path } of profiles) {
    if (changed.includes(path)) continue;
    const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Settings : {};
    const command = `/usr/bin/python3 ${quote(bridge)} ${provider} ${quote(dirname(path))}`;
    const updated = mergedAwakeHooks(settings, provider, command, install);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) copyFileSync(path, `${path}.quotapie-backup-${Date.now()}-${randomUUID()}`);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, path);
    changed.push(path);
  }
  return changed;
}

export async function releaseAwakeTask(provider: "codex" | "claude", profileRoot: string, session: string): Promise<void> {
  const proc = Bun.spawn(["/usr/bin/python3", resolve(root, "script/awake_hook.py"), provider, profileRoot], {
    stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  proc.stdin.write(JSON.stringify({ session_id: session, hook_event_name: "QuotaPause" }));
  proc.stdin.end();
  await proc.exited;
}
