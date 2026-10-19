#!/usr/bin/env bun
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { RUNTIME_HASH_VERSION, runtimeSourceHash, type RuntimeHashVersion } from "../src/runtime-identity";
import { withRelaySettingsLock } from "../src/relay-settings";
import { InstallMaintenance } from "./install-maintenance";
import { signMacOSApp, verifyPrebuiltClaudeHelper } from "./sign-macos";

type Result = { code: number; stdout: string; stderr: string };
type Job = { loaded: boolean; pid: number | null };
type JsonOptions = { timeoutMs?: number; headers?: Record<string, string> };
export interface InstallDependencies {
  platform: string;
  uid: number;
  bun: string;
  env: Record<string, string | undefined>;
  run: (command: string[], env: Record<string, string | undefined>) => Promise<Result>;
  json: (url: string, options?: JsonOptions) => Promise<any>;
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
  async json(url, options) {
    const response = await fetch(url, { redirect: "error", headers: options?.headers,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 1500) });
    if (![200, 503].includes(response.status)) throw new Error("Local service unavailable");
    return response.json();
  },
  sleep: ms => Bun.sleep(ms),
};

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

function reportedHashVersion(identity: any): RuntimeHashVersion | null {
  if (!identity || typeof identity !== "object") return null;
  // Older collectors did not report a version. Do not try multiple algorithms
  // against a failed hash: the advertised version selects exactly one input set.
  if (!Object.hasOwn(identity, "hashVersion")) return 1;
  return identity.hashVersion === 1 || identity.hashVersion === RUNTIME_HASH_VERSION ? identity.hashVersion : null;
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
  for (const file of ["bin/quotapie", "src/cli.ts", "script/awake_hook.py", "script/codex-host-wake.py", "scripts/codex-compaction-local.py", "script/install.sh", "script/install-macos.ts", "packages/quota-core/src/index.ts", "packages/quota-core/package.json"]) {
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
  const relayRoot = join(home,".local/lib/quotapie-compaction"), relayManager = join(relayRoot,"manage.py");
  const relayWrapper = join(home,".local/bin/quotapie-compaction");
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
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, installationId:id, dataDirectory:data, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const work = join(dirname(runtime), `.quotapie-install-${id}`);
  const stagedRuntime = join(work, "runtime"), stagedApp = join(dirname(app), `.QuotaPie-install-${id}.app`);
  const swaps: Array<{ path: string; staged: string; backup: string; published: boolean; saved: boolean }> = [];
  let priorJobs: Job[] = [], activationStarted = false, createdConfig: string | null = null;
  const stoppedPids = new Map<string, Set<number>>();
  let rollbackFailed = false;
  let maintenance: InstallMaintenance | null = null;
  let previousIdentity: {origin:string;sourceHash:string;hashVersion:RuntimeHashVersion} | null = null;
  let managerSnapshot: {manager:string;wrapper:string;replacement:string} | null = null;
  const managerLockRelease: {release?:()=>void} = {};
  let managerLock: Promise<void> | null = null;
  const checkCancelled = () => { if (deps.signal?.aborted) throw new Error("Installation interrupted; previous installation restored."); };
  async function readInstallationState(url: string, options: JsonOptions = {}) {
    // An otherwise healthy collector can be briefly occupied at startup. Retry
    // transport failures only; callers still reject any returned wrong identity
    // or unrecognized work state. At most three five-second requests are made.
    for (let attempt = 0; attempt < 3; attempt++) {
      checkCancelled();
      try {
        const value = await deps.json(url, { ...options, timeoutMs: 5000 });
        checkCancelled();
        return value;
      } catch (error) {
        checkCancelled();
        if (attempt === 2) throw error;
        await deps.sleep(250);
      }
    }
    throw new Error("Installation state could not be read.");
  }
  async function assertNoManagedWork(origin: string, expectedPid: number | null) {
    try {
      const status = await readInstallationState(origin + "/api/status");
      if (typeof status?.actionToken !== "string" || !status.actionToken || status.actionToken.length > 256
          || !Array.isArray(status.jobs) || !Array.isArray(status.resumeTasks)) throw new Error("invalid-status");
      const autoResume = status.autoResume;
      if (Object.hasOwn(status, "autoResume") && (!autoResume || typeof autoResume !== "object" || Array.isArray(autoResume)
          || !Array.isArray(autoResume.accounts) || !Array.isArray(autoResume.incidents)
          || autoResume.accounts.some((account: any) => typeof account?.account !== "string" || !account.account.trim()
            || typeof account.enabled !== "boolean")
          || autoResume.incidents.some((incident: any) => !["waiting", "queued", "running", "resumed", "skipped", "needs-review"].includes(incident?.state))))
        throw new Error("invalid-work-state");
      // The status endpoint exposes only the most recent 100 legacy jobs. A
      // full page cannot prove that an older active job was not omitted.
      if (status.jobs.length >= 100) throw new Error("incomplete-job-status");
      const work = await readInstallationState(origin + "/api/work", { headers: { "x-quotapie-action-token": status.actionToken } });
      if (!Array.isArray(work?.policies) || !Array.isArray(work.executions)
          || work.policies.some((policy: any) => typeof policy?.enabled !== "boolean" || !policy.state
            || !(policy.state.activeExecutionId === null || typeof policy.state.activeExecutionId === "string"))
          || work.executions.some((execution: any) => !["claimed", "dispatched", "finished", "uncertain"].includes(execution?.status))
          || status.jobs.some((job: any) => !["waiting", "ready", "running", "review", "succeeded", "failed", "cancelled"].includes(job?.state))
          || status.resumeTasks.some((task: any) => !["waiting", "ready", "approved", "resumed", "dismissed"].includes(task?.state)))
        throw new Error("invalid-work-state");
      if (work.policies.some((policy: any) => policy.state.activeExecutionId !== null
            || policy.enabled && !maintenance?.covers(policy.provider,policy.account))
          || work.executions.some((execution: any) => execution.status !== "finished")
          || status.jobs.some((job: any) => ["waiting", "ready", "running", "review"].includes(job.state))
          || autoResume?.accounts.some((account: any) => account.enabled && !maintenance?.covers("codex",account.account)))
        throw new Error("managed-work-active");
      const collector = await job(LABELS[0]);
      if (!expectedPid || collector.pid !== expectedPid) throw new Error("collector-changed");
      maintenance?.assertHeldAndIdle();
    } catch (error) {
      if (error instanceof Error && error.message === "managed-work-active")
        throw new Error("Managed work is enabled, pending, running or uncertain. Disable scheduling and wait for execution to finish before installing.");
      if (error instanceof Error && error.message === "incomplete-job-status")
        throw new Error("The collector returned a full legacy-job page; older work may be omitted. The running installation was not stopped.");
      throw new Error("Managed work state could not be verified; the running installation was not stopped.");
    }
  }
  async function run(command: string[], customEnv = env, includeStderr = false) {
    const result = await deps.run(command, customEnv);
    if (result.code !== 0) throw new Error(`${basename(command[0]!)} failed: ${result.stderr.trim().slice(0, 2000) || result.stdout.trim().slice(0, 2000) || result.code}`);
    return result.stdout + (includeStderr ? result.stderr : "");
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
  function managerFile(path:string):string {
    const info=lstatSync(path);
    if(!info.isFile() || info.isSymbolicLink() || info.uid!==deps.uid)
      throw new Error("The installed relay manager ownership cannot be verified.");
    return readFileSync(path,"utf8");
  }
  function assertManagerUnchanged() {
    if(managerSnapshot && (managerFile(relayManager)!==managerSnapshot.manager || managerFile(relayWrapper)!==managerSnapshot.wrapper))
      throw new Error("The installed relay manager changed during installation; retry without overwriting it.");
  }
  async function assertManagerIdle() {
    const inventory=await run(["/bin/ps","-axo","pid=,uid=,command="]);
    if(!inventory.trim())throw new Error("Relay manager process inventory could not be verified.");
    const paths=[relayManager,relayWrapper,join(runtime,"scripts/codex-compaction-local.py"),join(source,"scripts/codex-compaction-local.py")];
    const matches=paths.map(path=>new RegExp("(?:^|\\s)[\"']?"+path.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"[\"']?(?:\\s|$)"));
    for(const line of inventory.split("\n")) {
      if(!line.trim())continue;
      const process=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if(!process)throw new Error("Relay manager process inventory could not be verified.");
      if(Number(process[2])===deps.uid && matches.some(pattern=>pattern.test(process[3]!)))
        throw new Error("A relay manager command is already running; retry after it finishes.");
    }
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
    if(present(relayManager)) {
      if(!lstatSync(relayRoot).isDirectory() || lstatSync(relayRoot).isSymbolicLink())
        throw new Error("The installed relay manager ownership cannot be verified.");
      const manager=managerFile(relayManager),wrapper=managerFile(relayWrapper);
      const command=/^#!\/bin\/sh\nexec '([^'\n]+)' '([^'\n]+)' "\$@"\n$/.exec(wrapper);
      if(!command || !command[1]!.startsWith("/") || !/\/python3(?:\.\d+)?$/.test(command[1]!)
          || command[2]!==relayManager || !manager.includes('LABEL = "local.quotapie.compaction"') || !manager.includes("class LocalRelay:"))
        throw new Error("The installed relay manager ownership cannot be verified.");
      const stagedManager=join(work,"manage.py"),replacement=readFileSync(join(stagedRuntime,"scripts/codex-compaction-local.py"),"utf8");
      writeFileSync(stagedManager,replacement,{mode:0o600,flag:"wx"});
      managerSnapshot={manager,wrapper,replacement};addSwap(relayManager,stagedManager);
    }
    const expectedHash = runtimeSourceHash(stagedRuntime);
    if (expectedHash !== runtimeSourceHash(source)) throw new Error("Runtime inputs changed while staging; retry installation.");
    if (options.app) {
      await run(["/usr/bin/ditto", resolve(options.app), stagedApp]);
    } else {
      console.log("Building the macOS app; the installed version remains running.");
      await run(["/bin/bash", join(source, "script/build_and_run.sh"), "bundle", join(work, "build")]);
      await run(["/usr/bin/ditto", join(work, "build/QuotaPie.app"), stagedApp]);
      await signMacOSApp(stagedApp, { run: command => run(command, env, true), identity: deps.env.SIGN_IDENTITY, previousApp: app });
    }
    const appInfo = await plist(join(stagedApp, "Contents/Info.plist"));
    if (appInfo.CFBundleIdentifier !== LABELS[1] || appInfo.CFBundleExecutable !== "QuotaPie"
        || !statSync(join(stagedApp, "Contents/MacOS/QuotaPie")).isFile()) throw new Error("The supplied app is not QuotaPie.");
    const desktopHelper = join(stagedApp, "Contents/Helpers/QuotaPieClaudeSessionHelper");
    if (!present(desktopHelper) || lstatSync(desktopHelper).isSymbolicLink() || !statSync(desktopHelper).isFile()) {
      throw new Error("The supplied app is missing its Claude desktop session helper.");
    }
    if (options.app) await verifyPrebuiltClaudeHelper(stagedApp, { run: command => run(command, env, true), previousApp: app });
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
    // Existing collectors already honor work_fences inside their claim
    // transaction. Keep consent, its timestamp and pending incidents unchanged.
    // The legacy job runner has no such gate: active legacy jobs still block
    // installation, and clients must not register new legacy jobs during it.
    if (priorJobs[0]!.loaded && existsSync(join(data,"quotapie.sqlite3"))) {
      const priorAgent = await plist(agents[0]!);
      const priorData = resolve(priorAgent.EnvironmentVariables?.QUOTAPIE_HOME ?? join(home,".local/share/quotapie"));
      if (!existsSync(priorData) || realpathSync(priorData)!==realpathSync(data))
        throw new Error("The running collector's data directory cannot be verified for maintenance.");
      const database=join(data,"quotapie.sqlite3");
      const openFiles=await deps.run(["/usr/sbin/lsof","-a","-p",String(priorJobs[0]!.pid),"-Fn","--",database],env);
      if(openFiles.code!==0 || !openFiles.stdout.split("\n").some(line=>{
        if(!line.startsWith("n"))return false;
        try{return realpathSync(line.slice(1))===realpathSync(database);}catch{return false;}
      })) throw new Error("The running collector's open database cannot be verified for maintenance.");
      const identity = await readInstallationState(origin + "/api/runtime");
      const hashVersion = reportedHashVersion(identity);
      if (identity?.schemaVersion!==1 || identity.pid!==priorJobs[0]!.pid || typeof identity.sourceHash!=="string"
          || hashVersion===null || identity.sourceHash!==runtimeSourceHash(runtime,hashVersion))
        throw new Error("The running collector's runtime identity cannot be verified for maintenance.");
      previousIdentity={origin,sourceHash:identity.sourceHash,hashVersion};
      maintenance=InstallMaintenance.acquire(database,id,
        (["codex","claude"] as const).flatMap(provider=>loaded.accounts[provider].map(account=>({provider,account:account.id}))));
    }
    if (priorJobs[0]!.loaded) await assertNoManagedWork(origin, priorJobs[0]!.pid);
    if(managerSnapshot) {
      let acquired!:()=>void;
      const locked=new Promise<void>(resolve=>{acquired=resolve;});
      const release=new Promise<void>(resolve=>{managerLockRelease.release=resolve;});
      managerLock=withRelaySettingsLock(relayRoot,async()=>{acquired();await release;});
      await Promise.race([locked,managerLock.then(()=>{throw new Error("Relay manager lock was not acquired.");})]);
      await assertManagerIdle();assertManagerUnchanged();
      if(priorJobs[0]!.loaded)await assertNoManagedWork(origin,priorJobs[0]!.pid);
    }
    checkCancelled();
    activationStarted = true;
    await stop(LABELS[1]); await stop(LABELS[0]);
    if(managerSnapshot) {await assertManagerIdle();assertManagerUnchanged();}
    for (const swap of swaps) {
      checkCancelled();
      if (present(swap.path)) { renameSync(swap.path, swap.backup); swap.saved = true; }
      renameSync(swap.staged, swap.path); swap.published = true;
    }
    if(managerSnapshot) await assertManagerIdle();
    await run(["/bin/launchctl", "bootstrap", domain, agents[0]!]);
    let verified: { collectorPid: number; menuPid: number } | null = null;
    for (let attempt = 0; attempt < (options.attempts ?? 40); attempt++) {
      checkCancelled();
      const identity = await deps.json(origin + "/api/runtime", { timeoutMs: 5000 }).catch(() => null);
      const collector = await job(LABELS[0]);
      if (identity?.schemaVersion === 1 && identity.hashVersion === RUNTIME_HASH_VERSION && identity.sourceHash === expectedHash && collector.pid
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
    let stableIdentity: any;
    try { stableIdentity = await readInstallationState(origin + "/api/runtime"); }
    catch { throw new Error("The installed collector did not report its expected runtime identity during startup stability verification."); }
    // Re-read launchd after a delayed HTTP response, rather than accepting the
    // process identities captured before the wait.
    const stableMenu = await job(LABELS[1]), stableCollector = await job(LABELS[0]);
    if (stableMenu.pid !== verified.menuPid || stableCollector.pid !== verified.collectorPid
        || stableIdentity?.schemaVersion !== 1 || stableIdentity.hashVersion !== RUNTIME_HASH_VERSION
        || stableIdentity.pid !== verified.collectorPid || stableIdentity.sourceHash !== expectedHash
        || !Number.isFinite(Date.parse(stableIdentity.startedAt ?? ""))
        || (await deps.run(["/bin/kill", "-0", String(verified.menuPid)], env)).code !== 0) {
      throw new Error("The installed app or collector exited during startup verification.");
    }
    const health = await deps.json(origin + "/health").catch(() => null);
    const accounts = Array.isArray(health?.accounts) ? health.accounts : [];
    const collection = health?.ok === true && accounts.length > 0 && accounts.every((a: any) => a?.health === "recent-success") ? "ready"
      : !health ? "unverified" : !accounts.length || accounts.some((a: any) => a?.health === "never-attempted"
        || ["auth-required", "auth-expired", "not-configured", "claude-code-unavailable", "access-denied"].includes(a?.errorCategory)) ? "setup-needed" : "degraded";
    if(managerSnapshot && (managerFile(relayManager)!==managerSnapshot.replacement || managerFile(relayWrapper)!==managerSnapshot.wrapper))
      throw new Error("The installed relay manager changed during startup verification.");
    maintenance?.assertHeldAndIdle();
    maintenance?.release(); maintenance=null;
    for (const swap of swaps) if (swap.saved) {
      try { rmSync(swap.backup, { recursive: true, force: true }); }
      catch { console.warn(`Installation verified; an old backup could not be removed: ${swap.backup}`); }
    }
    return { installed: true, runtime, app, cli, config, data, sourceHash: expectedHash, hashVersion: RUNTIME_HASH_VERSION, ...verified,
      collection };
  } catch (error) {
    const failures: string[] = [];
    if (activationStarted) {
      try { maintenance?.assertHeldAndIdle(); }
      catch { failures.push("verify idle maintenance before rollback; processes were not stopped"); }
      if (!failures.length) for (const label of [...LABELS].reverse()) {
        try { await stop(label); } catch { failures.push(`unload ${label}`); }
      }
      // Never replace files while a newly started process could still use them.
      if (!failures.length) {
        for (const swap of [...swaps].reverse()) {
          try {
            if(swap.path===relayManager && swap.published && managerFile(relayManager)!==managerSnapshot!.replacement)
              throw new Error("Relay manager changed after publication; preserved for manual recovery.");
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
          // Releasing the admission fence is itself a scheduling mutation.
          // Restore the verified old runtime before allowing it to claim work.
          if (!failures.length && maintenance && previousIdentity) {
            let restored=false;
            for(let attempt=0;attempt<(options.attempts??40);attempt++) {
              const identity=await deps.json(previousIdentity.origin+"/api/runtime",{timeoutMs:5000}).catch(()=>null);
              const collector=await job(LABELS[0]), menu=await job(LABELS[1]);
              if(identity?.schemaVersion===1 && identity.sourceHash===previousIdentity.sourceHash
                && reportedHashVersion(identity)===previousIdentity.hashVersion
                && !!collector.pid && identity.pid===collector.pid && Number.isFinite(Date.parse(identity.startedAt??""))
                && (!priorJobs[1]?.loaded || !!menu.pid)) {restored=true;break;}
              await deps.sleep(250);
            }
            if(!restored) failures.push("verify restored runtime before releasing maintenance");
          }
        }
      }
    }
    if (!failures.length && createdConfig !== null && existsSync(config) && readFileSync(config, "utf8") === createdConfig) rmSync(config);
    rollbackFailed = failures.length > 0;
    if (!rollbackFailed && maintenance) {
      try { maintenance.release(); maintenance=null; }
      catch { rollbackFailed=true; failures.push("release installation maintenance"); }
    }
    if (rollbackFailed) throw new Error(`${error instanceof Error ? error.message : error}\nRecovery needs attention: ${failures.join(", ")}. Backups and transaction files retained at ${work}.`);
    throw error;
  } finally {
    maintenance?.close();
    managerLockRelease.release?.();
    await managerLock?.catch(()=>{});
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
