import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexProfileRoot, resolveUserPath, type AppConfig } from "./config";

export interface SessionStoreLocation { codexHome: string; appData: string }
export interface ConsolidationStatus {
  version: 1;
  state: "not-requested" | "waiting-for-source-exit" | "running" | "blocked" | "complete";
  reason?: string;
  source?: SessionStoreLocation;
  primary?: SessionStoreLocation;
  threadCount?: number;
  updatedAtMs: number;
}
interface Request {
  version: 1; account: string; source: SessionStoreLocation; primary: SessionStoreLocation;
  journalDirectory: string; requestedAtMs: number;
}
interface HelperResult {
  version: 1; state: "ready" | "waiting" | "blocked" | "complete";
  reason?: string; threadCount?: number; manifestPath?: string; manifestSHA256?: string;
  reportPath?: string; completedAtMs?: number;
}
interface Fence { assertHeldAndIdle(): void; release(): void; protectProcess?(pid:number):void }
export interface ConsolidationDependencies {
  home?: string;
  run?: (operation: "plan" | "apply", request: Request) => Promise<HelperResult>;
  acquireFence?: (requestKey:string) => Fence;
  recoverFence?: (requestKey:string) => Fence|null;
  quiesceSource?: (source: SessionStoreLocation) => Promise<() => void>;
  registeredSources?: () => SessionStoreLocation[];
  now?: () => number;
}

function ownedJSON(path: string, maximum = 65536): any {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const st=fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode&0o022)!==0 || st.size > maximum)
      throw new Error("consolidation-file-unverified");
    const bytes=readFileSync(fd),after=fstatSync(fd),named=lstatSync(path);
    if([after,named].some(value=>value.dev!==st.dev||value.ino!==st.ino||value.size!==st.size||value.mtimeMs!==st.mtimeMs||value.ctimeMs!==st.ctimeMs))
      throw new Error("consolidation-file-unverified");
    return JSON.parse(bytes.toString("utf8"));
  } finally {closeSync(fd);}
}
function atomicJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("consolidation-path-unverified");
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
    // Retirement must survive a crash before a completed routing marker can
    // become durable; persisting only the bytes does not order the renames.
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
async function runHelper(operation: "plan" | "apply", request: Request,protectProcess?:(pid:number)=>void): Promise<HelperResult> {
  const helper = fileURLToPath(new URL("../script/codex-session-consolidation.py", import.meta.url));
  const child = Bun.spawn(["/usr/bin/python3", "-B", helper, operation], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: "en_US.UTF-8" },
  });
  // The helper never stops a host. Killing this owned helper on service exit or
  // timeout is recoverable through its durable migration journal.
  const timer = setTimeout(() => child.kill(), 10 * 60_000);
  try {
    if(operation==="apply"){
      if(!protectProcess)throw new Error("consolidation-fence-helper-unverified");
      protectProcess(child.pid);
    }
    child.stdin.write(JSON.stringify({ version: 1, source: request.source, primary: request.primary,
      journalDirectory: request.journalDirectory }));
    child.stdin.end();
    let output = "";
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      if (output.length > 65536) throw new Error("consolidation-helper-output-invalid");
    }
    const result = JSON.parse(output);
    const code = await child.exited;
    if (result?.version !== 1 || !["ready", "waiting", "blocked", "complete"].includes(result.state)
        || (code !== 0 && result.state !== "blocked" && result.state !== "waiting"))
      throw new Error("consolidation-helper-output-invalid");
    return result;
  } finally { clearTimeout(timer); child.kill(); await child.exited; }
}

/** Explicitly enrolled, local migration. A collector tick retries a waiting
 * source without creating a chat automation or restarting either desktop app. */
