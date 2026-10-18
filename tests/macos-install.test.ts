import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installMacOS, stageRuntime, type InstallDependencies } from "../script/install-macos";
import { runtimeSourceHash } from "../src/runtime-identity";
import { QuotaStorage } from "../src/storage/database";
import { WorkStore } from "../src/work/store";

const labels = ["local.quotapie", "local.quotapie.menubar"];
function fixture(existing = true) {
  const root = mkdtempSync(join(tmpdir(), "quotapie-installer-"));
  const home = join(root, "home"), source = join(root, "source"), supplied = join(root, "input/QuotaPie.app");
  const runtime = join(home, ".local/lib/quotapie"), app = join(home, "Applications/QuotaPie.app");
  const cli = join(home, ".local/bin/quotapie"), config = join(root, "custom/config.json"), data = join(root, "custom/data");
  const agents = labels.map(label => join(home, "Library/LaunchAgents", label + ".plist"));
  const calls: string[][] = [], jobs = new Map<string, number>();
  const alive = new Set<number>();
  let nextPid = 200, fail: string | null = null, failureUsed = false, holdOldPid = false;
  function file(path: string, content: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  const configText = JSON.stringify({ accounts: { codex: [], claude: [] }, dashboard: { host: "127.0.0.1", port: 47831 }, custom: "keep exact bytes" }, null, 3) + "\n";
  function tree(path: string, version: string) {
    file(join(path, "src/cli.ts"), version);
    file(join(path, "src/server.ts"), "server");
    file(join(path, "packages/quota-core/src/index.ts"), "export {}");
    file(join(path, "packages/quota-core/package.json"), '{"name":"@heznpc/quota-core","type":"module"}');
    file(join(path, "bin/quotapie"), "#!/bin/sh\n");
    file(join(path, "script/awake_hook.py"), "# hook");
    file(join(path, "script/install-macos.ts"), "// installer");
    file(join(path, "script/install.sh"), "#!/bin/sh");
    file(join(path, "package.json"), '{"name":"quotapie","type":"module"}');
    file(join(path, "LICENSE"), "MIT License");
  }
  function application(path: string, version: string) {
    file(join(path, "Contents/Info.plist"), JSON.stringify({ CFBundleIdentifier: labels[1], CFBundleExecutable: "QuotaPie" }));
    file(join(path, "Contents/MacOS/QuotaPie"), version);
    file(join(path, "Contents/Helpers/QuotaPiePowerHelper"), "helper");
  }
  tree(source, "new-runtime"); application(supplied, "new-app");
  file(join(data, "sentinel.sqlite3"), "private data");
  file(join(home, ".codex/auth.json"), "private credentials");
  file(join(home, ".local/lib/quotapie-compaction/settings.json"), "private relay settings");
  if (existing) {
    tree(runtime, "old-runtime"); application(app, "old-app"); file(config, configText);
    mkdirSync(dirname(cli), { recursive: true }); symlinkSync(join(runtime, "bin/quotapie"), cli);
    agents.forEach((path, index) => {
      file(path, JSON.stringify({ Label: labels[index], ProgramArguments: index ? [join(app, "Contents/MacOS/QuotaPie")] : [cli, "serve"], old: true }));
      jobs.set(labels[index]!, 100 + index); alive.add(100 + index);
    });
  }
  const deps: Partial<InstallDependencies> = {
    platform: "darwin", uid: 501, bun: process.execPath,
    env: { ...process.env, QUOTAPIE_CONFIG: config, QUOTAPIE_HOME: data, CODEX_HOME: "/unchanged-codex-home" },
    sleep: async () => {},
    async run(command, env) {
      calls.push(command);
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const bad = (stderr = "synthetic failure") => ({ code: 1, stdout: "", stderr });
      if (command[1] === "--version") return ok("1.3.10");
      if (command[0] === "/usr/bin/xcrun") return ok("Swift version");
      if (command[0] === "/bin/bash") {
        if (fail === "build") return bad();
        application(join(command[3]!, "QuotaPie.app"), "new-app"); return ok();
      }
      if (command[0] === "/usr/bin/ditto") { cpSync(command[1]!, command[2]!, { recursive: true }); return ok(); }
      if (command[0] === "/usr/bin/codesign") return ok();
      if (command[0] === "/usr/bin/plutil") {
        if (command.includes("json")) return ok(readFileSync(command.at(-1)!, "utf8"));
        JSON.parse(readFileSync(command.at(-1)!, "utf8")); return ok();
      }
      if (command[1]?.endsWith("/src/cli.ts")) {
        if (command[2] === "init") { file(env.QUOTAPIE_CONFIG!, configText); return ok(); }
        const index = command[2] === "menubar-launchd" ? 1 : 0;
        return ok(JSON.stringify({ Label: labels[index], ProgramArguments: ["/wrong/initial/path"],
          EnvironmentVariables: { QUOTAPIE_CONFIG: "/wrong/config", HOME: env.HOME }, RunAtLoad: true, KeepAlive: true }));
      }
      if (command[0] === "/bin/launchctl") {
        const label = command[2]!.split("/").at(-1)!;
        if (command[1] === "print") return jobs.has(label) ? ok(`state = running\npid = ${jobs.get(label)}\n`) : bad("not loaded");
        if (command[1] === "bootout") {
          const pid = jobs.get(label);
          if (fail === "rollback-stop" && pid && pid >= 200 && failureUsed) return bad("cannot stop");
          jobs.delete(label); if (pid && !holdOldPid) alive.delete(pid); return ok();
        }
        if (command[1] === "bootstrap") {
          const value = JSON.parse(readFileSync(command[3]!, "utf8"));
          if ((fail === "menu-start" || fail === "rollback-stop") && value.Label === labels[1] && !failureUsed) {
            failureUsed = true; return bad("menu start failed");
          }
          jobs.set(value.Label, ++nextPid); alive.add(nextPid); return ok();
        }
      }
      if (command[0] === "/bin/kill") return alive.has(Number(command[2])) ? ok() : bad("no such process");
      if (command[0] === "/usr/bin/pgrep") {
        if (fail === "config-race") file(config, '{"custom":"created by another process"}');
        return jobs.has(labels[1]!) ? ok(String(jobs.get(labels[1]!))) : bad();
      }
      if (command[0] === "/bin/ps") return ok(command.at(-1) === "comm=" ? join(app, "Contents/MacOS/QuotaPie") : `${process.execPath} ${runtime}/src/cli.ts serve`);
      if (command[0] === "/usr/sbin/lsof") return ok(`p${jobs.get(labels[0]!)}\nn${join(data,"quotapie.sqlite3")}\n`);
      throw new Error(`Unexpected command ${command.join(" ")}`);
    },
    async json(url) {
      if (url.endsWith("/api/status")) return { actionToken: "fixture-only-token", jobs: [], resumeTasks: [] };
      if (url.endsWith("/api/work")) return { policies: [], executions: [] };
      if (url.endsWith("/health")) return { ok: false, accounts: [{ health: "never-attempted", errorCategory: "auth-required" }] };
      const pid = jobs.get(labels[0]!); if (!pid) throw new Error("offline");
      return { schemaVersion: 1, sourceHash: fail === "identity" && pid >= 200 ? "wrong" : runtimeSourceHash(runtime), pid, startedAt: new Date().toISOString() };
    },
  };
  return { root, home, source, supplied, runtime, app, cli, config, data, agents, calls, jobs, configText, deps,
    setFailure: (value: string) => { fail = value; }, holdOldPid: () => { holdOldPid = true; },
    run: (prebuilt = true) => installMacOS({ home, sourceRoot: source, app: prebuilt ? supplied : undefined, attempts: 2 }, deps),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

function maintainedFixture() {
  const f=fixture(), storage=new QuotaStorage(join(f.data,"quotapie.sqlite3")), store=new WorkStore(storage);
  const config=JSON.parse(f.configText);
  config.accounts.codex=[{id:"plus",label:"Plus",enabled:true,codexHome:join(f.root,"profile")}];
  writeFileSync(f.config,JSON.stringify(config));
  const agent=JSON.parse(readFileSync(f.agents[0]!,"utf8"));
  agent.EnvironmentVariables={QUOTAPIE_HOME:f.data};writeFileSync(f.agents[0]!,JSON.stringify(agent));
  store.save({id:"quota-policy",provider:"codex",account:"plus",accountKey:"identity",profileKey:"profile",nativeSessionId:"thread",cwd:"/tmp",
    prompt:"continue",objective:"finish",completionCriteria:["proof"],dispatchOwner:"local",enabled:true,trigger:"quota-ready",resetWithinMinutes:0,
    budgetByBucket:{"codex:primary":{reservePercent:0,maxUsagePercent:100}},maxTurns:1,maxDurationSeconds:60,maxTotalDurationSeconds:60,
    expiresAtMs:Date.now()+3600000,priority:0,onReset:"continue"},null,"fixture");
  storage.db.exec("CREATE TABLE quota_resume_preferences(account TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE quota_resume_incidents(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const preference=JSON.stringify({account:"plus",enabled:true,enabledAtMs:1234,revision:7}),incident=JSON.stringify({id:"pending",state:"waiting",authorizationRevision:7});
  storage.db.query("INSERT INTO quota_resume_preferences VALUES(?,?)").run("plus",preference);
  storage.db.query("INSERT INTO quota_resume_incidents VALUES(?,?)").run("pending",incident);
  const read=f.deps.json!;
  f.deps.json=async(url,options)=>url.endsWith("/api/work")?{policies:store.list(),executions:store.executions()}
    :url.endsWith("/api/status")?{actionToken:"fixture-only-token",jobs:[],resumeTasks:[],autoResume:{accounts:[{account:"plus",enabled:true}],incidents:[{state:"waiting"}]}}
    :read(url,options);
  return {...f,storage,store,preference,incident,close(){storage.close();f.close();}};
}

test("maintenance permits enabled scheduling without changing opt-in or pending incidents and blocks claims until verified",async()=>{
  const f=maintainedFixture(), run=f.deps.run!;
  let checked=0;
  f.deps.run=async(command,env)=>{
    if(command[1]==="bootout" || command[1]==="bootstrap") {
      expect(f.store.claimRequest("quota-policy","local",1,"racing-claim").execution).toBeNull();checked++;
    }
    return run(command,env);
  };
  try {
    expect((await f.run()).installed).toBe(true);expect(checked).toBe(4);
    expect(f.store.fences()).toEqual([]);
    expect(f.storage.db.query<{value:string},[]>("SELECT value FROM quota_resume_preferences").get()!.value).toBe(f.preference);
    expect(f.storage.db.query<{value:string},[]>("SELECT value FROM quota_resume_incidents").get()!.value).toBe(f.incident);
    expect(f.store.get("quota-policy")?.enabled).toBe(true);
    expect(f.store.claimRequest("quota-policy","local",1,"after-install").execution).not.toBeNull();
  } finally {f.close();}
});

test("maintenance survives failed activation until the restored runtime is verified",async()=>{
  for(const verifyRollback of [true,false]) {
    const f=maintainedFixture(), read=f.deps.json!;
    f.setFailure("menu-start");
    f.deps.json=async(url,options)=>{
      const value=await read(url,options);
      if(url.endsWith("/api/runtime") && readFileSync(join(f.runtime,"src/cli.ts"),"utf8")==="old-runtime"
        && (f.jobs.get(labels[0]!)??0)>=200) {
        expect(f.store.claim("quota-policy","local",1)).toBeNull();
        if(!verifyRollback)return {...value,sourceHash:"unverified-restoration"};
      }
      return value;
    };
    try {
      await expect(f.run()).rejects.toThrow(verifyRollback?"menu start failed":"Recovery needs attention");
      expect(f.store.fences().length).toBe(verifyRollback?0:1);
      expect(existsSync(join(dirname(f.runtime),".quotapie-install.lock"))).toBe(!verifyRollback);
      expect(f.storage.db.query<{value:string},[]>("SELECT value FROM quota_resume_preferences").get()!.value).toBe(f.preference);
    } finally {f.close();}
  }
});

test("changed live data path or an older unlisted execution refuses activation and cleans only this install",async()=>{
  for(const failure of ["path","open-file","history"]) {
    const f=maintainedFixture();
    if(failure==="path") {
      const agent=JSON.parse(readFileSync(f.agents[0]!,"utf8"));agent.EnvironmentVariables.QUOTAPIE_HOME=f.root;
      writeFileSync(f.agents[0]!,JSON.stringify(agent));
    } else if(failure==="open-file") {
      const run=f.deps.run!;f.deps.run=async(command,env)=>command[0]==="/usr/sbin/lsof"
        ?{code:1,stdout:"",stderr:"unverified"}:run(command,env);
    } else {
      f.storage.db.query("INSERT INTO work_executions(id,policy_id,value) VALUES(?,?,?)").run("hidden","quota-policy",JSON.stringify({status:"uncertain"}));
      const read=f.deps.json!;
      f.deps.json=async(url,options)=>url.endsWith("/api/work")?{policies:f.store.list(),executions:[]}:read(url,options);
    }
    try {
      await expect(f.run()).rejects.toThrow(failure==="path"?"data directory":failure==="open-file"?"open database":"Managed work");
      expect(f.calls.some(command=>command[1]==="bootout")).toBe(false);
      expect(f.store.fences()).toEqual([]);
    } finally {f.close();}
  }
});

test("lost maintenance during verification cannot trigger rollback that interrupts newly claimed work",async()=>{
  const f=maintainedFixture(), read=f.deps.json!;
  f.deps.json=async(url,options)=>{
    const result=await read(url,options);
    if(url.endsWith("/health")) {
      for(const fence of f.store.fences()) f.store.releaseLegacy(fence.id);
      expect(f.store.claim("quota-policy","local",1)).not.toBeNull();
    }
    return result;
  };
  try {
    await expect(f.run()).rejects.toThrow("processes were not stopped");
    expect(f.calls.filter(command=>command[1]==="bootout")).toHaveLength(2);
    expect(f.jobs.get(labels[0]!)).toBeGreaterThan(200);
    expect(f.jobs.get(labels[1]!)).toBeGreaterThan(200);
    expect(readFileSync(join(f.runtime,"src/cli.ts"),"utf8")).toBe("new-runtime");
    expect(existsSync(join(dirname(f.runtime),".quotapie-install.lock"))).toBe(true);
  } finally {f.close();}
});

test("prebuilt installation preserves config, credentials and data, pins paths and can be repeated", async () => {
  const f = fixture();
  try {
    const first = await f.run();
    expect(first.collection).toBe("setup-needed");
    expect(first.collectorPid).not.toBe(100);
    expect(first.menuPid).not.toBe(101);
    expect(readFileSync(f.config, "utf8")).toBe(f.configText);
    expect(readFileSync(join(f.data, "sentinel.sqlite3"), "utf8")).toBe("private data");
    expect(readFileSync(join(f.home, ".codex/auth.json"), "utf8")).toBe("private credentials");
    expect(readFileSync(join(f.home, ".local/lib/quotapie-compaction/settings.json"), "utf8")).toBe("private relay settings");
    expect(readlinkSync(f.cli)).toBe(join(f.runtime, "bin/quotapie"));
    const collector = JSON.parse(readFileSync(f.agents[0]!, "utf8"));
    expect(collector.ProgramArguments).toEqual([join(f.runtime, "bin/quotapie"), "serve"]);
    expect(collector.EnvironmentVariables.QUOTAPIE_CONFIG).toBe(f.config);
    expect(collector.EnvironmentVariables.QUOTAPIE_HOME).toBe(f.data);
    expect(collector.EnvironmentVariables.BUN_BIN).toBe(process.execPath);
    expect(collector.EnvironmentVariables.PATH.startsWith(dirname(process.execPath))).toBe(true);
    expect(f.calls.some(command => command[0] === "/usr/bin/xcrun" || command[2] === "init")).toBe(false);
    const second = await f.run();
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(second.collectorPid).not.toBe(first.collectorPid);
    expect(readFileSync(f.config, "utf8")).toBe(f.configText);
  } finally { f.close(); }
});

test("build failure leaves the running installation and exact plists intact", async () => {
  const f = fixture();
  const before = f.agents.map(path => readFileSync(path, "utf8"));
  try {
    f.setFailure("build");
    await expect(f.run(false)).rejects.toThrow("synthetic failure");
    expect(f.calls.some(command => command[1] === "bootout")).toBe(false);
    expect(f.agents.map(path => readFileSync(path, "utf8"))).toEqual(before);
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    expect(readFileSync(join(f.app, "Contents/MacOS/QuotaPie"), "utf8")).toBe("old-app");
    expect(f.jobs.get(labels[0]!)).toBe(100);
  } finally { f.close(); }
});

test("a transient final identity timeout retries without stopping the newly verified installation", async () => {
  const f = fixture(), read = f.deps.json!;
  let stabilityReads = 0;
  f.deps.json = async (url, options) => {
    if (url.endsWith("/api/work")) expect(options?.headers?.["x-quotapie-action-token"]).toBe("fixture-only-token");
    if (url.endsWith("/api/runtime") && (f.jobs.get(labels[1]!) ?? 0) >= 200) {
      expect(options?.timeoutMs).toBe(5000);
      if (++stabilityReads === 1) throw new DOMException("synthetic startup delay", "TimeoutError");
    }
    return read(url, options);
  };
  try {
    const installed = await f.run();
    expect(stabilityReads).toBe(2);
    expect(f.jobs.get(labels[0]!)).toBe(installed.collectorPid);
    expect(f.jobs.get(labels[1]!)).toBe(installed.menuPid);
    expect(f.calls.filter(command => command[1] === "bootout")).toHaveLength(2);
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("new-runtime");
  } finally { f.close(); }
});

test("initial collector identity polling also permits the bounded five-second startup response", async () => {
  const f = fixture(), read = f.deps.json!;
  let startupReads = 0;
  f.deps.json = async (url, options) => {
    if (url.endsWith("/api/runtime") && (f.jobs.get(labels[0]!) ?? 0) >= 200 && !f.jobs.has(labels[1]!)) {
      expect(options?.timeoutMs).toBe(5000);
      if (++startupReads === 1) throw new DOMException("synthetic startup delay", "TimeoutError");
    }
    return read(url, options);
  };
  try {
    expect((await f.run()).installed).toBe(true);
    expect(startupReads).toBe(2);
    expect(f.calls.filter(command => command[1] === "bootout")).toHaveLength(2);
  } finally { f.close(); }
});

test("persistent final identity transport failures stop after three attempts and restore the prior runtime", async () => {
  const f = fixture(), read = f.deps.json!;
  let stabilityReads = 0;
  f.deps.json = async (url, options) => {
    if (url.endsWith("/api/runtime") && (f.jobs.get(labels[1]!) ?? 0) >= 200) {
      stabilityReads++; throw new DOMException("synthetic startup delay", "TimeoutError");
    }
    return read(url, options);
  };
  try {
    await expect(f.run()).rejects.toThrow("runtime identity during startup stability");
    expect(stabilityReads).toBe(3);
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    expect(readFileSync(join(f.app, "Contents/MacOS/QuotaPie"), "utf8")).toBe("old-app");
  } finally { f.close(); }
});

test("a returned wrong identity or a process change during the final read still rolls back immediately", async () => {
  for (const failure of ["identity", "process"] as const) {
    const f = fixture(), read = f.deps.json!;
    let stabilityReads = 0;
    f.deps.json = async (url, options) => {
      const result = await read(url, options);
      if (url.endsWith("/api/runtime") && (f.jobs.get(labels[1]!) ?? 0) >= 200) {
        stabilityReads++;
        if (failure === "identity") return { ...result, sourceHash: "foreign-runtime" };
        f.jobs.set(labels[0]!, 999);
      }
      return result;
    };
    try {
      await expect(f.run()).rejects.toThrow("exited during startup verification");
      expect(stabilityReads).toBe(1);
      expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    } finally { f.close(); }
  }
});

test("managed work that can run or has an unresolved claim prevents any service stop", async () => {
  const cases = [
    { policies: [{enabled:true,state:{activeExecutionId:null}}], executions: [] },
    { policies: [{enabled:false,state:{activeExecutionId:"active-claim"}}], executions: [] },
    ...["claimed", "dispatched", "uncertain"].map(status => ({policies:[],executions:[{status}]})),
  ];
  for (const work of cases) {
    const f = fixture(), read = f.deps.json!;
    f.deps.json = (url, options) => url.endsWith("/api/work") ? Promise.resolve(work) : read(url, options);
    try {
      await expect(f.run()).rejects.toThrow("Managed work is enabled");
      expect(f.calls.some(command => command[1] === "bootout")).toBe(false);
      expect(f.jobs.get(labels[0]!)).toBe(100);
      expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    } finally { f.close(); }
  }
});

test("an enabled quota-recovery scanner prevents all process stops even before its first incident", async () => {
  const f = fixture(), read = f.deps.json!;
  const beforeJobs = [...f.jobs], beforePlists = f.agents.map(path => readFileSync(path, "utf8"));
  f.deps.json = async (url, options) => url.endsWith("/api/status")
    ? {actionToken:"fixture-only-token",jobs:[],resumeTasks:[],autoResume:{
        accounts:[{account:"inactive",enabled:false},{account:"active",enabled:true}],incidents:[],
      }} : read(url, options);
  try {
    expect(f.calls.filter(command => command[1] === "bootout")).toHaveLength(0);
    await expect(f.run()).rejects.toThrow("Managed work is enabled");
    expect(f.calls.filter(command => command[1] === "bootout" || command[1] === "bootstrap"
      || command[0] === "/bin/kill" && command[1] !== "-0")).toHaveLength(0);
    expect([...f.jobs]).toEqual(beforeJobs);
    expect(f.agents.map(path => readFileSync(path, "utf8"))).toEqual(beforePlists);
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    expect(readFileSync(join(f.app, "Contents/MacOS/QuotaPie"), "utf8")).toBe("old-app");
    expect(readFileSync(f.config, "utf8")).toBe(f.configText);
  } finally { f.close(); }
});

test("disabled scanners and older collectors without auto-resume remain installable", async () => {
  for (const autoResume of [undefined, {accounts:[],incidents:[]}, {
    accounts:[{account:"personal",enabled:false}],incidents:[{state:"resumed"},{state:"skipped"}],
  }]) {
    const f = fixture(), read = f.deps.json!;
    f.deps.json = async (url, options) => url.endsWith("/api/status")
      ? {actionToken:"fixture-only-token",jobs:[],resumeTasks:[],...(autoResume === undefined ? {} : {autoResume})}
      : read(url, options);
    try { expect((await f.run()).installed).toBe(true); }
    finally { f.close(); }
  }
});

test("malformed scanner state never permits stopping the running installation", async () => {
  for (const autoResume of [null, [], {}, {accounts:[],incidents:null}, {accounts:{},incidents:[]},
    {accounts:[{account:"personal",enabled:"false"}],incidents:[]},
    {accounts:[{account:"personal"}],incidents:[]}, {accounts:[{enabled:false}],incidents:[]},
    {accounts:[],incidents:[{state:"unknown"}]}, {accounts:[],incidents:[null]},
  ]) {
    const f = fixture(), read = f.deps.json!, beforeJobs = [...f.jobs];
    f.deps.json = async (url, options) => url.endsWith("/api/status")
      ? {actionToken:"fixture-only-token",jobs:[],resumeTasks:[],autoResume} : read(url, options);
    try {
      await expect(f.run()).rejects.toThrow("Managed work state could not be verified");
      expect(f.calls.filter(command => command[1] === "bootout" || command[1] === "bootstrap"
        || command[0] === "/bin/kill" && command[1] !== "-0")).toHaveLength(0);
      expect([...f.jobs]).toEqual(beforeJobs);
    } finally { f.close(); }
  }
});

test("pending, running and uncertain legacy jobs prevent service stops, while host-owned resume registrations do not", async () => {
  for (const state of ["waiting", "ready", "running", "review", "succeeded"]) {
    const f = fixture(), read = f.deps.json!;
    f.deps.json = async (url, options) => url.endsWith("/api/status")
      ? {actionToken:"fixture-only-token",jobs:[{state}],resumeTasks:[{state:"approved"}]} : read(url, options);
    try {
      if (state === "succeeded") expect((await f.run()).installed).toBe(true);
      else {
        await expect(f.run()).rejects.toThrow("Managed work is enabled");
        expect(f.calls.some(command => command[1] === "bootout")).toBe(false);
      }
    } finally { f.close(); }
  }
});

test("missing, malformed or unavailable work admission cannot be mistaken for idle", async () => {
  for (const failure of ["token", "shape", "transport"] as const) {
    const f = fixture(), read = f.deps.json!;
    let failedReads = 0;
    f.deps.json = async (url, options) => {
      if (failure === "token" && url.endsWith("/api/status")) return {jobs:[],resumeTasks:[]};
      if (failure === "shape" && url.endsWith("/api/work")) return {policies:[{enabled:false}],executions:[]};
      if (failure === "transport" && url.endsWith("/api/work")) { failedReads++; throw new Error("unavailable"); }
      return read(url, options);
    };
    try {
      await expect(f.run()).rejects.toThrow("Managed work state could not be verified");
      expect(f.calls.some(command => command[1] === "bootout")).toBe(false);
      expect(f.jobs.get(labels[0]!)).toBe(100);
      if (failure === "transport") expect(failedReads).toBe(3);
    } finally { f.close(); }
  }
});

test("a full legacy-job page is insufficient evidence that no older managed job can run", async () => {
  const f = fixture(), read = f.deps.json!;
  f.deps.json = async (url, options) => url.endsWith("/api/status")
    ? {actionToken:"fixture-only-token",jobs:Array.from({length:100},()=>({state:"succeeded"})),resumeTasks:[]}
    : read(url, options);
  try {
    await expect(f.run()).rejects.toThrow("full legacy-job page");
    expect(f.calls.some(command => command[1] === "bootout")).toBe(false);
    expect(f.jobs.get(labels[0]!)).toBe(100);
  } finally { f.close(); }
});

for (const failure of ["identity", "menu-start"]) test(`${failure} failure restores prior app, runtime, links, plists and loaded state`, async () => {
  const f = fixture();
  const before = f.agents.map(path => readFileSync(path, "utf8"));
  try {
    f.setFailure(failure);
    await expect(f.run()).rejects.toThrow(failure === "identity" ? "runtime identity" : "menu start failed");
    expect(f.agents.map(path => readFileSync(path, "utf8"))).toEqual(before);
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    expect(readFileSync(join(f.app, "Contents/MacOS/QuotaPie"), "utf8")).toBe("old-app");
    expect(readlinkSync(f.cli)).toBe(join(f.runtime, "bin/quotapie"));
    expect(readFileSync(f.config, "utf8")).toBe(f.configText);
    expect(f.jobs.has(labels[0]!)).toBe(true); expect(f.jobs.has(labels[1]!)).toBe(true);
    expect(readdirSync(dirname(f.runtime)).some(path => path.startsWith(".quotapie-install"))).toBe(false);
  } finally { f.close(); }
});

test("fresh failed install restores absence of config and jobs while preserving unrelated files", async () => {
  const f = fixture(false);
  try {
    f.setFailure("identity");
    await expect(f.run()).rejects.toThrow("runtime identity");
    expect(existsSync(f.config)).toBe(false); expect(existsSync(f.runtime)).toBe(false);
    expect(existsSync(f.app)).toBe(false); expect(existsSync(f.cli)).toBe(false);
    expect(f.jobs.size).toBe(0);
    expect(readFileSync(join(f.data, "sentinel.sqlite3"), "utf8")).toBe("private data");
  } finally { f.close(); }
});

test("a config created concurrently after first-install planning is never overwritten or removed", async () => {
  const f = fixture(false);
  try {
    f.setFailure("config-race");
    await expect(f.run()).rejects.toThrow("Configuration changed");
    expect(readFileSync(f.config, "utf8")).toBe('{"custom":"created by another process"}');
    expect(f.calls.some(command => command[1] === "bootout" || command[1] === "bootstrap")).toBe(false);
    expect(existsSync(f.runtime)).toBe(false);
  } finally { f.close(); }
});

test("non-owned CLI files and duplicate installers are rejected before service mutation", async () => {
  for (const conflict of ["cli", "lock"]) {
    const f = fixture();
    try {
      if (conflict === "cli") { rmSync(f.cli); writeFileSync(f.cli, "someone else's tool"); }
      else mkdirSync(join(dirname(f.runtime), ".quotapie-install.lock"));
      await expect(f.run()).rejects.toThrow(conflict === "cli" ? "non-owned CLI" : "Another install");
      expect(f.calls.some(command => command[1] === "bootout")).toBe(false);
      if (conflict === "cli") expect(readFileSync(f.cli, "utf8")).toBe("someone else's tool");
    } finally { f.close(); }
  }
});

test("failed rollback unload never replaces files a new process could still be using", async () => {
  const f = fixture();
  try {
    f.setFailure("rollback-stop");
    await expect(f.run()).rejects.toThrow("Recovery needs attention");
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("new-runtime");
    expect(existsSync(join(dirname(f.runtime), ".quotapie-install.lock"))).toBe(true);
    expect(readdirSync(dirname(f.runtime)).some(name => name.startsWith(".quotapie.backup-"))).toBe(true);
  } finally { f.close(); }
});

test("an unloaded job's surviving PID stays tracked through rollback and prevents file replacement", async () => {
  const f = fixture();
  const before = f.agents.map(path => readFileSync(path, "utf8"));
  try {
    f.holdOldPid();
    await expect(f.run()).rejects.toThrow("Recovery needs attention");
    expect(f.agents.map(path => readFileSync(path, "utf8"))).toEqual(before);
    expect(readFileSync(join(f.runtime, "src/cli.ts"), "utf8")).toBe("old-runtime");
    expect(readFileSync(join(f.app, "Contents/MacOS/QuotaPie"), "utf8")).toBe("old-app");
    expect(f.calls.some(command => command[1] === "bootstrap")).toBe(false);
    expect(existsSync(join(dirname(f.runtime), ".quotapie-install.lock"))).toBe(true);
    expect(f.calls.filter(command => command[0] === "/bin/kill" && command[2] === "101").length).toBeGreaterThan(50);
  } finally { f.close(); }
});

test("staging omits private data, dependencies and hidden trees but retains executable sources", () => {
  const f = fixture(false);
  try {
    mkdirSync(join(f.source, "src/node_modules")); writeFileSync(join(f.source, "src/node_modules/private.ts"), "private");
    mkdirSync(join(f.source, "src/.private")); writeFileSync(join(f.source, "src/.private/secret.ts"), "private");
    writeFileSync(join(f.source, "src/auth.json"), "private");
    writeFileSync(join(f.source, "local.sqlite3"), "private");
    const staged = join(f.root, "staged"); stageRuntime(f.source, staged);
    expect(existsSync(join(staged, "src/cli.ts"))).toBe(true);
    expect(existsSync(join(staged, "packages/quota-core/src/index.ts"))).toBe(true);
    expect(existsSync(join(staged, "packages/quota-core/package.json"))).toBe(true);
    expect(existsSync(join(staged, "script/install.sh"))).toBe(true);
    expect(readFileSync(join(staged, "LICENSE"), "utf8")).toBe("MIT License");
    expect(existsSync(join(staged, "src/node_modules"))).toBe(false);
    expect(existsSync(join(staged, "src/.private"))).toBe(false);
    expect(existsSync(join(staged, "src/auth.json"))).toBe(false);
    expect(existsSync(join(staged, "local.sqlite3"))).toBe(false);
  } finally { f.close(); }
});


test("staging rejects symlinked shared-package parents", () => {
  const f = fixture(false);
  try {
    const external = join(f.root, "external-core");
    cpSync(join(f.source, "packages/quota-core"), external, { recursive: true });
    rmSync(join(f.source, "packages/quota-core"), { recursive: true });
    symlinkSync(external, join(f.source, "packages/quota-core"));
    expect(() => stageRuntime(f.source, join(f.root, "staged"))).toThrow("symlink");
    rmSync(join(f.source, "packages/quota-core"));
    cpSync(external, join(f.source, "packages/quota-core"), { recursive: true });
    rmSync(join(f.source, "packages/quota-core/package.json"));
    symlinkSync(join(external, "package.json"), join(f.source, "packages/quota-core/package.json"));
    expect(() => stageRuntime(f.source, join(f.root, "staged-manifest"))).toThrow("symlink");
  } finally { f.close(); }
});
