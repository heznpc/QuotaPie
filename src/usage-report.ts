import { readCodexForkParent } from "./account-pool-lineage";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { homedir } from "node:os";
import { codexProfileRoot, resolveUserPath, dataDirectory, type AppConfig } from "./config";
import { parseCompactionRequestEvent, type CompactionRequestEvent } from "../packages/quota-core/src/events.js";

export interface UsageTotals {
  inputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number;
  reasoningTokens: number; totalTokens: number; requests: number; subagentTokens: number;
}
export interface UsageActivity { localCompactions: number; compactions: number; retries: number; failedRequests: number; attributedRequestTokens: number;
  unattributedRequestTokens: number; compactionTokens: number; retryTokens: number; requestsWithoutUsage: number }
export interface UsageBucket extends UsageTotals {
  quotapieCandidateEvidence?: "thread_title" | "inherited_title" | "parent_repository"; models?: UsageBucket[]; parentSessionId?: string; repositoryUrl?: string; quotapieEvidence?: "session_git_repository_url"; uncachedInputTokens?: number;
  activity?: UsageActivity;
  id: string; label: string; fromMs?: number; toMs?: number; provider?: string; account?: string;
  accountLabel?: string; resetAtMs?: number; startClipped?: boolean; sessionId?: string; model?: string; isSubagent?: boolean; previousTotalTokens?: number; bucket?: string; resetKind?: "scheduled_reset" | "external_relief";
}
export interface UsageResetBoundary { atMs: number; provider: string; account: string; bucket: string; label: string; kind?: "scheduled_reset" | "external_relief" }
export interface UsageReport {
  consumption?: { basis: "local_observed_tokens"; quotaPercent: null;
    quotapie: { development: UsageTotals; developmentSessionIds: string[]; candidates: UsageTotals; candidateSessionIds: string[]; evidence: "session_git_repository_url"; relay: UsageActivity; quotaPercent: null; note: string };
    conversations: UsageBucket[]; subagents: UsageBucket[] };
  generatedAtMs: number; fromMs: number; toMs: number; timeZone: string;
  relayModels?: UsageBucket[]; total: UsageTotals; previous: UsageTotals; days: UsageBucket[]; models: UsageBucket[]; sessions: UsageBucket[]; resetPeriods: UsageBucket[];
  coverage: { compressedFilesSkipped?: number; filesScanned: number; filesPending: number; filesSkipped: number; malformedLines: number;
    unknownModelTokens: number; relayFirstObservedAtMs: number | null; relayLastObservedAtMs: number | null; firstObservedAtMs: number | null; lastObservedAtMs: number | null; notes: string[] };
  activity: UsageActivity;
}
export interface UsageReportQuery {
  fromMs: number; toMs: number; timeZone?: string; provider?: string; account?: string; relayRoot?: string; resetBoundaries?: readonly UsageResetBoundary[];
  requestEvents?: readonly CompactionRequestEvent[];
}
interface Options { maxBytesPerScan?: number; maxFiles?: number; maxRecordsPerFile?: number; inventoryTtlMs?: number; relayRoot?: string | null; relayLogsRoot?: string | null }
type Provider = "codex" | "claude" | "relay";
interface Source { path: string; root: string; provider: Provider; account: string; accountLabel: string }
interface Usage extends UsageTotals { key: string; at: number; model: string; session: string; project: string; helper: boolean; repositoryUrl?: string; parentSessionId?: string; agentName?: string }
interface Cache { source: Source; identity: string; offset: number; mtime: number; size: number; skipLine: boolean;
  session: string; model: string; project: string; helper: boolean; repositoryUrl?: string; parentSessionId?: string; agentName?: string; forkAt?: number; baseline?: UsageTotals;
  compactions: Map<string, {at: number; session: string; project: string; helper: boolean}>; records: Map<string, Usage>; events: Map<string, CompactionRequestEvent>; malformed: number; capped: boolean; complete: boolean }
interface ScanHandle { file: FileHandle; cache: Cache; size: number }
const emptyActivity = (): UsageActivity => ({ localCompactions: 0, compactions: 0, retries: 0, failedRequests: 0, attributedRequestTokens: 0,
  unattributedRequestTokens: 0, compactionTokens: 0, retryTokens: 0, requestsWithoutUsage: 0 });
