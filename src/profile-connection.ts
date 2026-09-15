import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configPath, loadConfig, codexProfileRoot, codexUsesFileCredentials, type AppConfig } from './config';

/** Add only: existing aliases, credentials and manual settings remain owned by their user. */
export function connectCodexProfile(config: AppConfig, input: unknown, path = configPath()) {
  if (!input || typeof input !== 'object') throw new Error('invalid_profile');
  const { name, codexHome } = input as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name) ||
      typeof codexHome !== 'string' || !codexHome.startsWith('/') || codexHome.length > 4096) throw new Error('invalid_profile');
  const root = realpathSync(codexHome);
  if (!statSync(root).isDirectory()) throw new Error('profile_missing');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const disk = loadConfig(path);
  if (JSON.stringify(disk.accounts.codex) !== JSON.stringify(config.accounts.codex)) throw new Error('settings_changed');
  const canonical = (p: Parameters<typeof codexProfileRoot>[0]) => {
    const root = codexProfileRoot(p);
    return existsSync(root) ? realpathSync(root) : root;
  };
  const existing = disk.accounts.codex.find(p => canonical(p) === root);
  if (existing) {
    if (!existing.enabled) throw new Error('account_disabled');
    return { account: existing.id, registered: true };
  }
  const profile = { id: randomUUID().replaceAll('-', ''), label: name.trim(), codexHome: root, enabled: true };
  const enabled = [...disk.accounts.codex.filter(p => p.enabled), profile];
  if (!enabled.every(codexUsesFileCredentials)) throw new Error('isolation_required');
  if (disk.accounts.codex.some(p => canonical(p).startsWith(root + '/') || root.startsWith(canonical(p) + '/'))) throw new Error('profile_overlap');
  const raw = before === null ? {} : JSON.parse(before);
  const next = [...disk.accounts.codex, profile];
  const content = JSON.stringify({ ...raw, accounts: { ...raw.accounts, codex: next } }, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    loadConfig(temporary);
    if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== before) throw new Error('settings_changed');
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  config.accounts.codex = next;
  return { account: profile.id, registered: true };
}
