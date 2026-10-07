import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexProfileRoot, type AppConfig } from "./config";
import { CodexAppServerClient } from "./providers/codex-appserver";

export const dockIcons = ["app-default", "codex-system", "space-system"] as const;
export type DockIcon = typeof dockIcons[number];
export function readDockIcon(home: string): DockIcon {
  let text: string;
  try { text = readFileSync(join(home, "config.toml"), "utf8"); }
  catch (error: any) { if (error.code === "ENOENT") return "app-default"; throw error; }
  const config = Bun.TOML.parse(text) as any;
  const value = config.desktop?.["dock-icon-preference"] ?? "app-default";
  if (value === "codex-light" || value === "codex-dark") return "codex-system";
  if (!dockIcons.includes(value)) throw new Error("unsupported_icon");
  return value;
}

/** Resolve registered account identity; clients cannot supply arbitrary file paths. */
export async function profileDockIcon(config: AppConfig, input: unknown,
  createClient = (home: string) => new CodexAppServerClient(config.collection.codexCommand, "dock-icon", 8000, home)) {
  if (!input || typeof input !== "object") throw new Error("invalid_icon");
  const { account, icon } = input as { account?: unknown; icon?: unknown };
  if (typeof account !== "string" || (icon !== undefined && !dockIcons.includes(icon as DockIcon))) throw new Error("invalid_icon");
  const profile = config.accounts.codex.find(p => p.id === account && p.enabled);
  if (!profile) throw new Error("account_not_found");
  const home = codexProfileRoot(profile);
  const previous = readDockIcon(home);
  if (icon !== undefined && icon !== previous) {
    const client = createClient(home);
    try { await client.writeDockIcon(icon as DockIcon); }
    finally { await client.close(); }
  }
  const persisted = readDockIcon(home);
  if (icon !== undefined && persisted !== icon) throw new Error("icon_write_unverified");
  return { icon: persisted, changed: icon !== undefined && previous !== icon };
}