export class SessionConsolidation {
  private readonly root: string;
  private readonly requestPath: string;
  private readonly statusPath: string;
  private readonly markerPath: string;
  private readonly retirementsPath: string;
  private readonly now: () => number;
  private pending: Promise<void> | null = null;
  private closed = false;
  constructor(private readonly config: AppConfig, private readonly deps: ConsolidationDependencies = {}) {
    this.root = join(deps.home ?? homedir(), "Library/Application Support/QuotaPie");
    this.requestPath = join(this.root, "session-consolidation-request.json");
    this.statusPath = join(this.root, "session-consolidation-status.json");
    this.markerPath = join(this.root, "session-consolidation.json");
    this.retirementsPath = join(this.root, "session-consolidation-retirements.json");
    this.now = deps.now ?? Date.now;
  }
  status(): ConsolidationStatus {
    try {
      const value = ownedJSON(this.statusPath);
      if (value?.version !== 1 || !["not-requested", "waiting-for-source-exit", "running", "blocked", "complete"].includes(value.state)) throw new Error();
      return value;
    } catch { return { version: 1, state: "not-requested", updatedAtMs: this.now() }; }
  }
  private primary(): SessionStoreLocation {
    const home = this.deps.home ?? homedir();
    return { codexHome: realpathSync(join(home, ".codex")), appData: realpathSync(join(home, "Library/Application Support/Codex")) };
  }
  private registeredSources(): SessionStoreLocation[] {
    if (this.deps.registeredSources) return this.deps.registeredSources();
    const preferences = join(this.deps.home ?? homedir(), "Library/Preferences/local.quotapie.menubar.plist");
    const result = Bun.spawnSync(["/usr/bin/python3", "-B", "-c",
      'import json,plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); v=json.loads(p["local.quotapie.codex-desktop-profiles.v1"]); print(json.dumps([{k:r[k] for k in ("codexHome","appData")} for r in v]))', preferences],
      { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    if (result.exitCode !== 0 || result.stdout.length > 65536) throw new Error("consolidation-profile-unverified");
    const values = JSON.parse(result.stdout.toString());
    if (!Array.isArray(values) || values.length > 128) throw new Error("consolidation-profile-unverified");
    return values;
  }
  private sourceRegistered(source: SessionStoreLocation): boolean {
    return this.registeredSources().filter(value => {
      try { return realpathSync(resolveUserPath(value.codexHome)) === source.codexHome && realpathSync(resolveUserPath(value.appData)) === source.appData; }
      catch { return false; }
    }).length === 1;
  }
  request(input: unknown): ConsolidationStatus {
    if (this.closed) throw new Error("consolidation-service-closing");
    const raw = input as any;
    if (!raw || Object.keys(raw).join() !== "source" || !raw.source ||
        Object.keys(raw.source).sort().join() !== "appData,codexHome" ||
        ![raw.source.codexHome, raw.source.appData].every(v => typeof v === "string" && v.startsWith("/") && v.length < 4096 && !v.includes("\0")))
      throw new Error("consolidation-invalid-source");
    const source = { codexHome: realpathSync(raw.source.codexHome), appData: realpathSync(raw.source.appData) };
    const primary = this.primary();
    const profiles = this.config.accounts.codex.filter(p => p.enabled && realpathSync(codexProfileRoot(p)) === source.codexHome);
    if (profiles.length !== 1 || !this.sourceRegistered(source) || [source.codexHome, source.appData].some(a =>
      [primary.codexHome, primary.appData].some(b => a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))))
      throw new Error("consolidation-source-unverified");
    const next: Request = { version: 1, account: profiles[0]!.id, source, primary,
      journalDirectory: join(this.root, "SessionConsolidation"), requestedAtMs: this.now() };
    if (existsSync(this.requestPath)) {
      const prior = ownedJSON(this.requestPath);
      if (JSON.stringify(prior.source) !== JSON.stringify(source) || JSON.stringify(prior.primary) !== JSON.stringify(primary))
        throw new Error("consolidation-already-pending");
      return this.status();
    }
    atomicJSON(this.requestPath, next);
    this.saveStatus(next, "waiting-for-source-exit", "source-status-check-pending");
    void this.tick();
    return this.status();
  }
  private saveStatus(request: Request, state: ConsolidationStatus["state"], reason?: string, threadCount?: number) {
    atomicJSON(this.statusPath, { version: 1, state, source: request.source, primary: request.primary,
      ...(reason ? { reason } : {}), ...(threadCount !== undefined ? { threadCount } : {}), updatedAtMs: this.now() });
  }
  tick(): Promise<void> {
    if (this.closed || !existsSync(this.requestPath)) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.execute().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async execute() {
    let request: Request | undefined, fence: Fence | undefined, resumeReaders: (() => void) | undefined;
    try {
      request = ownedJSON(this.requestPath);
      if (!request || request.version !== 1 || typeof request.account!=="string" || !request.account ||
          !Number.isSafeInteger(request.requestedAtMs) || request.requestedAtMs<=0 ||
          [request.source,request.primary].some(location=>!location||[location.codexHome,location.appData].some(path=>
            typeof path!=="string"||!path.startsWith("/")||path.length>=4096||path.includes("\0"))) ||
          request.journalDirectory !== join(this.root, "SessionConsolidation"))
        throw new Error("consolidation-binding-changed");
      // Recovery is independent of source readiness: an interrupted collector
      // must not leave unrelated work fenced while an open GUI delays copying.
      // This callback never creates a fence when there is nothing to recover.
      fence=this.deps.recoverFence?.(consolidationRequestKey(request))??undefined;
      if(fence){fence.release();fence=undefined;}
      if (JSON.stringify(request.primary) !== JSON.stringify(this.primary()) || !this.sourceRegistered(request.source) ||
          !this.config.accounts.codex.some(p => p.id === request!.account && p.enabled && realpathSync(codexProfileRoot(p)) === request!.source.codexHome))
        throw new Error("consolidation-binding-changed");
      const run = this.deps.run ?? ((operation:"plan"|"apply",request:Request)=>runHelper(operation,request,
        operation==="apply"&&fence?.protectProcess?(pid)=>fence!.protectProcess!(pid):undefined));
      let plan = await run("plan", request);
      // An open GUI host is always left alone. Only QuotaPie's own metadata
      // clients may be closed; the helper rechecks all other writers afterward.
      if (plan.state === "waiting" && ["source-client-running", "source-writer-running"].includes(plan.reason ?? "") &&
          this.deps.quiesceSource && this.deps.acquireFence) {
        fence = this.deps.acquireFence(consolidationRequestKey(request)); fence.assertHeldAndIdle();
        resumeReaders = await this.deps.quiesceSource(request.source);
        plan = await run("plan", request);
      }
      if (plan.state === "waiting" || plan.state === "blocked") {
        this.saveStatus(request, plan.state === "waiting" ? "waiting-for-source-exit" : "blocked", plan.reason, plan.threadCount); return;
      }
      if (this.closed) return;
      // No managed task may acquire a writer between the last inspection and
      // publication. This admission fence is released without changing settings.
      if (!this.deps.acquireFence) throw new Error("consolidation-admission-unavailable");
      fence ??= this.deps.acquireFence(consolidationRequestKey(request)); fence.assertHeldAndIdle();
      resumeReaders ??= await this.deps.quiesceSource?.(request.source);
      this.saveStatus(request, "running", undefined, plan.threadCount);
      const result = await run("apply", request);
      fence.assertHeldAndIdle();
      if (result.state !== "complete") {
        this.saveStatus(request, result.state === "waiting" ? "waiting-for-source-exit" : "blocked", result.reason, result.threadCount); return;
      }
      if (!result.manifestPath || !result.manifestSHA256 || !/^[a-f0-9]{64}$/.test(result.manifestSHA256) ||
          !result.manifestPath.startsWith(request.journalDirectory + "/")) throw new Error("consolidation-manifest-unverified");
      const manifest = ownedJSON(result.manifestPath,8*1024*1024);
      if (createHash("sha256").update(readFileSync(result.manifestPath)).digest("hex") !== result.manifestSHA256 ||
          manifest.version !== 1 || manifest.sourceHome !== request.source.codexHome || manifest.primaryHome !== request.primary.codexHome ||
          !Array.isArray(manifest.threadIds) || manifest.threadIds.length !== result.threadCount ||
          !manifest.threadIds.every((id:unknown)=>typeof id==="string"&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) ||
          new Set(manifest.threadIds).size!==manifest.threadIds.length)
        throw new Error("consolidation-manifest-unverified");
      const previous = existsSync(this.markerPath) ? ownedJSON(this.markerPath) : null;
      if (previous && (previous.version !== 1 || previous.state !== "complete" ||
        JSON.stringify(previous.primary) !== JSON.stringify(request.primary) || !Array.isArray(previous.sources)))
        throw new Error("consolidation-marker-unverified");
      const sources = (previous?.sources ?? []).filter((s: any) => s.codexHome !== request!.source.codexHome);
      sources.push({ ...request.source, manifestPath: result.manifestPath, manifestSHA256: result.manifestSHA256 });
      const retired=existsSync(this.retirementsPath)?ownedJSON(this.retirementsPath):{version:1,sources:[]};
      if(retired.version!==1||!Array.isArray(retired.sources)||retired.sources.length>128||retired.sources.some((source:any)=>
        !source||Object.keys(source).sort().join()!=="appData,codexHome"||
        [source.codexHome,source.appData].some(path=>typeof path!=="string"||realpathSync(path)!==path)))
        throw new Error("consolidation-retirements-unverified");
      const deny=new Map<string,SessionStoreLocation>(retired.sources.map((source:SessionStoreLocation)=>[JSON.stringify(source),source]));
      for(const source of sources){const entry={codexHome:source.codexHome,appData:source.appData};deny.set(JSON.stringify(entry),entry);}
      // A separate deny-only record survives marker loss or process restart.
      // It never grants redirection or continuation rights.
      atomicJSON(this.retirementsPath,{version:1,sources:[...deny.values()]});
      atomicJSON(this.markerPath, { version: 1, state: "complete", primary: request.primary, sources, completedAtMs: this.now() });
      this.saveStatus(request, "complete", undefined, result.threadCount);
      // A post-commit crash must retain the request until its exact durable
      // admission fence is released; the next collector can then recover it.
      fence.release();fence=undefined;
      resumeReaders?.();resumeReaders=undefined;
      unlinkSync(this.requestPath);
    } catch (error) {
      if (request) this.saveStatus(request, "blocked", error instanceof Error && /^consolidation-[a-z-]+$/.test(error.message)
        ? error.message : "consolidation-inspection-unavailable");
    } finally { try { fence?.release(); } finally { resumeReaders?.(); } }
  }
  async close() { this.closed = true; await this.pending; }
}

export function consolidationRequestKey(request:Request):string {
  return createHash("sha256").update(JSON.stringify({version:request.version,account:request.account,
    source:request.source,primary:request.primary,journalDirectory:request.journalDirectory,requestedAtMs:request.requestedAtMs})).digest("hex");
}
