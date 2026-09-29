#!/usr/bin/env bun
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { runtimeSourceHash } from "../src/runtime-identity";

type Result = { code: number; stdout: string; stderr: string };
type Job = { loaded: boolean; pid: number | null };
export interface InstallDependencies {
  platform: string;
  uid: number;
  bun: string;
  env: Record<string, string | undefined>;
  run: (command: string[], env: Record<string, string | undefined>) => Promise<Result>;
  json: (url: string) => Promise<any>;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}
export interface InstallOptions { sourceRoot?: string; app?: string; home?: string; attempts?: number }

const LABELS = ["local.quotapie", "local.quotapie.menubar"] as const;
const defaults: InstallDependencies = {
  platform: process.platform, uid: process.getuid?.() ?? -1, bun: process.execPath, env: process.env,
  async run(command, env) {
    const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  },
  async json(url) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1500) });
    if (![200, 503].includes(response.status)) throw new Error("Local service unavailable");
    return response.json();
  },
  sleep: ms => Bun.sleep(ms),
};

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

/** Copy executable inputs only. Never follow links into a checkout's private data. */
export function stageRuntime(source: string, destination: string) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  function copy(relative: string) {
    const input = join(source, relative), output = join(destination, relative);
    const info = lstatSync(input);
    if (info.isSymbolicLink()) throw new Error(`Runtime input must not be a symlink: ${relative}`);
    if (info.isDirectory()) {
      mkdirSync(output, { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(input)) {
        if (!entry.startsWith(".") && entry !== "node_modules") copy(join(relative, entry));
      }
    } else if (info.isFile() && (relative === "bin/quotapie" || /\.(ts|html|sh|py)$/.test(relative))) {
      copyFileSync(input, output, constants.COPYFILE_EXCL);
      chmodSync(output, info.mode & 0o111 ? 0o700 : 0o600);
    }
  }
  for (const directory of ["src", "bin", "script", "scripts"]) if (existsSync(join(source, directory))) copy(directory);
  for (const directory of ["packages", "packages/quota-core"]) {
    if (lstatSync(join(source, directory)).isSymbolicLink()) throw new Error(`Runtime input must not be a symlink: ${directory}`);
  }
  copy("packages/quota-core/src");
  if (lstatSync(join(source, "packages/quota-core/package.json")).isSymbolicLink()) throw new Error("Runtime package manifest must not be a symlink");
  copyFileSync(join(source, "packages/quota-core/package.json"), join(destination, "packages/quota-core/package.json"), constants.COPYFILE_EXCL);
  chmodSync(join(destination, "packages/quota-core/package.json"), 0o600);
  const packagePath = join(source, "package.json");
  if (JSON.parse(readFileSync(packagePath, "utf8")).name !== "quotapie") throw new Error("Not a QuotaPie source tree");
  copyFileSync(packagePath, join(destination, "package.json"), constants.COPYFILE_EXCL);
  chmodSync(join(destination, "package.json"), 0o600);
  if (existsSync(join(source, "LICENSE"))) {
    copyFileSync(join(source, "LICENSE"), join(destination, "LICENSE"), constants.COPYFILE_EXCL);
    chmodSync(join(destination, "LICENSE"), 0o600);
  }
  for (const file of ["bin/quotapie", "src/cli.ts", "script/awake_hook.py", "script/install.sh", "script/install-macos.ts", "packages/quota-core/src/index.ts", "packages/quota-core/package.json"]) {
    if (!existsSync(join(destination, file))) throw new Error(`Missing runtime input: ${file}`);
  }
}

