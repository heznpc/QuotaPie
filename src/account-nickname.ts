import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { configPath, loadConfig, type AppConfig } from "./config";

export function saveAccountNickname(config: AppConfig, input: unknown, path = configPath()) {
  if (!input || typeof input !== "object") throw new Error("invalid_nickname");
  const { provider, account, nickname } = input as Record<string, unknown>;
  if ((provider !== "codex" && provider !== "claude") || typeof account !== "string" ||
      typeof nickname !== "string" || nickname.length > 80 || /[\x00-\x1f\x7f]/.test(nickname)) throw new Error("invalid_nickname");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const disk = loadConfig(path);
  if (JSON.stringify(disk.accounts[provider]) !== JSON.stringify(config.accounts[provider])) throw new Error("settings_changed");
  if (!disk.accounts[provider].some(profile => profile.id === account)) throw new Error("account_not_found");
  const next = disk.accounts[provider].map(profile => profile.id === account ? { ...profile, nickname: nickname.trim() } : profile);
  const raw = before == null ? {} : JSON.parse(before);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), "." + randomUUID() + ".tmp");
  try {
    writeFileSync(temporary, JSON.stringify({ ...raw, accounts: { ...raw.accounts, [provider]: next } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    loadConfig(temporary);
    if ((existsSync(path) ? readFileSync(path, "utf8") : null) !== before) throw new Error("settings_changed");
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  // Each provider retains its own paths and IDs. Only presentation changes.
  if (provider === "codex") config.accounts.codex = next as AppConfig["accounts"]["codex"];
  else config.accounts.claude = next as AppConfig["accounts"]["claude"];
  return { provider, account, nickname: nickname.trim() };
}
