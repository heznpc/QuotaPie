import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { codexProfileRoot, type AppConfig } from "./config";

export interface SessionLocationOptions {
  markerPath?: string;
  primaryHome?: string;
  primaryAppData?: string;
  nowMs?: number;
}
export interface CodexSessionLocation {
  /** The consent and subscription binding is never changed by consolidation. */
  account: string;
  /** Physical host/storage owner; never replaces the subscription consent. */
  ownerAccount: string;
  credentialRoot: string;
  sessionRoot: string;
  consolidated: boolean;
  /** null means this is an original store. A moved store is always bounded. */
  threadIds: ReadonlySet<string> | null;
  manifestSHA256?: string;
}
interface ConsolidationRoot { codexHome: string; appData: string }
interface ConsolidationSource extends ConsolidationRoot { manifestPath: string; manifestSHA256: string }
interface Consolidation {
  version: 1; state: "complete"; primary: ConsolidationRoot;
  sources: ConsolidationSource[]; completedAtMs: number;
}
export class SessionLocationUnavailableError extends Error {
  constructor() { super("session-location-unavailable"); this.name = "SessionLocationUnavailableError"; }
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const completedMarkers = new Map<string, Consolidation>();
const retiredMarkers = new Map<string, ConsolidationRoot[]>();
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const stable = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid;
const owned = (value: Stats) => value.uid === process.getuid?.() && (value.mode & 0o022) === 0;
function fail(): never { throw new SessionLocationUnavailableError(); }
function canonicalDirectory(raw: unknown): string {
  if (typeof raw !== "string" || !isAbsolute(raw) || raw.length > 4096 || resolve(raw) !== raw) return fail();
  const info = lstatSync(raw);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(raw) !== raw) return fail();
  return raw;
}
function privateJSON(path: string, maximum: number, base?: string): { value: any; sha256: string } {
  if (base) {
    const child = relative(base, path);
    if (!child || child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) return fail();
    let directory = dirname(path);
    while (true) {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) return fail();
      if (directory === base) break;
      const parent = dirname(directory); if (parent === directory) return fail(); directory = parent;
    }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !owned(before) || before.size <= 0 || before.size > maximum) return fail();
    const bytes = readFileSync(fd), after = fstatSync(fd), named = lstatSync(path);
    if (bytes.length !== before.size || !stable(before, after) || !stable(after, named)) return fail();
    return { value: JSON.parse(bytes.toString("utf8")), sha256: digest(bytes) };
  } finally { closeSync(fd); }
}
/** A retirement record denies reopening only. It never supplies thread IDs,
 * a destination, or permission to resume a conversation. */
function readRetirements(markerPath: string): ConsolidationRoot[] {
  const path=join(dirname(markerPath),"session-consolidation-retirements.json");
  let parsed:any;
  try { parsed=privateJSON(path,64*1024).value; }
  catch(error:any){if(error?.code==="ENOENT"&&!retiredMarkers.has(path))return[];return fail();}
  if(realpathSync(dirname(path))!==resolve(dirname(path)) || parsed?.version!==1 || !Array.isArray(parsed.sources) || parsed.sources.length>128)return fail();
  const sources:ConsolidationRoot[]=[],seen=new Set<string>();
  for(const source of parsed.sources){
    if(!source || typeof source.codexHome!=="string" || typeof source.appData!=="string" ||
      ![source.codexHome,source.appData].every(value=>isAbsolute(value)&&resolve(value)===value&&value.length<=4096) ||
      source.codexHome===source.appData || seen.has(source.codexHome)||seen.has(source.appData))return fail();
    seen.add(source.codexHome);seen.add(source.appData);sources.push({codexHome:source.codexHome,appData:source.appData});
  }
  if(retiredMarkers.get(path)?.some(previous=>!sources.some(source=>source.codexHome===previous.codexHome&&source.appData===previous.appData)))return fail();
  retiredMarkers.set(path,sources);return sources;
}
function readConsolidation(options: SessionLocationOptions): { value: Consolidation; directory: string } | null {
  const markerPath = options.markerPath ?? join(homedir(), "Library/Application Support/QuotaPie/session-consolidation.json");
  const retired=readRetirements(markerPath);
  let parsed: any;
  try { parsed = privateJSON(markerPath, 64 * 1024).value; }
  catch (error: any) { if (error?.code === "ENOENT" && !completedMarkers.has(markerPath)&&!retired.length) return null; return fail(); }
  // A preparation receipt never changes storage routing or permission.
  if (parsed?.version === 1 && parsed.state === "waiting-for-source-exit") return completedMarkers.has(markerPath)||retired.length ? fail() : null;
  if (parsed?.version !== 1 || parsed.state !== "complete" || !Array.isArray(parsed.sources) || parsed.sources.length > 128 ||
      !Number.isFinite(parsed.completedAtMs) || parsed.completedAtMs <= 0 || parsed.completedAtMs > (options.nowMs ?? Date.now())) return fail();
  const primaryHome = realpathSync(options.primaryHome ?? join(homedir(), ".codex"));
  const primaryAppData = realpathSync(options.primaryAppData ?? join(homedir(), "Library/Application Support/Codex"));
  if (canonicalDirectory(parsed.primary?.codexHome) !== primaryHome || canonicalDirectory(parsed.primary?.appData) !== primaryAppData) return fail();
  const homes = new Set<string>(), appData = new Set<string>(), directory = realpathSync(dirname(markerPath));
  const locations = [primaryHome, primaryAppData];
  if (directory !== resolve(dirname(markerPath))) return fail();
  for (const source of parsed.sources) {
    const home = canonicalDirectory(source?.codexHome), data = canonicalDirectory(source?.appData);
    if (home === primaryHome || data === primaryAppData || home === data || homes.has(home) || appData.has(data) ||
        typeof source.manifestPath !== "string" || !isAbsolute(source.manifestPath) || resolve(source.manifestPath) !== source.manifestPath ||
        typeof source.manifestSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(source.manifestSHA256)) return fail();
    for (const path of [home, data]) {
      if (locations.some(previous => path === previous || path.startsWith(previous + sep) || previous.startsWith(path + sep))) return fail();
      locations.push(path);
    }
    homes.add(home); appData.add(data);
  }
  if(retired.some(old=>!parsed.sources.some((source:ConsolidationSource)=>source.codexHome===old.codexHome&&source.appData===old.appData)))return fail();
  const previous = completedMarkers.get(markerPath);
  if (previous && (previous.primary.codexHome !== parsed.primary.codexHome || previous.primary.appData !== parsed.primary.appData || previous.sources.some(old =>
      !parsed.sources.some((source: ConsolidationSource) => source.codexHome === old.codexHome && source.appData === old.appData &&
        source.manifestPath === old.manifestPath && source.manifestSHA256 === old.manifestSHA256)))) return fail();
  completedMarkers.set(markerPath, parsed as Consolidation);
  return { value: parsed as Consolidation, directory };
}
function sourceThreads(source: ConsolidationSource, state: { value: Consolidation; directory: string }): ReadonlySet<string> {
  const file = privateJSON(source.manifestPath, 8 * 1024 * 1024, state.directory), value = file.value;
  if (file.sha256 !== source.manifestSHA256 || value?.version !== 1 || value.sourceHome !== source.codexHome ||
      value.primaryHome !== state.value.primary.codexHome || !Array.isArray(value.threadIds) || value.threadIds.length > 100_000 ||
      !value.threadIds.every((id: unknown) => typeof id === "string" && UUID.test(id)) ||
      new Set(value.threadIds).size !== value.threadIds.length) return fail();
  return new Set(value.threadIds);
}

