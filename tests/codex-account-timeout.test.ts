import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexContextChange } from "../src/domain/codex-context";
import { CodexAppServerClient } from "../src/providers/codex-appserver";

function fixture(alwaysSilent = false) {
  const directory = mkdtempSync(join(tmpdir(), "quotapie-account-timeout-"));
  const binary = join(directory, "fake-codex");
  const state = join(directory, "remote.json");
  writeFileSync(join(directory, "auth.json"), "{}");
  writeFileSync(state, JSON.stringify({ plan: "plus", used: 90 }));
  writeFileSync(binary, `#!/usr/bin/python3
import json, os, sys
home = os.environ['CODEX_HOME']
pids = home + '/pids'
generation = len(open(pids).readlines()) if os.path.exists(pids) else 0
with open(pids, 'a') as file: file.write(str(os.getpid()) + '\\n')
account_reads = 0
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    remote = json.load(open(home + '/remote.json'))
    result = {}
    if request['method'] == 'account/read':
        account_reads += 1
        if ${alwaysSilent ? "True" : "False"} or (generation == 0 and account_reads >= 3): continue
        result = {'account': {'type': 'chatgpt', 'email': 'synthetic@example.invalid', 'planType': remote['plan']}}
    if request['method'] == 'account/rateLimits/read':
        result = {'rateLimits': {'limitId': 'codex', 'planType': remote['plan'], 'primary':
            {'usedPercent': remote['used'], 'windowDurationMins': 300, 'resetsAt': 2000000000}}}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
`, { mode: 0o700 });
  return {
    directory,
    state,
    client: new CodexAppServerClient(binary, "default", 500, directory),
    pids: () => readFileSync(join(directory, "pids"), "utf8").trim().split("\n").map(Number),
  };
}

test("account lookup timeout restarts the child and retains the last trusted context", async () => {
  const { directory, state, client, pids } = fixture();
  try {
    const before = (await client.readRateLimits())[0]!;
    writeFileSync(state, JSON.stringify({ plan: "pro", used: 5 }));
    const after = (await client.readRateLimits())[0]!;
    expect(after.usedPercent).toBe(5);
    expect(codexContextChange(before, after)).toBe("plan_changed");
    expect(after.metadata?.accountContext).toBe(before.metadata?.accountContext);
    expect(pids()).toHaveLength(2);
    expect(() => process.kill(pids()[0]!, 0)).toThrow();
  } finally {
    await client.close();
    for (const pid of pids()) expect(() => process.kill(pid, 0)).toThrow();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent account lookup timeout retries only once and can be closed cleanly", async () => {
  const { directory, client, pids } = fixture(true);
  try {
    await expect(client.readRateLimits()).rejects.toThrow("account/read timed out");
    expect(pids()).toHaveLength(2);
  } finally {
    await client.close();
    for (const pid of pids()) expect(() => process.kill(pid, 0)).toThrow();
    rmSync(directory, { recursive: true, force: true });
  }
});
