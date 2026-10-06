import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { codexProfileRoot, resolveUserPath, type AppConfig } from "./config";
import { normalizeSessionId, resumeTaskKey } from "./session-discovery";
import type { Provider } from "./types";

export interface RecentWorkSummary {
  id: string;
  provider: "codex" | "claude";
  account: string;
  accountLabel: string;
  projectLabel: string;
  tokenCount: number;
  lastActiveAtMs: number;
}
interface Usage { key: string; at: number; tokens: number }
interface Projection {
  session?: string; cwd?: string; at?: number; activity?: boolean; helper?: boolean;
  fork?: boolean; forkAt?: number; cumulative?: number; last?: number; usage?: Usage;
}
interface FileCache {
  identity: string; size: number; mtime: number; ctime: number;
  session?: string; cwd?: string; helper: boolean; fork: boolean; baseline?: number;
  forkAt?: number; lastActive: number; records: Map<string, Usage>; truncated: boolean;
}
interface Profile { provider: "codex" | "claude"; account: string; label: string; root: string }
interface Options { inventoryTtlMs?: number; maxFiles?: number; maxBytesPerFile?: number; maxRecordsPerFile?: number }
const WEEK = 7 * 24 * 60 * 60 * 1000;
const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const stamp = (value: unknown): number | undefined => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
};
function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { return normalizeSessionId(value); } catch { return; }
}
function label(value: string): string {
  return value.replace(/[^\p{L}\p{N}._ -]/gu, "").trim().slice(0, 80) || "Project";
}

// Skip opaque JSON values and decode only allow-listed fields. No prompt,
// title, or message content is parsed or retained in the metadata cache.
function fields(input: string, allowed: Set<string>): Record<string, string> {
  if (!input.trimEnd().endsWith("}")) return {};
  const result: Record<string, string> = {};
  let i = 0;
  const ws = () => { while (/\s/.test(input[i] ?? "") && i < input.length) i++; };
  // Most transcript bytes are inside opaque strings. Native indexOf skips
  // their bodies without running one JavaScript iteration per content byte.
  const quotedEnd = (start: number): number => {
    let end = input.indexOf('"', start + 1);
    while (end >= 0) {
      let slashes = 0;
      for (let previous = end - 1; previous > start && input[previous] === "\\"; previous--) slashes++;
      if (slashes % 2 === 0) return end + 1;
      end = input.indexOf('"', end + 1);
    }
    return input.length;
  };
  const endValue = (): number => {
    let depth = 0;
    for (; i < input.length; i++) {
      const char = input[i]!;
      if (char === '"') { i = quotedEnd(i) - 1; }
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") { if (!depth) break; depth--; }
      else if (char === "," && !depth) break;
    }
    return i;
  };
  ws(); if (input[i++] !== "{") return result;
  while (i < input.length) {
    ws(); if (input[i] !== '"') break;
    const start = i;
    i = quotedEnd(i);
    let key: string;
    try { key = JSON.parse(input.slice(start, i)); } catch { break; }
    ws(); if (input[i++] !== ":") break;
    ws(); const valueStart = i; const end = endValue();
    if (allowed.has(key)) result[key] = input.slice(valueStart, end);
    ws(); if (input[i] === ",") i++; else break;
  }
  return result;
}
function scalar(raw: string | undefined): unknown {
  if (raw == null) return;
  try { return JSON.parse(raw); } catch { return; }
}
const TOP = new Set(["type", "timestamp", "sessionId", "cwd", "uuid", "isSidechain", "payload", "message"]);
const PAYLOAD = new Set(["id", "cwd", "source", "forked_from_id", "type", "info"]);
const INFO = new Set(["total_token_usage", "last_token_usage"]);
const MESSAGE = new Set(["id", "usage"]);
function tokenTotal(raw: string | undefined, claude = false): number | undefined {
  if (!raw) return;
  const keys = claude ? ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] : ["total_tokens"];
  const values = fields(raw, new Set(keys));
  let total = 0, found = false;
  for (const key of keys) {
    const n = counter(scalar(values[key]));
    if (n != null) { total += n; found = true; }
  }
  return found && Number.isSafeInteger(total) ? total : undefined;
}
function projectLine(line: string, provider: "codex" | "claude"): Projection {
  // Codex response_item can contain megabytes of tool output. Its outer
  // timestamp is enough for recency; skip the opaque payload entirely.
  const prefix = line.slice(0, 512);
  if (provider === "codex" && /"type"\s*:\s*"response_item"/.test(prefix)) {
    const timestamp = /"timestamp"\s*:\s*"([^"\\]{1,80})"/.exec(prefix)?.[1];
    return { at: stamp(timestamp), activity: true };
  }
  const top = fields(line, TOP);
  const type = scalar(top.type), at = stamp(scalar(top.timestamp));
  if (provider === "codex") {
    const payload = fields(top.payload ?? "", PAYLOAD);
    if (type === "session_meta") {
      const source = scalar(payload.source);
      return { session: uuid(scalar(payload.id)), cwd: typeof scalar(payload.cwd) === "string" ? scalar(payload.cwd) as string : undefined,
        fork: !!uuid(scalar(payload.forked_from_id)), forkAt: at, helper: source === "subagent" || (!!source && typeof source === "object" && "subagent" in source) };
    }
    if (type !== "event_msg") return {};
    const subtype = scalar(payload.type);
    if (subtype === "token_count") {
      const info = fields(payload.info ?? "", INFO);
      return { at, activity: true, cumulative: tokenTotal(info.total_token_usage), last: tokenTotal(info.last_token_usage) };
    }
    return { at, activity: ["user_message", "agent_message", "task_started", "task_complete", "message", "function_call", "function_call_output"].includes(String(subtype)) };
  }
  const session = uuid(scalar(top.sessionId));
  const cwd = scalar(top.cwd);
  const base: Projection = { session, cwd: typeof cwd === "string" ? cwd : undefined, helper: scalar(top.isSidechain) === true };
  if (type !== "user" && type !== "assistant") return base;
  base.at = at; base.activity = true;
  if (type === "assistant" && at) {
    const message = fields(top.message ?? "", MESSAGE);
    const id = scalar(message.id) ?? scalar(top.uuid);
    const tokens = tokenTotal(message.usage, true);
    if (typeof id === "string" && id.length > 0 && id.length <= 256 && tokens != null) base.usage = { key: hash(id), at, tokens };
  }
  return base;
}

