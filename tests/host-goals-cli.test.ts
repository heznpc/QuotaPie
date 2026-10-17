import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { fakeCodexLogin } from "./helpers/account";

const SESSION = "11111111-2222-4333-8444-555555555555";
const CLI = resolve(import.meta.dir, "../src/cli.ts");

test("pause --goal, persisted list, and unlink round-trip through the real CLI and read-only RPC client", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-goal-cli-"));
  const profile = join(root, "profile");
  const data = join(root, "data");
  const configPath = join(root, "config.json");
  const binary = join(root, "codex-fixture");
  const calls = join(profile, "calls.jsonl");
  fakeCodexLogin(profile);
  mkdirSync(data);
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "fixture", label: "Fixture", codexHome: profile, enabled: true }];
  config.accounts.claude = [];
  config.collection.codexCommand = binary;
  config.collection.codexEnabled = false;
  config.alerts.enabled = false;
  config.resetSignals.enabled = false;
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  const req=JSON.parse(line); if(req.id==null) continue;
  appendFileSync(process.env.CODEX_HOME+'/calls.jsonl',req.method+'\\n');
  let result={};
  if(req.method==='account/read') result={account:{type:'chatgpt',email:'fixture@example.invalid'}};
  if(req.method==='thread/list') result={data:[{id:'${SESSION}',cwd:${JSON.stringify(root)},name:'Fixture'}],nextCursor:null};
  if(req.method==='thread/goal/get') result={goal:{threadId:req.params.threadId,objective:'Finish CLI fixture',status:'usageLimited'}};
  console.log(JSON.stringify({id:req.id,result}));
}
`, { mode: 0o700 });
  const database = new QuotaDatabase(join(data, "quotapie.sqlite3"));
  database.ingestObservation({ provider: "codex", account: "fixture", bucket: "codex:primary:300", label: "5h",
    windowSeconds: 18_000, usedPercent: 100, resetsAtMs: Date.now() + 3_600_000,
    observedAtMs: Date.now() - 1_000, source: "fixture", quality: "authoritative" }, config);
  database.close();
  const run = async (...args: string[]) => {
    const process = Bun.spawn([Bun.which("bun")!, CLI, ...args], {
      cwd: root, env: { PATH: "/usr/bin:/bin", QUOTAPIE_HOME: data, QUOTAPIE_CONFIG: configPath,
        CODEX_HOME: profile, CODEX_THREAD_ID: SESSION }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [code, stdout, stderr] = await Promise.all([process.exited,
      new Response(process.stdout).text(), new Response(process.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    const paused = await run("pause", "--provider", "codex", "--goal", "--json");
    expect(paused.stderr).toBe("");
    expect(paused.code).toBe(0);
    const task = JSON.parse(paused.stdout);
    expect(task.hostGoal).toMatchObject({ taskId: task.id, objective: "Finish CLI fixture", hostStatus: "usageLimited",
      resumeState: "waiting", readState: "ready" });
    const listed = await run("goals", "list", "--refresh");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).items[0].taskId).toBe(task.id);
    expect(listed.stdout).not.toContain(SESSION);
    expect(listed.stdout).not.toContain(profile);
    const methods = readFileSync(calls, "utf8").trim().split("\n");
    expect(methods).toContain("thread/goal/get");
    expect(methods.every(method => ["initialize", "account/read", "thread/list", "thread/goal/get"].includes(method))).toBe(true);
    expect((await run("goals", "unlink", "--task", task.id)).code).toBe(0);
    expect(JSON.parse((await run("goals", "list")).stdout).items).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