/** Per-user install. External operations are injectable; filesystem transactions are real in tests. */
export async function installMacOS(options: InstallOptions = {}, overrides: Partial<InstallDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  if (deps.platform !== "darwin") throw new Error("QuotaPie installation requires macOS.");
  if (deps.uid <= 0) throw new Error("Run this installer as your normal logged-in user, without sudo.");
  const source = realpathSync(options.sourceRoot ?? resolve(import.meta.dir, ".."));
  const home = options.home ?? homedir();
  const runtime = join(home, ".local/lib/quotapie"), cli = join(home, ".local/bin/quotapie");
  const app = join(home, "Applications/QuotaPie.app");
  const config = resolve(deps.env.QUOTAPIE_CONFIG ?? join(home, ".config/quotapie/config.json"));
  const data = resolve(deps.env.QUOTAPIE_HOME ?? join(home, ".local/share/quotapie"));
  const bun = realpathSync(deps.bun);
  for (const persistent of [config, data]) {
    const actual = existsSync(persistent) ? realpathSync(persistent) : persistent;
    for (const replaceable of [runtime, app]) {
      const target = existsSync(replaceable) ? realpathSync(replaceable) : replaceable;
      if (actual === target || actual.startsWith(target + "/")) {
        throw new Error(`Config and data must live outside the replaced app/runtime: ${persistent}`);
      }
    }
  }
  const env = { ...deps.env, BUN_BIN: bun, QUOTAPIE_CONFIG: config, QUOTAPIE_HOME: data,
    QUOTAPIE_MENU_APP: app, PATH: [dirname(bun), deps.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":") };
  const domain = `gui/${deps.uid}`;
  const agents = LABELS.map(label => join(home, "Library/LaunchAgents", label + ".plist"));
  const id = randomUUID();
  mkdirSync(dirname(runtime), { recursive: true, mode: 0o700 });
  const lock = join(dirname(runtime), ".quotapie-install.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code === "EEXIST") throw new Error(`Another install is active, or was interrupted. Inspect ${lock} before retrying.`);
    throw error;
  }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const work = join(dirname(runtime), `.quotapie-install-${id}`);
  const stagedRuntime = join(work, "runtime"), stagedApp = join(dirname(app), `.QuotaPie-install-${id}.app`);
  const swaps: Array<{ path: string; staged: string; backup: string; published: boolean; saved: boolean }> = [];
  let priorJobs: Job[] = [], activationStarted = false, createdConfig: string | null = null;
  const stoppedPids = new Map<string, Set<number>>();
  let rollbackFailed = false;
  const checkCancelled = () => { if (deps.signal?.aborted) throw new Error("Installation interrupted; previous installation restored."); };
  async function run(command: string[], customEnv = env) {
    const result = await deps.run(command, customEnv);
    if (result.code !== 0) throw new Error(`${basename(command[0]!)} failed: ${result.stderr.trim().slice(0, 2000) || result.stdout.trim().slice(0, 2000) || result.code}`);
    return result.stdout;
  }
  async function job(label: string): Promise<Job> {
    const result = await deps.run(["/bin/launchctl", "print", `${domain}/${label}`], env);
    return { loaded: result.code === 0, pid: result.code === 0 ? Number(result.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null : null };
  }
  async function plist(path: string) {
    return JSON.parse(await run(["/usr/bin/plutil", "-convert", "json", "-o", "-", "--", path]));
  }
  async function stop(label: string) {
    const previous = await job(label);
    const pending = stoppedPids.get(label) ?? new Set<number>();
    if (previous.pid) pending.add(previous.pid);
    stoppedPids.set(label, pending);
    if (previous.loaded) await run(["/bin/launchctl", "bootout", `${domain}/${label}`]);
    for (let attempt = 0; attempt < 50; attempt++) {
      for (const pid of pending) {
        if ((await deps.run(["/bin/kill", "-0", String(pid)], env)).code !== 0) pending.delete(pid);
      }
      if (!(await job(label)).loaded && pending.size === 0) return;
      await deps.sleep(100);
    }
    throw new Error(`Could not unload ${label}`);
  }
  function addSwap(path: string, staged: string) {
    swaps.push({ path, staged, backup: join(dirname(path), `.${basename(path)}.backup-${id}`), published: false, saved: false });
  }
  try {
    mkdirSync(work, { mode: 0o700 });
    const version = (await run([bun, "--version"])).trim();
    const [major, minor] = version.split(".").map(Number);
    if (!major || major < 1 || major === 1 && (minor ?? 0) < 3) throw new Error("Bun 1.3 or newer is required.");
    if (!options.app) await run(["/usr/bin/xcrun", "swift", "--version"]);
    for (const directory of [dirname(cli), dirname(app), dirname(agents[0]!), data]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (present(cli)) {
      if (!lstatSync(cli).isSymbolicLink()) throw new Error(`Refusing to overwrite a non-owned CLI file: ${cli}`);
      const target = resolve(dirname(cli), readlinkSync(cli));
      if (![join(runtime, "bin/quotapie"), join(source, "bin/quotapie")].includes(target)) {
        throw new Error(`Refusing to replace a CLI symlink owned by another installation: ${cli}`);
      }
    }
    if (present(runtime)) {
      if (!lstatSync(runtime).isDirectory() || lstatSync(runtime).isSymbolicLink()
          || !existsSync(join(runtime, "src/cli.ts")) || !existsSync(join(runtime, "bin/quotapie"))) {
        throw new Error(`Refusing to replace an unrecognized runtime: ${runtime}`);
      }
    }
    if (present(app) && (lstatSync(app).isSymbolicLink()
        || (await plist(join(app, "Contents/Info.plist"))).CFBundleIdentifier !== LABELS[1])) {
      throw new Error(`Refusing to replace an unrecognized app: ${app}`);
    }
    for (let index = 0; index < agents.length; index++) {
      if (!present(agents[index]!)) continue;
      const existing = await plist(agents[index]!);
      const allowed = index === 0 ? [cli, join(runtime, "bin/quotapie"), join(source, "bin/quotapie")]
        : [join(app, "Contents/MacOS/QuotaPie")];
      if (lstatSync(agents[index]!).isSymbolicLink() || existing.Label !== LABELS[index]
          || !allowed.includes(existing.ProgramArguments?.[0])) throw new Error(`Refusing to replace an unrecognized launch agent: ${agents[index]}`);
    }
    stageRuntime(source, stagedRuntime);
    const expectedHash = runtimeSourceHash(stagedRuntime);
    if (expectedHash !== runtimeSourceHash(source)) throw new Error("Runtime inputs changed while staging; retry installation.");
    if (options.app) {
      await run(["/usr/bin/ditto", resolve(options.app), stagedApp]);
    } else {
      console.log("Building the macOS app; the installed version remains running.");
      await run(["/bin/bash", join(source, "script/build_and_run.sh"), "bundle", join(work, "build")]);
      await run(["/usr/bin/ditto", join(work, "build/QuotaPie.app"), stagedApp]);
      await run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", join(stagedApp, "Contents/Helpers/QuotaPiePowerHelper")]);
      await run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", stagedApp]);
    }
    const appInfo = await plist(join(stagedApp, "Contents/Info.plist"));
    if (appInfo.CFBundleIdentifier !== LABELS[1] || appInfo.CFBundleExecutable !== "QuotaPie"
        || !statSync(join(stagedApp, "Contents/MacOS/QuotaPie")).isFile()) throw new Error("The supplied app is not QuotaPie.");
    await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", stagedApp]);
    const stagedConfig = join(work, "initial-config.json");
    if (!existsSync(config)) {
      await run([bun, join(stagedRuntime, "src/cli.ts"), "init"], { ...env, QUOTAPIE_CONFIG: stagedConfig });
    }
    const plannedConfig = existsSync(config) ? readFileSync(config, "utf8") : null;
    const loaded = loadConfig(existsSync(config) ? config : stagedConfig);
    const host = loaded.dashboard.host.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("The installer requires a loopback dashboard host.");
    const origin = `http://${host.includes(":") ? `[${host}]` : host}:${loaded.dashboard.port}`;
    const plistEnv = { ...env, QUOTAPIE_CONFIG: existsSync(config) ? config : stagedConfig };
    for (let index = 0; index < agents.length; index++) {
      const candidate = join(work, `${LABELS[index]}.plist`);
      writeFileSync(candidate, await run([bun, join(stagedRuntime, "src/cli.ts"), index ? "menubar-launchd" : "launchd"], plistEnv), { mode: 0o600 });
      const value = await plist(candidate);
      if (value.Label !== LABELS[index]) throw new Error("Unexpected generated launch agent label");
      value.ProgramArguments = index ? [join(app, "Contents/MacOS/QuotaPie")] : [join(runtime, "bin/quotapie"), "serve"];
      value.WorkingDirectory = index ? home : runtime;
      value.EnvironmentVariables = { ...value.EnvironmentVariables, BUN_BIN: bun, PATH: env.PATH,
        QUOTAPIE_CONFIG: config, QUOTAPIE_HOME: data, ...(index ? { QUOTAPIE_API_URL: origin } : {}) };
      value.StandardOutPath = join(data, index ? "menubar.log" : "service.log");
      value.StandardErrorPath = join(data, index ? "menubar.error.log" : "service.error.log");
      const staged = join(dirname(agents[index]!), `.${LABELS[index]}.install-${id}.plist`);
      addSwap(agents[index]!, staged);
      writeFileSync(staged, JSON.stringify(value), { mode: 0o600 });
      await run(["/usr/bin/plutil", "-convert", "xml1", "--", staged]);
      await run(["/usr/bin/plutil", "-lint", "--", staged]);
    }
    // Read the old process identities immediately before any service mutation.
    priorJobs = await Promise.all(LABELS.map(job));
    for (let index = 0; index < priorJobs.length; index++) {
      if (priorJobs[index]!.loaded && !existsSync(agents[index]!)) throw new Error(`Cannot restore loaded agent without its plist: ${LABELS[index]}`);
    }
    const oldRuntime = await deps.json(origin + "/api/runtime").catch(() => null);
    if (oldRuntime?.pid && oldRuntime.pid !== priorJobs[0]!.pid) throw new Error("A collector outside the managed launch agent is running. Stop that collector before installing.");
    const pids = await deps.run(["/usr/bin/pgrep", "-x", "QuotaPie"], env);
    if (pids.code === 0 && pids.stdout.trim().split(/\s+/).some(pid => Number(pid) !== priorJobs[1]!.pid)) {
      throw new Error("A QuotaPie app outside the managed launch agent is running. Quit that app before installing.");
    }
    checkCancelled();
    if (runtimeSourceHash(source) !== expectedHash) throw new Error("Sources changed during the build; retry installation.");
    if ((existsSync(config) ? readFileSync(config, "utf8") : null) !== plannedConfig) {
      throw new Error("Configuration changed during installation; retry without overwriting it.");
    }
    if (!existsSync(config)) {
      mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
      copyFileSync(stagedConfig, config, constants.COPYFILE_EXCL);
      chmodSync(config, 0o600);
      createdConfig = readFileSync(config, "utf8");
    }
    const stagedCLI = join(dirname(cli), `.quotapie-install-${id}`);
    symlinkSync(join(runtime, "bin/quotapie"), stagedCLI);
    addSwap(runtime, stagedRuntime); addSwap(app, stagedApp); addSwap(cli, stagedCLI);
    activationStarted = true;
    await stop(LABELS[1]); await stop(LABELS[0]);
    for (const swap of swaps) {
      checkCancelled();
      if (present(swap.path)) { renameSync(swap.path, swap.backup); swap.saved = true; }
      renameSync(swap.staged, swap.path); swap.published = true;
    }
    await run(["/bin/launchctl", "bootstrap", domain, agents[0]!]);
    let verified: { collectorPid: number; menuPid: number } | null = null;
    for (let attempt = 0; attempt < (options.attempts ?? 40); attempt++) {
      checkCancelled();
      const identity = await deps.json(origin + "/api/runtime").catch(() => null);
      const collector = await job(LABELS[0]);
      if (identity?.schemaVersion === 1 && identity.sourceHash === expectedHash && collector.pid
          && identity.pid === collector.pid && identity.pid !== priorJobs[0]!.pid
          && Number.isFinite(Date.parse(identity.startedAt ?? ""))) {
        const command = await run(["/bin/ps", "-p", String(collector.pid), "-o", "command="]);
        if (command.includes(join(runtime, "src/cli.ts"))) { verified = { collectorPid: collector.pid, menuPid: 0 }; break; }
      }
      await deps.sleep(250);
    }
    if (!verified) throw new Error("The installed collector did not report its expected runtime identity.");
    await run(["/bin/launchctl", "bootstrap", domain, agents[1]!]);
    for (let attempt = 0; attempt < (options.attempts ?? 40); attempt++) {
      checkCancelled();
      const menu = await job(LABELS[1]);
      if (menu.pid && menu.pid !== priorJobs[1]!.pid) {
        const command = await run(["/bin/ps", "-p", String(menu.pid), "-o", "comm="]);
        if (command.trim() === join(app, "Contents/MacOS/QuotaPie")) { verified.menuPid = menu.pid; break; }
      }
      await deps.sleep(250);
    }
    if (!verified.menuPid) throw new Error("The installed menu bar app did not start.");
    await deps.sleep(750);
    checkCancelled();
    const stableMenu = await job(LABELS[1]), stableCollector = await job(LABELS[0]);
    const stableIdentity = await deps.json(origin + "/api/runtime");
    if (stableMenu.pid !== verified.menuPid || stableCollector.pid !== verified.collectorPid
        || stableIdentity.pid !== verified.collectorPid || stableIdentity.sourceHash !== expectedHash
        || (await deps.run(["/bin/kill", "-0", String(verified.menuPid)], env)).code !== 0) {
      throw new Error("The installed app or collector exited during startup verification.");
    }
    const health = await deps.json(origin + "/health").catch(() => null);
    for (const swap of swaps) if (swap.saved) {
      try { rmSync(swap.backup, { recursive: true, force: true }); }
      catch { console.warn(`Installation verified; an old backup could not be removed: ${swap.backup}`); }
    }
    const accounts = Array.isArray(health?.accounts) ? health.accounts : [];
    const collection = health?.ok === true && accounts.length > 0 && accounts.every((a: any) => a.health === "recent-success") ? "ready"
      : !health ? "unverified" : !accounts.length || accounts.some((a: any) => a.health === "never-attempted"
        || ["auth-required", "auth-expired", "not-configured"].includes(a.errorCategory)) ? "setup-needed" : "degraded";
    return { installed: true, runtime, app, cli, config, data, sourceHash: expectedHash, ...verified,
      collection };
  } catch (error) {
    const failures: string[] = [];
    if (activationStarted) {
      for (const label of [...LABELS].reverse()) {
        try { await stop(label); } catch { failures.push(`unload ${label}`); }
      }
      // Never replace files while a newly started process could still use them.
      if (!failures.length) {
        for (const swap of [...swaps].reverse()) {
          try {
            if (swap.published) rmSync(swap.path, { recursive: true, force: true });
            if (swap.saved) renameSync(swap.backup, swap.path);
          } catch { failures.push(`restore ${swap.path}`); }
        }
        if (!failures.length) {
          for (let index = 0; index < priorJobs.length; index++) {
            if (!priorJobs[index]!.loaded) continue;
            try { await run(["/bin/launchctl", "bootstrap", domain, agents[index]!]); }
            catch { failures.push(`restart ${LABELS[index]}`); }
          }
        }
      }
    }
    if (!failures.length && createdConfig !== null && existsSync(config) && readFileSync(config, "utf8") === createdConfig) rmSync(config);
    rollbackFailed = failures.length > 0;
    if (rollbackFailed) throw new Error(`${error instanceof Error ? error.message : error}\nRecovery needs attention: ${failures.join(", ")}. Backups and transaction files retained at ${work}.`);
    throw error;
  } finally {
    if (!rollbackFailed) {
      for (const swap of swaps) if (present(swap.staged)) rmSync(swap.staged, { recursive: true, force: true });
      rmSync(stagedApp, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    if (args.length && (args.length !== 2 || args[0] !== "--app" || !args[1])) throw new Error("Usage: script/install.sh [--app /path/to/QuotaPie.app]");
    console.log(JSON.stringify(await installMacOS({ app: args[1] }, { signal: abort.signal }), null, 2));
  } catch (error) {
    console.error(`QuotaPie installation failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