function addActivity(a: UsageActivity, e: CompactionRequestEvent, attributed: boolean) {
  if (e.kind === "compaction") a.compactions++;
  a.retries += e.retryCount ?? 0; if (e.phase === "failed") a.failedRequests++;
  const total = e.usage ? e.usage.input + e.usage.output : 0;
  if (!e.usage) a.requestsWithoutUsage++;
  if (attributed) a.attributedRequestTokens += total; else a.unattributedRequestTokens += total;
  if (e.kind === "compaction") a.compactionTokens += total;
  if (e.retryCount) a.retryTokens += total;
}
const zero = (): UsageTotals => ({ inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0, subagentTokens: 0 });
const keys = Object.keys(zero()) as (keyof UsageTotals)[];
const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const safe = (v: unknown, fallback = "unknown") => typeof v === "string" && /^[\p{L}\p{N}_. -]{1,100}$/u.test(v) ? v : fallback;
const validId = (v: unknown) => typeof v === "string" && /^[a-z0-9_-]{1,100}$/i.test(v) ? v : "";
const stamp = (v: unknown) => typeof v === "string" ? Date.parse(v) : NaN;
const contained = (root: string, path: string) => { const r = relative(root, path); return r !== ".." && !r.startsWith("../") && !r.startsWith("/"); };
function add(a: UsageTotals, b: UsageTotals) { for (const k of keys) a[k] += b[k]; }
function tokens(v: any, claude = false): UsageTotals | undefined {
  if (!v || typeof v !== "object") return;
  const input = count(v.input_tokens), output = count(v.output_tokens), cached = count(claude ? v.cache_read_input_tokens : v.cached_input_tokens);
  const created = claude ? count(v.cache_creation_input_tokens) : 0;
  if (!["total_tokens", "input_tokens", "output_tokens", "cache_read_input_tokens"].some(k => typeof v[k] === "number")) return;
  return { ...zero(), inputTokens: input + (claude ? cached + created : 0), cachedInputTokens: cached,
    cacheCreationTokens: created, outputTokens: output, reasoningTokens: count(v.reasoning_output_tokens),
    totalTokens: claude ? input + cached + created + output : count(v.total_tokens ?? input + output) };
}
// Project only metadata fields. The scanner never decodes or caches prompt/tool content.
function fields(input: string, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {}; const allow = new Set(allowed); let i = 0;
  const ws = () => { while (i < input.length && /\s/.test(input[i]!)) i++; };
  const quoteEnd = (start: number) => { let end = input.indexOf('"', start + 1); while (end >= 0) {
    let n = 0; for (let p = end - 1; p > start && input[p] === "\\"; p--) n++; if (!(n % 2)) return end + 1; end = input.indexOf('"', end + 1);
  } return input.length; };
  ws(); if (input[i++] !== "{") return result;
  while (i < input.length) { ws(); if (input[i] !== '"') break; const start = i; i = quoteEnd(i);
    let key: string; try { key = JSON.parse(input.slice(start, i)); } catch { break; }
    ws(); if (input[i++] !== ":") break; ws(); const valueStart = i; let depth = 0;
    for (; i < input.length; i++) { const c = input[i]; if (c === '"') i = quoteEnd(i) - 1;
      else if (c === "{" || c === "[") depth++; else if (c === "}" || c === "]") { if (!depth) break; depth--; }
      else if (c === "," && !depth) break; }
    if (allow.has(key)) result[key] = input.slice(valueStart, i); ws(); if (input[i] === ",") i++; else break;
  } return result;
}
function decode(v?: string): any { try { return v == null ? undefined : JSON.parse(v); } catch { return; } }
function projection(line: string, cache: Cache) {
  if (cache.source.provider === "relay") {
    if (!line.includes('"requestId"')) return;
    if (!line.trimEnd().endsWith("}")) { cache.malformed++; return; }
    // Relay logs already contain projected metadata, not transcript bodies.
    const start = line.indexOf("{"); const event = parseCompactionRequestEvent(decode(line.slice(start)));
    if (event) { const old = cache.events.get(event.requestId); if (!old || stamp(old.at) <= stamp(event.at)) cache.events.set(event.requestId, event); }
    return;
  }
  if (!line.trimEnd().endsWith("}")) { cache.malformed++; return; }
  if (cache.source.provider === "codex" && /"type"\s*:\s*"response_item"/.test(line.slice(0, 512))) return;
  const top = fields(line, ["type", "timestamp", "payload", "sessionId", "cwd", "isSidechain", "message", "uuid"]);
  const type = decode(top.type), at = stamp(decode(top.timestamp));
  if (cache.source.provider === "codex") {
    if (type === "compacted") {
      if (cache.session && Number.isFinite(at) && (cache.forkAt == null || at > cache.forkAt)) cache.compactions.set(`${cache.session}:${at}`, {at, session:cache.session, project:cache.project, helper:cache.helper});
      return;
    }
    if (!["session_meta", "turn_context", "event_msg"].includes(type)) return;
    const p = fields(top.payload ?? "", ["id", "cwd", "source", "git", "agent_nickname", "agent_path", "forked_from_id", "model", "type", "info"]);
    if (type === "session_meta" && !cache.session) {
      cache.session = validId(decode(p.id)); cache.project = safe(basename(String(decode(p.cwd) ?? "")), "Project");
      const git = decode(p.git); const repository = git?.repository_url;
      if (typeof repository === "string" && /^(?:https:\/\/github\.com\/|git@github\.com:)heznpc\/QuotaPie(?:\.git)?\/?$/i.test(repository)) cache.repositoryUrl = "https://github.com/heznpc/QuotaPie";
      const source = decode(p.source); cache.parentSessionId = validId(source?.subagent?.thread_spawn?.parent_thread_id) || undefined;
      const spawn = source?.subagent?.thread_spawn;
      const agentPath = decode(p.agent_path) ?? spawn?.agent_path;
      const nickname = decode(p.agent_nickname) ?? spawn?.agent_nickname;
      cache.agentName = [typeof agentPath === "string" ? agentPath.slice(0,150) : null, typeof nickname === "string" ? nickname.slice(0,80) : null].filter(Boolean).join(" · ") || undefined;
      cache.helper = source === "subagent" || !!(source && typeof source === "object" && source.subagent);
      if (validId(decode(p.forked_from_id)) && Number.isFinite(at)) cache.forkAt = at;
      return;
    }
    if (type === "turn_context") { cache.model = safe(decode(p.model)); return; }
    if (type !== "event_msg" || decode(p.type) !== "token_count" || !Number.isFinite(at)) return;
    const info = fields(p.info ?? "", ["total_token_usage", "last_token_usage"]);
    const total = tokens(decode(info.total_token_usage)), last = tokens(decode(info.last_token_usage)); if (!total) return;
    let delta = zero();
    if (cache.baseline) {
      if (total.totalTokens >= cache.baseline.totalTokens) { for (const k of keys) delta[k] = Math.max(0, total[k] - cache.baseline[k]); }
      else if (last) delta = last;
    } else if (cache.forkAt == null) delta = { ...total };
    else if (at > cache.forkAt && last) delta = { ...last };
    cache.baseline = total;
    if (cache.forkAt != null && at < cache.forkAt) return;
    if (!delta.totalTokens || !cache.session) return;
    delta.requests = 1; delta.subagentTokens = cache.helper ? delta.totalTokens : 0;
    const key = `${cache.session}:${at}:${total.totalTokens}`;
    cache.records.set(key, { ...delta, key, at, model: cache.model || "unknown", session: cache.session, project: cache.project, helper: cache.helper, repositoryUrl: cache.repositoryUrl, parentSessionId: cache.parentSessionId, agentName: cache.agentName });
  } else {
    const id = validId(decode(top.sessionId)); if (!cache.session) cache.session = basename(cache.source.path).startsWith("agent-") ? basename(cache.source.path, ".jsonl") : id;
    cache.helper ||= decode(top.isSidechain) === true || basename(cache.source.path).startsWith("agent-") || cache.source.path.includes("/subagents/");
    cache.project = safe(basename(String(decode(top.cwd) ?? "")), cache.project || "Project");
    if (type !== "assistant" || !Number.isFinite(at)) return;
    const m = fields(top.message ?? "", ["id", "model", "usage"]); const messageId = decode(m.id) ?? decode(top.uuid);
    const total = tokens(decode(m.usage), true); if (!total || typeof messageId !== "string" || !cache.session) return;
    total.requests = 1; total.subagentTokens = cache.helper ? total.totalTokens : 0;
    const key = hash(messageId), old = cache.records.get(key);
    if (!old || old.totalTokens <= total.totalTokens) cache.records.set(key, { ...total, key, at, model: safe(decode(m.model)), session: cache.session, project: cache.project, helper: cache.helper, repositoryUrl: cache.repositoryUrl, parentSessionId: cache.parentSessionId, agentName: cache.agentName });
  }
}

