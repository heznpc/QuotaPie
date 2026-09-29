import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'packages/quota-core/package.json'))).version;
const name = `heznpc-quota-core-${version}.tgz`;
const artifact = join(root, 'dist/quota-core', name);
const bytes = readFileSync(artifact);
const checksum = createHash('sha256').update(bytes).digest('hex');
assert.equal(readFileSync(artifact + '.sha256', 'utf8').split(' ')[0], checksum);
// A second clean build must produce the exact bytes, not only equivalent code.
execFileSync('python3', ['script/pack-quota-core.py'], { cwd: root, stdio: 'inherit' });
assert.deepEqual(readFileSync(artifact), bytes);
const stage = mkdtempSync(join(tmpdir(), 'quota-core-consumer-'));
try {
  mkdirSync(join(stage, 'vendor'));
  copyFileSync(artifact, join(stage, 'vendor', name));
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@heznpc/quota-core': `file:vendor/${name}` } }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(stage, 'cache')], { cwd: stage, stdio: 'inherit' });
  copyFileSync(join(root, 'script/quota-core-consumer.mjs'), join(stage, 'consumer.mjs'));
  for (const runtime of ['node', 'bun']) execFileSync(runtime, ['consumer.mjs'], { cwd: stage, stdio: 'inherit' });
  console.log(JSON.stringify({ reproducible: true, sha256: checksum, absolutePathDependency: false }));
} finally { rmSync(stage, { recursive: true, force: true }); }
