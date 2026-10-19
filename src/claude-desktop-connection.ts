import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { configPath, loadConfig, type AppConfig, type ClaudeAccountConfig } from "./config";
import { sameClaudeDesktopIdentity, type ClaudeDesktopIdentity } from "./providers/claude-desktop";

/** A desktop connection gets its own account. Email/name equality cannot prove
 * that a Claude Code profile belongs to this app session. */
export function saveClaudeDesktopConnection(config: AppConfig, identity: ClaudeDesktopIdentity, path = configPath()): ClaudeAccountConfig {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const disk = loadConfig(path);
  if (JSON.stringify(disk.accounts.claude) !== JSON.stringify(config.accounts.claude)) throw new Error("settings_changed");
  const binding = { accountId: identity.accountId.toLowerCase(), organizationId: identity.organizationId.toLowerCase() };
  const existing = disk.accounts.claude.find(profile => profile.desktopBinding && sameClaudeDesktopIdentity(profile.desktopBinding, binding));
  const id = existing?.id ?? `desktop-${createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 16)}`;
  if (!existing && disk.accounts.claude.some(profile => profile.id === id)) throw new Error("desktop_account_collision");
  const profile: ClaudeAccountConfig = existing ? { ...existing, enabled: true } : {
    id, label: "Claude Desktop", configDir: `~/.config/quotapie/desktop-accounts/${id}`,
    enabled: true, keychainService: null, desktopBinding: binding,
  };
  const next = existing ? disk.accounts.claude.map(item => item.id === id ? profile : item) : [...disk.accounts.claude, profile];
  const raw = before == null ? {} : JSON.parse(before);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ ...raw, accounts: { ...raw.accounts, claude: next } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    loadConfig(temporary);
    if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== before) throw new Error("settings_changed");
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  config.accounts.claude = next;
  return profile;
}
