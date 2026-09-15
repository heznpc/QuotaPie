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

test("EOF with a live provider reaps the child and retries the read once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-reap-test-"));
  const binary = join(dir, "fake-codex");
  writeFileSync(join(dir, "auth.json"), "{}");
  writeFileSync(binary, `#!/usr/bin/python3
import os, sys, json, signal, time
home=os.environ['CODEX_HOME']
with open(home+'/pids','a') as f: f.write(str(os.getpid())+'\\n')
signal.signal(signal.SIGTERM, lambda *_: None)
for line in sys.stdin:
 req=json.loads(line)
 if 'id' not in req: continue
 if req['method']=='account/read' and not os.path.exists(home+'/crashed'):
  open(home+'/crashed','w').close()
  os.close(1)
  while True: time.sleep(1)
 result={'rateLimits':{'limitId':'codex','primary':{'usedPercent':25,'windowDurationMins':300}}} if req['method']=='account/rateLimits/read' else {}
 print(json.dumps({'id':req['id'],'result':result}),flush=True)
`, { mode: 0o700 });
  const client = new CodexAppServerClient(binary, "default", 2500, dir);
  try {
    expect((await client.readRateLimits())[0]?.usedPercent).toBe(25);
    await client.close();
    const { readFileSync } = await import("node:fs");
    const pids = readFileSync(join(dir,"pids"),"utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
}, 10000);

test("thread discovery cannot disconnect an in-flight quota read on credential rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-concurrent-login-"));
  const binary = join(dir,"fake-codex");
  writeFileSync(join(dir,"auth.json"),"{}");
  writeFileSync(binary, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
 const req=JSON.parse(line); if(req.id==null) continue;
 if(req.method==='account/rateLimits/read') {writeFileSync(process.env.CODEX_HOME+'/reading','1'); await Bun.sleep(150);}
 console.log(JSON.stringify({id:req.id,result:req.method==='account/rateLimits/read'
  ? {rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300}}} : {data:[]}}));
}
`,{mode:0o700});
  const client = new CodexAppServerClient(binary,"default",2000,dir);
  try {
    const reading = client.readRateLimits().catch(error => error);
    const { existsSync } = await import("node:fs");
    for(let i=0;i<100 && !existsSync(join(dir,"reading"));i++) await Bun.sleep(10);
    writeFileSync(join(dir,"auth.json"),'{"rotated":true}');
    const threads = client.listThreads();
    expect(String(await reading)).toContain("login changed during quota lookup");
    expect((await threads).data).toEqual([]);
    expect((await client.readRateLimits())[0]?.usedPercent).toBe(25);
  } finally {await client.close();rmSync(dir,{recursive:true,force:true});}
});
