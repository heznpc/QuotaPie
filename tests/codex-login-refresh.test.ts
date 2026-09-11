import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/providers/codex-appserver";

test("a resident collector reloads changed login state and isolates its new rate baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-login-test-"));
  const auth = join(dir, "auth.json");
  const binary = join(dir, "fake-codex");
  writeFileSync(auth, JSON.stringify({ used: 10 }));
  writeFileSync(binary, `#!${process.execPath}
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const used = JSON.parse(readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8')).used;
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  const result = request.method === 'initialize' ? {} : {
    rateLimits: {limitId:'codex', primary:{usedPercent:used,windowDurationMins:10080,resetsAt:2000000000}}
  };
  console.log(JSON.stringify({id:request.id,result}));
}
`, { mode: 0o700 });
  const client = new CodexAppServerClient(binary, "default", 2000, dir);
  try {
    const first = await client.readRateLimits();
    const same = await client.readRateLimits();
    expect(first[0]?.usedPercent).toBe(10);
    expect(first[0]?.metadata?.collectorEpoch).toBe(same[0]?.metadata?.collectorEpoch);
    writeFileSync(auth, JSON.stringify({ used: 75 }));
    utimesSync(auth, new Date(), new Date(Date.now() + 2000));
    const changed = await client.readRateLimits();
    expect(changed[0]?.usedPercent).toBe(75);
    expect(changed[0]?.metadata?.collectorEpoch).not.toBe(first[0]?.metadata?.collectorEpoch);
    expect(JSON.stringify(changed)).not.toContain('accountId');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