/** Local metadata index. Caps cold reads and retained projections; unchanged
 * files are never read again, and append-only logs read only their new tail. */
export class RecentWorkIndex {
  private caches = new Map<string, FileCache>();
  private inventory = new Map<string, { at: number; paths: string[] }>();
  private labels = new Map<string, { at: number; value: string }>();
  private options: Required<Options>;
  private pending?: { key: string; promise: Promise<RecentWorkSummary[]> };
  constructor(options: Options = {}) {
    this.options = { inventoryTtlMs: 10_000, maxFiles: 2_000, maxBytesPerFile: 2_000_000, maxRecordsPerFile: 2_000, ...options };
  }
  async summaries(config: AppConfig, nowMs = Date.now()): Promise<RecentWorkSummary[]> {
    const key = JSON.stringify(config.accounts);
    if (this.pending) {
      if (this.pending.key === key) return this.pending.promise;
      await this.pending.promise;
      return this.summaries(config, nowMs);
    }
    const promise = this.collect(config, nowMs);
    this.pending = { key, promise };
    try { return await promise; } finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }
  private async collect(config: AppConfig, nowMs: number): Promise<RecentWorkSummary[]> {
    const profiles: Profile[] = [], roots = new Set<string>();
    for (const provider of ["codex", "claude"] as const) {
      for (const profile of config.accounts[provider]) {
        if (!profile.enabled) continue;
        let root: string;
        try { root = await realpath(provider === "codex" ? codexProfileRoot(profile as AppConfig["accounts"]["codex"][number]) : resolveUserPath((profile as AppConfig["accounts"]["claude"][number]).configDir)); } catch { continue; }
        const identity = `${provider}:${root}`;
        if (roots.has(identity)) continue;
        roots.add(identity);
        profiles.push({ provider, root, account: profile.id, label: profile.nickname?.trim() || profile.label });
      }
    }
    const retained = new Set<string>();
    const sessions = new Map<string, { summary: RecentWorkSummary; cwd: string; records: Map<string, Usage> }>();
    for (const profile of profiles) {
      const paths = await this.paths(profile, nowMs);
      // Keep disk pressure bounded, without serialising all file reads.
      for (let offset = 0; offset < paths.length; offset += 4) {
        await Promise.all(paths.slice(offset, offset + 4).map(async path => {
          retained.add(path);
          let cached: FileCache | null;
          try { cached = await this.read(path, profile.provider, profile.root); } catch { return; }
          if (!cached?.session || !cached.cwd || !isAbsolute(cached.cwd) || cached.helper || cached.lastActive < nowMs - WEEK || cached.lastActive > nowMs + 60_000) return;
          const id = resumeTaskKey(profile.provider, profile.account, cached.session);
          let session = sessions.get(id);
          if (!session) {
            session = { summary: { id, provider: profile.provider, account: profile.account, accountLabel: profile.label,
              projectLabel: "", tokenCount: 0, lastActiveAtMs: cached.lastActive }, cwd: cached.cwd, records: new Map() };
            sessions.set(id, session);
          }
          if (cached.lastActive > session.summary.lastActiveAtMs) { session.summary.lastActiveAtMs = cached.lastActive; session.cwd = cached.cwd; }
          for (const [key, usage] of cached.records) {
            if (usage.at < nowMs - WEEK || usage.at > nowMs + 60_000) continue;
            const old = session.records.get(key);
            if (!old || usage.tokens > old.tokens) session.records.set(key, usage);
          }
        }));
      }
    }
    for (const path of this.caches.keys()) if (!retained.has(path)) this.caches.delete(path);
    for (const key of this.inventory.keys()) if (!roots.has(key)) this.inventory.delete(key);
    const all = [...sessions.values()].map(session => {
      session.summary.tokenCount = [...session.records.values()].reduce((sum, usage) => sum + usage.tokens, 0);
      if (!Number.isSafeInteger(session.summary.tokenCount)) session.summary.tokenCount = Number.MAX_SAFE_INTEGER;
      return session;
    });
    const ranked = all.sort((a, b) => b.summary.lastActiveAtMs - a.summary.lastActiveAtMs || b.summary.tokenCount - a.summary.tokenCount || a.summary.id.localeCompare(b.summary.id)).slice(0, 10);
    for (let offset = 0; offset < ranked.length; offset += 4) {
      await Promise.all(ranked.slice(offset, offset + 4).map(async session => {
        session.summary.projectLabel = await this.projectLabel(session.cwd, nowMs);
      }));
    }
    return ranked.map(session => session.summary);
  }
  async target(id: string, config: AppConfig, nowMs = Date.now()): Promise<{ provider: Provider; account: string; taskKey: string } | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const found = (await this.summaries(config, nowMs)).find(summary => summary.id === id);
    return found ? { provider: found.provider, account: found.account, taskKey: found.id } : null;
  }
  private async paths(profile: Profile, now: number): Promise<string[]> {
    const key = `${profile.provider}:${profile.root}`;
    const old = this.inventory.get(key);
    if (old && now - old.at < this.options.inventoryTtlMs) return old.paths;
    const base = join(profile.root, profile.provider === "codex" ? "sessions" : "projects");
    const candidates: { path: string; mtime: number }[] = [];
    let directories = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      let entries;
      if (++directories > this.options.maxFiles * 3) return;
      try {
        const canonical = await realpath(dir);
        if (relative(profile.root, canonical).startsWith("..")) return;
        entries = await readdir(dir, { withFileTypes: true });
      } catch { return; }
      const filePaths: string[] = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name === "subagents" || entry.name.startsWith("agent-")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory() && depth < (profile.provider === "codex" ? 4 : 1)) await visit(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && (profile.provider === "codex" || !!uuid(entry.name.slice(0, -6)))) filePaths.push(path);
      }
      // Cold discovery still checks old-date directories: old sessions can be
      // resumed today. Batch cheap stats instead of serialising thousands.
      for (let offset = 0; offset < filePaths.length; offset += 32) {
        await Promise.all(filePaths.slice(offset, offset + 32).map(async path => {
          try { const info = await stat(path); if (info.mtimeMs >= now - WEEK) candidates.push({ path, mtime: info.mtimeMs }); } catch { /* raced deletion */ }
        }));
      }
    };
    await visit(base, 0);
    const paths = candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, this.options.maxFiles).map(item => item.path);
    this.inventory.set(key, { at: now, paths });
    return paths;
  }
  private async read(path: string, provider: "codex" | "claude", root: string): Promise<FileCache | null> {
    const canonical = await realpath(path);
    if (relative(root, canonical).startsWith("..")) return null;
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      const identity = `${info.dev}:${info.ino}`;
      let cached = this.caches.get(path);
      if (cached && cached.identity === identity && cached.size === info.size && cached.mtime === info.mtimeMs && cached.ctime === info.ctimeMs) return cached;
      let offset = cached?.size ?? 0;
      if (!cached || cached.identity !== identity || info.size <= cached.size || info.size - cached.size > this.options.maxBytesPerFile) {
        offset = Math.max(0, info.size - this.options.maxBytesPerFile);
        cached = { identity, size: 0, mtime: 0, ctime: 0, session: provider === "claude" ? uuid(basename(path, ".jsonl")) : undefined, helper: false, fork: false, lastActive: 0, records: new Map(), truncated: offset > 0 };
        if (offset) {
          const head = Buffer.alloc(Math.min(info.size, 65_536));
          const { bytesRead } = await file.read(head, 0, head.length, 0);
          for (const line of head.subarray(0, bytesRead).toString("utf8").split("\n")) {
            const p = projectLine(line, provider);
            if (provider === "claude" && p.session && p.session !== cached.session) continue;
            cached.session ??= p.session; cached.cwd ??= p.cwd;
            cached.helper ||= p.helper ?? false; cached.fork ||= p.fork ?? false;
            if (p.fork && p.forkAt) cached.forkAt = p.forkAt;
          }
        }
      }
      const buffer = Buffer.alloc(Math.min(this.options.maxBytesPerFile, info.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (offset && cached.truncated && cached.size === 0) lines.shift();
      // Only complete lines advance the cursor; a partially appended record is
      // reread on the next poll without caching any raw transcript text.
      const completeBytes = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
      lines.pop();
      for (const line of lines) {
        let p: Projection;
        try { p = projectLine(line, provider); } catch { continue; }
        if (provider === "claude" && p.session && p.session !== cached.session) continue;
        cached.session ??= p.session; cached.cwd ??= p.cwd;
        cached.helper ||= p.helper ?? false; cached.fork ||= p.fork ?? false;
        if (p.fork && p.forkAt) cached.forkAt = p.forkAt;
        const inherited = cached.fork && cached.forkAt != null && p.at != null && p.at < cached.forkAt;
        if (p.activity && p.at && !inherited) cached.lastActive = Math.max(cached.lastActive, p.at);
        let usage = p.usage;
        if (provider === "codex" && p.cumulative != null && p.at) {
          let tokens = 0;
          if (cached.baseline != null) tokens = p.cumulative >= cached.baseline ? p.cumulative - cached.baseline : (p.last ?? 0);
          else if (!cached.fork && !cached.truncated) tokens = p.cumulative;
          else if (!cached.fork) tokens = p.last ?? 0;
          cached.baseline = p.cumulative;
          usage = { key: `${p.at}:${p.cumulative}`, at: p.at, tokens };
        }
        if (usage && !inherited) {
          const old = cached.records.get(usage.key);
          if (!old || usage.tokens > old.tokens) cached.records.set(usage.key, usage);
          while (cached.records.size > this.options.maxRecordsPerFile) cached.records.delete(cached.records.keys().next().value!);
        }
      }
      cached.size = offset + completeBytes; cached.mtime = info.mtimeMs; cached.ctime = info.ctimeMs;
      this.caches.set(path, cached);
      return cached;
    } finally { await file.close(); }
  }
  private async projectLabel(cwd: string, now: number): Promise<string> {
    const cached = this.labels.get(cwd);
    if (cached && now - cached.at < 60_000) return cached.value;
    let value = label(basename(cwd));
    try {
      const { stdout } = await exec("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 1_000, maxBuffer: 4096 });
      const remote = stdout.trim().split(/[?#]/)[0] ?? "";
      let repo: string | undefined;
      if (/^[a-z]+:\/\//i.test(remote)) {
        const url = new URL(remote);
        repo = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/, "");
      } else repo = remote.replace(/\.git$/, "").split(/[/:]/).at(-1);
      if (repo) value = label(repo);
    } catch { /* deleted project or no remote: use only its directory name */ }
    this.labels.set(cwd, { at: now, value });
    while (this.labels.size > 512) this.labels.delete(this.labels.keys().next().value!);
    return value;
  }
}