/** Read-only incremental metadata index. A pass yields after bounded chunks; callers
 * poll while filesPending > 0. Raw transcript strings never survive a read. */
export class UsageReportIndex {
  private caches = new Map<string, Cache>(); private inventory: Source[] = []; private inventoryAt = 0; private inventoryKey = "";
  private compressedSkipped = 0; private skipped = 0; private failedPaths = new Set<string>(); private pending?: Promise<UsageReport>; private cursor = 0;
  private options: Required<Options>;
  constructor(options: Options = {}) { this.options = { maxBytesPerScan: 64 * 1024 * 1024, maxFiles: 10000, maxRecordsPerFile: 100000,
    inventoryTtlMs: 30000, relayRoot: join(homedir(), ".local/lib/quotapie-compaction"), relayLogsRoot: join(dataDirectory(), "relay-logs"), ...options }; }
  async report(config: AppConfig, query: UsageReportQuery): Promise<UsageReport> {
    if (!Number.isFinite(query.fromMs) || !Number.isFinite(query.toMs) || query.fromMs >= query.toMs) throw new Error("Invalid usage range");
    if (this.pending) await this.pending;
    const run = this.collect(config, query); this.pending = run;
    try { return await run; } finally { if (this.pending === run) this.pending = undefined; }
  }
  private async discover(config: AppConfig, relayRoot?: string) {
    const key = JSON.stringify([config.accounts, relayRoot]); if (key === this.inventoryKey && Date.now() - this.inventoryAt < this.options.inventoryTtlMs) return;
    this.skipped = 0; this.compressedSkipped = 0; this.failedPaths.clear(); const inventory: Source[] = [], roots = new Set<string>();
    const visit = async (dir: string, source: Omit<Source, "path">, depth = 0): Promise<void> => {
      if (depth > 7) { this.skipped++; return; } let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.skipped++; return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; const path = join(dir, entry.name);
        if (inventory.length >= this.options.maxFiles) { this.skipped++; continue; }
        if (entry.isFile() && entry.name.endsWith(".jsonl.zst")) { this.compressedSkipped++; continue; }
        if (entry.isDirectory()) await visit(path, source, depth + 1);
        else if (entry.isFile() && (source.provider === "relay" ? /(?:relay\.log(?:\.\d+)?|\.jsonl(?:\.\d+)?)$/.test(entry.name) : entry.name.endsWith(".jsonl"))) inventory.push({ ...source, path });
      }
    };
    for (const provider of ["codex", "claude"] as const) for (const account of config.accounts[provider]) {
      if (!account.enabled) continue; let root: string;
      try { root = await realpath(provider === "codex" ? codexProfileRoot(account as AppConfig["accounts"]["codex"][number]) : resolveUserPath((account as AppConfig["accounts"]["claude"][number]).configDir)); } catch { this.skipped++; continue; }
      if (roots.has(`${provider}:${root}`)) continue; roots.add(`${provider}:${root}`);
      const source = { root, provider, account: account.id, accountLabel: account.nickname?.trim() || account.label };
      for (const folder of provider === "codex" ? ["sessions", "archived_sessions"] : ["projects"]) await visit(join(root, folder), source);
    }
    for (const relay of [relayRoot ?? this.options.relayRoot, this.options.relayLogsRoot]) if (relay) {
      try {
        const root = await realpath(relay); const source = { root, provider: "relay" as const, account: "", accountLabel: "" };
        if (relay === this.options.relayLogsRoot) await visit(root, source);
        else {
          const directories = [root];
          try { for (const e of await readdir(join(root, "releases"), { withFileTypes: true })) if (e.isDirectory() && /^\d+$/.test(e.name)) directories.push(join(root, "releases", e.name)); } catch {}
          for (const directory of directories) {
            for (const e of await readdir(directory, { withFileTypes: true })) if (e.isFile() && /^relay\.log(?:\.\d+)?$/.test(e.name)) inventory.push({ ...source, path: join(directory, e.name) });
          }
        }
      } catch { /* Relay not installed. */ }
    }
    this.inventory = inventory; this.inventoryAt = Date.now(); this.inventoryKey = key;
    const paths = new Set(inventory.map(s => s.path)); for (const path of this.caches.keys()) if (!paths.has(path)) this.caches.delete(path);
  }
  private async scan(source: Source, budget: number, handles: Map<string, ScanHandle>): Promise<number> {
    let held = handles.get(source.path);
    if (!held) {
      const path = await realpath(source.path); if (!contained(source.root, path)) throw new Error("Outside configured profile");
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat(), identity = `${info.dev}:${info.ino}`; let cache = this.caches.get(path);
        if (!cache || cache.identity !== identity || info.size < cache.offset || (info.size === cache.size && cache.mtime !== info.mtimeMs)) {
          cache = { source, identity, offset: 0, mtime: 0, size: 0, skipLine: false, session: "", model: "unknown", project: "Project", helper: false,
            compactions: new Map(), records: new Map(), events: new Map(), malformed: 0, capped: false, complete: false }; this.caches.set(path, cache);
        }
        if (cache.complete && cache.size === info.size && cache.mtime === info.mtimeMs) { await file.close(); return 0; }
        cache.source = source; cache.size = info.size; cache.mtime = info.mtimeMs;
        held = { file, cache, size: info.size }; handles.set(source.path, held);
      } catch (error) { await file.close(); throw error; }
    }
    const {file,cache,size} = held;
    try {
      const length = Math.min(budget, 4 * 1024 * 1024, size - cache.offset);
      if (!length) { cache.complete = true; return 0; }
      const buffer = Buffer.alloc(length); const { bytesRead } = await file.read(buffer, 0, length, cache.offset); const bytes = buffer.subarray(0, bytesRead);
      const end = bytes.lastIndexOf(10) + 1;
      if (!end) { const reachedEof = cache.offset + bytesRead >= size; if (bytesRead === 4 * 1024 * 1024) { cache.skipLine = true; cache.malformed++; cache.offset += bytesRead; } cache.complete = cache.offset >= size || bytesRead < length || reachedEof; return bytesRead; }
      const lines = bytes.subarray(0, end).toString("utf8").split("\n"); lines.pop(); if (cache.skipLine) { lines.shift(); cache.skipLine = false; }
      for (const line of lines) {
        projection(line, cache);
        if (cache.records.size > this.options.maxRecordsPerFile) { cache.records.delete(cache.records.keys().next().value!); cache.capped = true; }
        if (cache.compactions.size > this.options.maxRecordsPerFile) { cache.compactions.delete(cache.compactions.keys().next().value!); cache.capped = true; }
        if (cache.events.size > this.options.maxRecordsPerFile) { cache.events.delete(cache.events.keys().next().value!); cache.capped = true; }
      }
      cache.offset += end; cache.complete = cache.offset >= size;
      // The stat captured when opening is this pass's snapshot. Appends and
      // rotations are checked on the next pass, without restatting every chunk.
      if (bytesRead < length || bytesRead === size - (cache.offset - end)) cache.complete = true;
      await new Promise(resolve => setTimeout(resolve, 0)); return bytesRead;
    } finally {
      if (cache.complete) { handles.delete(source.path); await file.close(); }
    }
  }
  private async collect(config: AppConfig, query: UsageReportQuery): Promise<UsageReport> {
    await this.discover(config, query.relayRoot); let budget = this.options.maxBytesPerScan;
    const handles = new Map<string, ScanHandle>();
    const unfinished: Source[] = [];
    const read = async (source: Source): Promise<number> => {
      if (this.failedPaths.has(source.path)) return 0;
      try { const bytes = await this.scan(source, budget, handles); budget -= bytes; return bytes; }
      catch { this.failedPaths.add(source.path); return 0; }
    };
    try {
      // Check every source at most once per pass. Once only a few large logs
      // remain, do not reopen thousands of completed logs for each 4 MB chunk.
      for (let i = 0; i < this.inventory.length && budget > 0; i++) {
        const source = this.inventory[this.cursor % this.inventory.length]!; this.cursor = (this.cursor + 1) % this.inventory.length;
        await read(source);
        if (handles.has(source.path) && !this.failedPaths.has(source.path)) unfinished.push(source);
      }
      while (unfinished.length && budget > 0) {
        const source = unfinished.shift()!;
        const bytes = await read(source);
        if (bytes && handles.has(source.path) && !this.failedPaths.has(source.path)) unfinished.push(source);
      }
    } finally {
      await Promise.all([...handles.values()].map(held => held.file.close()));
    }
    const timeZone = query.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone; const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const result: UsageReport = { generatedAtMs: Date.now(), fromMs: query.fromMs, toMs: query.toMs, timeZone,
      total: zero(), previous: zero(), days: [], models: [], sessions: [], resetPeriods: [],
      coverage: { compressedFilesSkipped: this.compressedSkipped, filesScanned: [...this.caches.values()].filter(c => c.complete).length, filesPending: this.inventory.filter(s => !this.failedPaths.has(s.path) && !this.caches.get(s.path)?.complete).length,
        filesSkipped: this.skipped + this.failedPaths.size, malformedLines: 0, unknownModelTokens: 0, relayFirstObservedAtMs: null, relayLastObservedAtMs: null, firstObservedAtMs: null, lastObservedAtMs: null, notes: [] },
      activity: { localCompactions: 0, compactions: 0, retries: 0, failedRequests: 0, attributedRequestTokens: 0, unattributedRequestTokens: 0, compactionTokens: 0, retryTokens: 0, requestsWithoutUsage: 0 } };
    const localCompactions = new Map<string, {source:Source; at:number; session:string; project:string; helper:boolean}>();
    const records = new Map<string, { source: Source; usage: Usage }>(), requests = new Map<string, CompactionRequestEvent>();
    for (const cache of this.caches.values()) {
      result.coverage.malformedLines += cache.malformed; if (cache.capped) result.coverage.filesSkipped++;
      for (const usage of cache.records.values()) { const key = `${cache.source.provider}:${usage.key}`, old = records.get(key);
        const source = old && old.source.account !== cache.source.account ? { ...cache.source, account: "unknown", accountLabel: "계정 귀속 불명" } : cache.source;
        if (!old || old.usage.totalTokens < usage.totalTokens || source.account === "unknown") records.set(key, { source, usage: old && old.usage.totalTokens > usage.totalTokens ? old.usage : usage }); }
      for (const [id, marker] of cache.compactions) {
        const key = `${cache.source.provider}:${id}`, old = localCompactions.get(key);
        const source = old && old.source.account !== cache.source.account ? {...cache.source,account:"unknown",accountLabel:"계정 귀속 불명"} : cache.source;
        localCompactions.set(key, {source, ...marker});
      }
      for (const e of cache.events.values()) { const old = requests.get(e.requestId); if (!old || stamp(old.at) <= stamp(e.at)) requests.set(e.requestId, e); }
    }
    for (const e of query.requestEvents ?? []) { const old = requests.get(e.requestId); if (!old || stamp(old.at) <= stamp(e.at)) requests.set(e.requestId, e); }
    const threadOwners = new Map<string, Map<string, Source>>();
    for (const {source,usage} of records.values()) {
      const owners = threadOwners.get(usage.session) ?? new Map<string, Source>(); owners.set(`${source.provider}:${source.account}`, source); threadOwners.set(usage.session, owners);
    }
    const days = new Map<string, UsageBucket>(), models = new Map<string, UsageBucket>(), sessions = new Map<string, UsageBucket>();
    const previousFrom = query.fromMs - (query.toMs - query.fromMs);
    const resetGroups = new Map<string, UsageResetBoundary[]>();
    for (const boundary of query.resetBoundaries ?? []) { if (query.provider && (boundary.provider !== query.provider || boundary.account !== query.account)) continue; const key = `${boundary.provider}:${boundary.account}:${boundary.bucket}`; const list = resetGroups.get(key) ?? []; list.push(boundary); resetGroups.set(key, list); }
    for (const [key, boundaries] of resetGroups) {
      const sorted = [...new Map(boundaries.map(b => [b.atMs, b])).values()].sort((a,b) => a.atMs - b.atMs), first = sorted[0]!;
      const points = [...new Set([query.fromMs, ...sorted.map(b => b.atMs).filter(at => at > query.fromMs && at < query.toMs), query.toMs])].sort((a,b) => a-b);
      for (let i = 0; i < points.length - 1; i++) { const from = points[i]!, to = points[i + 1]!, prior = sorted.filter(b => b.atMs <= from).at(-1), observed = !!prior;
        result.resetPeriods.push({ ...zero(), id: `${key}:${from}`, label: `${prior?.label ?? first.label}${observed ? "" : " · 시작 경계 미관측"}`, provider: first.provider, account: first.account, bucket: first.bucket, resetKind: prior?.kind, resetAtMs: prior?.atMs, startClipped: prior != null && prior.atMs < from,
          accountLabel: config.accounts[first.provider as "codex" | "claude"]?.find(p => p.id === first.account)?.nickname?.trim() || config.accounts[first.provider as "codex" | "claude"]?.find(p => p.id === first.account)?.label || first.account, fromMs: from, toMs: to }); }
    }
    for (const { source, usage: u } of records.values()) {
      if (query.provider && (source.provider !== query.provider || source.account !== query.account)) continue;
      if (u.at < previousFrom || u.at >= query.toMs) continue;
      result.coverage.firstObservedAtMs = Math.min(result.coverage.firstObservedAtMs ?? u.at, u.at); result.coverage.lastObservedAtMs = Math.max(result.coverage.lastObservedAtMs ?? u.at, u.at);
      const current = u.at >= query.fromMs; add(current ? result.total : result.previous, u);
      const modelKey = `${source.provider}:${u.model}`; let model = models.get(modelKey);
      if (!model) { model = { ...zero(), id: modelKey, label: u.model === "unknown" ? "모델 미관측" : u.model, model: u.model, provider: source.provider, previousTotalTokens: 0 }; models.set(modelKey, model); }
      const sessionKey = `${source.provider}:${source.account}:${u.session}`; let session = sessions.get(sessionKey);
      if (!session) { session = { ...zero(), id: hash(sessionKey), label: u.agentName ?? `${u.project} · ${u.session.slice(0, 8)}`, provider: source.provider, account: source.account, accountLabel: source.accountLabel, sessionId: u.session, isSubagent: u.helper, parentSessionId: u.parentSessionId, repositoryUrl: u.repositoryUrl, quotapieEvidence: u.repositoryUrl ? "session_git_repository_url" : undefined, models: [], previousTotalTokens: 0 }; sessions.set(sessionKey, session); }
      if (!current) { model.previousTotalTokens! += u.totalTokens; session.previousTotalTokens! += u.totalTokens; continue; }
      let sessionModel = session.models!.find(m => m.model === u.model);
      if (!sessionModel) { sessionModel = { ...zero(), id: modelKey, label: u.model, model: u.model }; session.models!.push(sessionModel); }
      add(sessionModel, u);
      add(model, u); add(session, u); if (u.model === "unknown") result.coverage.unknownModelTokens += u.totalTokens;
      const day = fmt.format(new Date(u.at)); let bucket = days.get(day); if (!bucket) { bucket = { ...zero(), id: day, label: day }; days.set(day, bucket); } add(bucket, u);
      for (const period of result.resetPeriods) if (period.provider === source.provider && period.account === source.account && u.at >= period.fromMs! && u.at < period.toMs!) add(period, u);
    }
    for (const marker of localCompactions.values()) {
      const {source,at,session,project,helper} = marker;
      if (query.provider && (source.provider !== query.provider || source.account !== query.account)) continue;
      if (at < query.fromMs || at >= query.toMs) continue;
      result.activity.localCompactions++;
      const day = fmt.format(new Date(at)); let daily = days.get(day); if (!daily) { daily = {...zero(),id:day,label:day}; days.set(day,daily); }
      daily.activity ??= emptyActivity(); daily.activity.localCompactions++;
      const key = `${source.provider}:${source.account}:${session}`; let conversation = sessions.get(key);
      if (!conversation) { conversation = {...zero(),id:hash(key),label:`${project} · ${session.slice(0,8)}`,provider:source.provider,account:source.account,accountLabel:source.accountLabel,sessionId:session,isSubagent:helper}; sessions.set(key,conversation); }
      conversation.activity ??= emptyActivity(); conversation.activity.localCompactions++;
      for (const period of result.resetPeriods) if (period.provider === source.provider && period.account === source.account && at >= period.fromMs! && at < period.toMs!) { period.activity ??= emptyActivity(); period.activity.localCompactions++; }
    }
    const relayModels = new Map<string, UsageBucket>();
    for (const e of requests.values()) {
      const owners = e.threadId ? threadOwners.get(e.threadId) : undefined;
      const owner = owners?.size === 1 ? [...owners.values()][0] : undefined;
      const attributed = owner != null && owner.account !== "unknown";
      if (query.provider && (!attributed || owner.provider !== query.provider || owner.account !== query.account)) continue;
      const at = stamp(e.at); result.coverage.relayFirstObservedAtMs = Math.min(result.coverage.relayFirstObservedAtMs ?? at, at); result.coverage.relayLastObservedAtMs = Math.max(result.coverage.relayLastObservedAtMs ?? at, at);
      if (at < query.fromMs || at >= query.toMs) continue;
      addActivity(result.activity, e, attributed);
      const day = fmt.format(new Date(at)); let daily = days.get(day); if (!daily) { daily = { ...zero(), id: day, label: day }; days.set(day, daily); }
      daily.activity ??= emptyActivity(); addActivity(daily.activity, e, attributed);
      if (attributed && e.threadId) {
        const sessionKey = `${owner.provider}:${owner.account}:${e.threadId}`;
        let session = sessions.get(sessionKey); if (!session) { session = { ...zero(), id: hash(sessionKey), label: `대화 · ${e.threadId.slice(0,8)}`, sessionId: e.threadId, provider: owner.provider, account: owner.account, accountLabel: owner.accountLabel }; sessions.set(sessionKey, session); }
        session.activity ??= emptyActivity(); addActivity(session.activity, e, true);
        for (const period of result.resetPeriods) if (period.provider === owner.provider && period.account === owner.account && at >= period.fromMs! && at < period.toMs!) { period.activity ??= emptyActivity(); addActivity(period.activity, e, true); }
      }
      const model = e.responseModel ?? "unknown"; let bucket = relayModels.get(model);
      if (!bucket) { bucket = { ...zero(), id: model, label: model === "unknown" ? "응답 모델 미확인" : model, model }; relayModels.set(model, bucket); }
      const usage = { ...zero(), inputTokens: e.usage?.input ?? 0, cachedInputTokens: e.usage?.cachedInput ?? 0, outputTokens: e.usage?.output ?? 0,
        totalTokens: (e.usage?.input ?? 0) + (e.usage?.output ?? 0), requests: 1 };
      add(bucket, usage); bucket.activity ??= emptyActivity(); addActivity(bucket.activity, e, attributed);
    }
    result.relayModels = [...relayModels.values()].sort((a,b) => b.totalTokens - a.totalTokens);
    result.days = [...days.values()].sort((a,b) => a.id.localeCompare(b.id));
    result.models = [...models.values()].sort((a,b) => b.totalTokens - a.totalTokens);
    result.sessions = [...sessions.values()].sort((a,b) => b.totalTokens - a.totalTokens);
    // Host titles are metadata, not prompt contents. Scope lookup to the owning
    // profile and require its rollout path to match the file already indexed.
    for (const account of config.accounts.codex.filter(a => a.enabled)) {
      let db: Database | undefined;
      try {
        const root = await realpath(codexProfileRoot(account));
        const name = (await readdir(root)).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a,b) => Number(b.slice(6,-7)) - Number(a.slice(6,-7)))[0];
        if (!name) continue;
        const dbPath = await realpath(join(root,name)); if (!contained(root,dbPath)) continue;
        db = new Database(dbPath, {readonly:true,strict:true});
        const lookup = db.query<{title:string;rollout_path:string},[string]>("SELECT title, rollout_path FROM threads WHERE id=?");
        const indexed = new Map<string,Set<string>>();
        for (const c of this.caches.values()) if (c.source.provider === "codex" && c.source.account === account.id) {
          const paths = indexed.get(c.session) ?? new Set<string>(); paths.add(c.source.path); indexed.set(c.session,paths);
        }
        for (const session of result.sessions.filter(s => s.provider === "codex" && s.account === account.id && s.sessionId)) {
          const row = lookup.get(session.sessionId!); if (!row || typeof row.rollout_path !== "string") continue;
          let rollout: string; try { rollout = await realpath(row.rollout_path); } catch {
            try { rollout = await realpath(row.rollout_path + ".zst"); } catch { continue; }
          }
          if (!contained(root,rollout)) continue;
          if (!indexed.get(session.sessionId!)?.has(rollout)) {
            // A canonical rollout may have been compressed while newer history
            // shards remain indexed. Validate its bounded header before trusting DB metadata.
            if (!rollout.endsWith(".zst") || (await readCodexForkParent(root,session.sessionId!)).status !== "known") continue;
          }
          if (typeof row.title === "string" && row.title.trim()) {
            if (!session.isSubagent) session.label = row.title.replace(/[\u0000-\u001f]/g," ").trim().slice(0,240);
            if (!session.quotapieEvidence && /quotapie/i.test(row.title)) session.quotapieCandidateEvidence = "thread_title";
          }
        }
      } catch { /* Missing host metadata cannot invent a title or attribution. */ }
      finally { db?.close(); }
    }
    for (const session of result.sessions) {
      session.uncachedInputTokens = Math.max(0, session.inputTokens - session.cachedInputTokens);
      session.models?.sort((a,b) => b.totalTokens - a.totalTokens);
    }
    const bySession = new Map(result.sessions.map(s => [`${s.provider}:${s.account}:${s.sessionId}`,s]));
    for (const session of result.sessions) {
      if (session.quotapieEvidence || session.quotapieCandidateEvidence || !session.parentSessionId) continue;
      const seen = new Set<string>([session.sessionId!]); let parentId: string | undefined = session.parentSessionId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId); const parent = bySession.get(`${session.provider}:${session.account}:${parentId}`); if (!parent) break;
        if (parent.quotapieEvidence) { session.quotapieCandidateEvidence = "parent_repository"; break; }
        if (parent.quotapieCandidateEvidence) { session.quotapieCandidateEvidence = parent.quotapieCandidateEvidence === "parent_repository" ? "parent_repository" : "inherited_title"; break; }
        parentId = parent.parentSessionId;
      }
    }
    const development = zero(), candidates = zero(); const developmentSessionIds: string[] = [], candidateSessionIds: string[] = [];
    for (const session of result.sessions) if (session.quotapieEvidence && session.totalTokens > 0) { add(development, session); developmentSessionIds.push(session.sessionId!); }
    for (const session of result.sessions) if (session.quotapieCandidateEvidence && session.totalTokens > 0) { add(candidates, session); candidateSessionIds.push(session.sessionId!); }
    result.consumption = { basis: "local_observed_tokens", quotaPercent: null,
      quotapie: { development, developmentSessionIds, candidates, candidateSessionIds, evidence: "session_git_repository_url", relay: { ...result.activity }, quotaPercent: null,
        note: "개발 사용량은 세션 메타데이터의 QuotaPie 저장소 URL이 직접 확인된 기록만 포함합니다. 부모 연결에 따른 관련 작업은 후보로 분리합니다. 해당 저장소 밖의 조사·자동 실행은 귀속 미확인입니다. 릴레이 관측은 개발·세션 토큰과 겹칠 수 있어 합산하지 않습니다. 토큰 비중은 공식 한도 비중이 아닙니다." },
      conversations: result.sessions.filter(s => s.totalTokens > 0), subagents: result.sessions.filter(s => s.isSubagent && s.totalTokens > 0) };
    result.resetPeriods.sort((a,b) => b.fromMs! - a.fromMs!);
    result.coverage.notes.push("로컬 로그에서 관측한 토큰이며 계정 전체 사용량·과금·한도 소진율과 같지 않습니다.",
      "캐시 입력은 입력 토큰의 일부이며 추론 토큰은 출력의 일부입니다. 중복 합산하지 않습니다.",
      "서브에이전트를 포함합니다. 압축·재시도 릴레이 관측은 로컬 세션 합계와 겹칠 수 있어 별도로 표시합니다.",
      "재시도 토큰은 재시도가 기록된 요청의 마지막 관측 사용량입니다. 실패한 이전 시도의 미기록 사용량은 알 수 없습니다.",
      "리셋 구간은 계정·한도 버킷별로 겹치므로 구간끼리 합산하지 않습니다. 날짜 선택은 실제 리셋 시각을 뜻하지 않습니다.");
    if ([...records.values()].some(r => r.source.account === "unknown")) result.coverage.notes.push("여러 계정 프로필에 같은 대화 기록이 복제되어 중복을 제거했습니다. 해당 기록은 계정 귀속 불명으로 표시하며 계정별 구간에서 제외합니다.");
    if (this.compressedSkipped) result.coverage.notes.push(`압축된 세션 파일 ${this.compressedSkipped}개는 토큰 색인에서 제외됐습니다. 해당 기록의 사용량은 미확인입니다.`);
    if (result.coverage.filesPending) result.coverage.notes.push("기록을 순차 색인 중입니다. 색인 완료 전 합계와 비교는 부분 관측입니다.");
    if (result.coverage.filesSkipped || result.coverage.malformedLines) result.coverage.notes.push("읽지 못했거나 크기 제한을 넘긴 기록이 있어 일부 사용량이 누락될 수 있습니다.");
    result.coverage.notes.push("릴레이 기록의 최초·최종 시각 사이에도 누락 구간이 있을 수 있습니다. 로컬 압축 표식은 Codex 로그의 별도 관측이며 릴레이 압축 요청 수와 합산하지 않습니다.");
    if (result.coverage.relayFirstObservedAtMs == null || result.coverage.relayFirstObservedAtMs > query.fromMs) result.coverage.notes.push("압축·재시도 기록은 보관된 릴레이 로그 범위에 한정되며 선택 기간 전체를 덮지 않습니다.");
    result.coverage.notes.push("계정은 현재 연결된 로컬 프로필 기준입니다. 과거 로그인 계정 변경 이력이 없으면 당시 계정을 확정할 수 없습니다.");
    if (!result.resetPeriods.length) result.coverage.notes.push("선택 범위의 실제 계정 리셋 경계 기록이 없습니다.");
    return result;
  }
}
