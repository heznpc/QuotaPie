import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { connectCodexProfile } from '../src/profile-connection';

function fixture(run: (root: string, path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'qp-connect-'));
  try {
    for (const name of ['one', 'two']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    }
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ accounts: { codex: [{ id: 'main', label: 'Main', codexHome: join(root, 'one'), enabled: true }] }, custom: { keep: true } }));
    run(root, path);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('connection persists, updates live config, preserves settings, and is idempotent across aliases', () => fixture((root, path) => {
  const config = loadConfig(path);
  const input = { name: 'Second', codexHome: join(root, 'two') };
  const first = connectCodexProfile(config, input, path);
  symlinkSync(join(root, 'two'), join(root, 'alias'));
  expect(connectCodexProfile(config, { ...input, codexHome: join(root, 'alias') }, path)).toEqual(first);
  expect(config.accounts.codex).toEqual(loadConfig(path).accounts.codex);
  expect(config.accounts.codex).toHaveLength(2);
  expect(JSON.parse(readFileSync(path, 'utf8')).custom).toEqual({ keep: true });
}));

test('unsafe isolation and changed settings do not alter disk or live registrations', () => fixture((root, path) => {
  const config = loadConfig(path), original = readFileSync(path, 'utf8');
  writeFileSync(join(root, 'one', 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  expect(() => connectCodexProfile(config, { name: 'Second', codexHome: join(root, 'two') }, path)).toThrow('isolation_required');
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(config.accounts.codex).toHaveLength(1);
  const changed = JSON.parse(original); changed.accounts.codex[0].label = 'Manual';
  writeFileSync(path, JSON.stringify(changed));
  expect(() => connectCodexProfile(config, { name: 'Second', codexHome: join(root, 'two') }, path)).toThrow('settings_changed');
  expect(loadConfig(path).accounts.codex[0]!.label).toBe('Manual');
}));

test('disabled account is not silently reenabled', () => fixture((root, path) => {
  const raw = JSON.parse(readFileSync(path, 'utf8')); raw.accounts.codex[0].enabled = false;
  writeFileSync(path, JSON.stringify(raw));
  const config = loadConfig(path);
  expect(() => connectCodexProfile(config, { name: 'Main', codexHome: join(root, 'one') }, path)).toThrow('account_disabled');
  expect(config.accounts.codex[0]!.enabled).toBe(false);
}));

test('local connection endpoint requires action token and rejects browser origins', async () => {
  const { startDashboard } = await import('../src/server');
  const { QuotaPieService } = await import('../src/service');
  const { QuotaDatabase } = await import('../src/db');
  const root = mkdtempSync(join(tmpdir(), 'qp-connect-api-'));
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ accounts: { codex: [] }, collection: { codexEnabled: false } }));
  const config = loadConfig(path); config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(':memory:'));
  const server = startDashboard(service, config, { preferencesPath: path, compactionRoot: root });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const status: any = await (await fetch(base + '/api/status')).json();
    const post = (headers: Record<string,string>, body: unknown) => fetch(base + '/api/profiles/connect', { method: 'POST', headers, body: JSON.stringify(body) });
    const input = { name: 'Test', codexHome: root };
    expect((await post({}, input)).status).toBe(403);
    expect((await post({ 'x-quotapie-action-token': status.actionToken, origin: 'https://example.com' }, input)).status).toBe(403);
    writeFileSync(join(root, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
    expect((await post({ 'x-quotapie-action-token': status.actionToken }, input)).status).toBe(200);
    const after: any = await (await fetch(base + '/api/status')).json();
    expect(after.accounts.some((a: any) => a.accountLabel === 'Test')).toBe(true);
    expect(loadConfig(path).accounts.codex).toHaveLength(1);
  } finally { server.stop(true); await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('default file credentials connect without modifying Codex config', () => fixture((root, path) => {
  const file = join(root, 'one', 'config.toml');
  const original = 'model = "existing-model"\n';
  writeFileSync(file, original);
  const config = loadConfig(path);
  connectCodexProfile(config, { name: 'Second', codexHome: join(root, 'two') }, path);
  expect(config.accounts.codex).toHaveLength(2);
  expect(readFileSync(file, 'utf8')).toBe(original);
}));