/** Resolve local conversation storage without changing its credential/consent
 * account. A completed source cannot fall back to stale retired transcripts. */
export function codexSessionLocation(config: AppConfig, account: string, threadId?: string,
  options: SessionLocationOptions = {}): CodexSessionLocation | null {
  const profile = config.accounts.codex.find(value => value.id === account && value.enabled);
  if (!profile || threadId !== undefined && !UUID.test(threadId)) return null;
  try {
    const credentialRoot = realpathSync(codexProfileRoot(profile));
    const state = readConsolidation(options), source = state?.value.sources.find(value => value.codexHome === credentialRoot);
    // A renamed registration cannot reopen an old app-data directory as a new
    // Codex home. Only an exact verified source/manifest permits redirection.
    if(!source&&state?.value.sources.some(value=>value.appData===credentialRoot))return fail();
    if (!source || !state) return { account, ownerAccount: account, credentialRoot, sessionRoot: credentialRoot, consolidated: false, threadIds: null };
    const threadIds = sourceThreads(source, state);
    if (threadId !== undefined && !threadIds.has(threadId)) return null;
    const owners = config.accounts.codex.filter(candidate => {
      try { return realpathSync(codexProfileRoot(candidate)) === state.value.primary.codexHome; } catch { return false; }
    });
    if (owners.length !== 1) return fail();
    return { account, ownerAccount: owners[0]!.id, credentialRoot, sessionRoot: state.value.primary.codexHome, consolidated: true,
      threadIds, manifestSHA256: source.manifestSHA256 };
  } catch (error) {
    if (error instanceof SessionLocationUnavailableError) throw error;
    return fail();
  }
}

/** Metadata display ownership stays with the old account while its retired
 * files are excluded. This list grants no right to execute a conversation. */
export function codexSessionLocations(config: AppConfig, options: SessionLocationOptions = {}): CodexSessionLocation[] {
  return config.accounts.codex.filter(profile => profile.enabled).map(profile => codexSessionLocation(config, profile.id, undefined, options)!).filter(Boolean);
}

export interface CodexSessionOrigin {
  sessionRoot: string; account: string | null; enabled: boolean; label: string | null; threadIds: ReadonlySet<string>;
}
/** Used only for display provenance/deduplication, including disabled sources so
 * their preserved copies cannot acquire an unrelated enabled account's label. */
export function codexSessionOrigins(config: AppConfig, options: SessionLocationOptions = {}): CodexSessionOrigin[] {
  try {
    const state = readConsolidation(options); if (!state) return [];
    return state.value.sources.map(source => {
      const profiles = config.accounts.codex.filter(profile => {
        try { return realpathSync(codexProfileRoot(profile)) === source.codexHome; } catch { return false; }
      });
      const profile = profiles.length === 1 ? profiles[0] : undefined;
      return { sessionRoot: state.value.primary.codexHome, account: profile?.id ?? null,
        enabled: profile?.enabled === true, label: profile ? profile.nickname?.trim() || profile.label : null,
        threadIds: sourceThreads(source, state) };
    });
  } catch (error) { if (error instanceof SessionLocationUnavailableError) throw error; return fail(); }
}
