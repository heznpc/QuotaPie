import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installMacOS, stageRuntime, type InstallDependencies } from "../script/install-macos";
import { runtimeSourceHash } from "../src/runtime-identity";

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
      throw new Error(`Unexpected command ${command.join(" ")}`);
    },
    async json(url) {
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
    expect(existsSync(join(staged, "script/install.sh"))).toBe(true);
    expect(readFileSync(join(staged, "LICENSE"), "utf8")).toBe("MIT License");
    expect(existsSync(join(staged, "src/node_modules"))).toBe(false);
    expect(existsSync(join(staged, "src/.private"))).toBe(false);
    expect(existsSync(join(staged, "src/auth.json"))).toBe(false);
    expect(existsSync(join(staged, "local.sqlite3"))).toBe(false);
  } finally { f.close(); }
});
