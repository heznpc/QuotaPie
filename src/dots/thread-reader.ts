import { Database } from "bun:sqlite";
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { codexProfileRoot, codexUsesFileCredentials, type AppConfig } from "../config";
import { resumeProfileKey, type ResumeGate } from "../resume-gate";
import { readGate } from "./policy";
import type { DotPolicy } from "./store";

type ReadMethod = "initialize" | "account/read" | "thread/read" | "config/read";
export interface ThreadReadTransport {
  request(method: ReadMethod, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface ProfileThreadStatus {
  targetId: string;
  threadId: string;
  found: true;
  title: string | null;
  account: string;
  appServerStatus: string;
  // A metadata-only child has its own loaded-thread set. In particular,
  // notLoaded says nothing about a turn running in the desktop owner.
  runtimeStateVerified: false;
  resumeAllowed: false;
  evidence: { profileMatched: true; accountMatched: true; sessionMetadataMatched: true; rolloutPathMatched: true };
}
export interface ThreadReaderOptions {
  readGate?: (policy: DotPolicy) => Promise<ResumeGate>;
  binary?: () => string | null;
  transport?: (binary: string, codexHome: string) => Promise<ThreadReadTransport>;
}

/** Match the installed desktop CLI, since a PATH CLI can lag the rollout format. */
export function findBundledCodex(): string | null {
  for (const base of ["/Applications", join(homedir(), "Applications")]) {
    for (const app of ["ChatGPT.app", "Codex.app"]) {
      const bundle = join(base, app);
      const id = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(bundle, "Contents/Info.plist")], { encoding: "utf8" });
      if (id.status !== 0 || id.stdout.trim() !== "com.openai.codex") continue;
      for (const suffix of ["codex-cli/bin/codex", "codex"]) {
        try {
          const path = join(bundle, "Contents/Resources", suffix);
          accessSync(path, constants.X_OK);
          if (statSync(path).isFile()) return realpathSync(path);
        } catch { /* Try the other installed bundle layout. */ }
      }
    }
  }
  return null;
}

function within(root: string, path: string) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

export function metadataPath(root: string, threadId: string): string {
  let db: Database | undefined, fd: number | undefined;
  try {
    const filename = readdirSync(root).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0];
    if (!filename) throw new Error();
    const database = realpathSync(join(root, filename));
    if (!within(root, database)) throw new Error();
    db = new Database(database, { readonly: true, strict: true });
    const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id=?").get(threadId);
    if (!row || !isAbsolute(row.rollout_path)) throw new Error();
    const path = realpathSync(row.rollout_path);
    if (!within(join(root, "sessions"), path)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error();
    const bytes = Buffer.alloc(1024 * 1024), count = readSync(fd, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, count).indexOf(10);
    if (end < 0) throw new Error();
    const header = JSON.parse(bytes.subarray(0, end).toString("utf8"));
    if (header?.type !== "session_meta" || header.payload?.id !== threadId) throw new Error();
    return path;
  } catch { throw new Error("thread-profile-unverified"); }
  finally { if (fd !== undefined) closeSync(fd); db?.close(); }
}

async function openTransport(binary: string, codexHome: string): Promise<ThreadReadTransport> {
  const child = Bun.spawn([binary, "-s", "read-only", "-a", "never", "-c", 'cli_auth_credentials_store="file"', "-c", "features.hooks=false", "-c", "notify=[]", "app-server", "--stdio"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: undefined },
  });
  let nextId = 1, stopped = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = () => {
    stopped = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("thread-reader-unavailable")); }
    pending.clear();
  };
  const pump = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        // includeTurns:false returns bounded metadata, never a transcript.
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new Error();
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line), item = pending.get(message.id);
          if (!item) continue;
          clearTimeout(item.timer); pending.delete(message.id);
          if (message.error) item.reject(new Error("thread-read-failed"));
          else item.resolve(message.result);
        }
      }
    } catch { /* Raw provider errors can contain paths or credentials. */ }
    finally { fail(); }
  })();
  return {
    request(method, params) {
      if (stopped || !["initialize", "account/read", "thread/read", "config/read"].includes(method))
        return Promise.reject(new Error("thread-reader-unavailable"));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id); reject(new Error("thread-read-timeout"));
        }, 12000);
        pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); child.stdin.flush();
        } catch { clearTimeout(timer); pending.delete(id); reject(new Error("thread-reader-unavailable")); }
      }).then(result => {
        if (method === "initialize") {
          // This notification carries no action or inference request.
          child.stdin.write('{"method":"initialized","params":{}}\n'); child.stdin.flush();
        }
        return result;
      });
    },
    async close() {
      fail(); child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await child.exited; await pump; } finally { clearTimeout(timer); }
    },
  };
}

interface LocalIdentity { email: string; continuity: string }
function localIdentity(root: string): LocalIdentity {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 262144) throw new Error();
    const bytes = Buffer.alloc(stat.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error();
    const auth = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (auth.auth_mode !== "chatgpt" || auth.OPENAI_API_KEY) throw new Error();
    const token = (value: unknown) => {
      if (typeof value !== "string" || value.length > 131072) throw new Error();
      const parts = value.split(".");
      if (parts.length !== 3 || !parts[1]) throw new Error();
      return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    };
    const id = token(auth.tokens?.id_token), access = token(auth.tokens?.access_token);
    const email = typeof id.email === "string" ? id.email.trim().toLowerCase() : "";
    const accessEmail = access["https://api.openai.com/profile"]?.email;
    const account = auth.tokens?.account_id, subject = id.sub;
    if (!email.includes("@") || email.length > 320 || typeof accessEmail !== "string" || accessEmail.trim().toLowerCase() !== email ||
        typeof account !== "string" || !account || account.length > 512 ||
        typeof subject !== "string" || !subject || subject.length > 512 || access.sub !== subject ||
        id["https://api.openai.com/auth"]?.chatgpt_account_id !== account ||
        access["https://api.openai.com/auth"]?.chatgpt_account_id !== account) throw new Error();
    // This is local credential continuity, not JWT authentication. Neither
    // identity claims nor tokens leave this call; the collector verifies the
    // enrolled accountKey independently before and after the provider read.
    return { email, continuity: JSON.stringify([account, subject, email]) };
  } catch { throw new Error("subscription-account-unverified"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function accountIdentity(result: unknown, expectedEmail: string): string {
  const account = (result as any)?.account;
  if (account?.type !== "chatgpt" || typeof account.email !== "string" || !account.email.includes("@"))
    throw new Error("subscription-account-unverified");
  if (account.email.trim().toLowerCase() !== expectedEmail) throw new Error("account-profile-mismatch");
  // Retained only for the duration of this call, and never returned to Dots.
  return JSON.stringify([account.type, account.email.trim().toLowerCase(), account.planType ?? null]);
}

/** Read one explicitly enrolled thread within its owning profile. No resume,
 * turn start, host enrollment, transcript export or account substitution. */
export async function readConfiguredThread(config: AppConfig, policy: DotPolicy, options: ThreadReaderOptions = {}): Promise<ProfileThreadStatus> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(policy.threadId) ||
      !/^[a-f0-9]{64}$/.test(policy.profileKey) || !/^[a-f0-9]{64}$/.test(policy.accountKey))
    throw new Error("thread-target-unverified");
  const profile = config.accounts.codex.find(item => item.id === policy.account && item.enabled);
  if (!profile || resumeProfileKey(config, "codex", policy.account) !== policy.profileKey)
    throw new Error("profile-mismatch");
  const root = realpathSync(codexProfileRoot(profile));
  const path = metadataPath(root, policy.threadId);
  const gateReader = options.readGate ?? (p => readGate(config, p));
  const verify = async () => {
    if (!codexUsesFileCredentials(profile)) throw new Error("subscription-file-credentials-required");
    const identity = localIdentity(root);
    const gate = await gateReader(policy);
    if (gate.provider !== "codex" || gate.account !== policy.account || gate.profileKey !== policy.profileKey ||
        gate.accountKey !== policy.accountKey || resumeProfileKey(config, "codex", policy.account) !== policy.profileKey)
      throw new Error("account-profile-mismatch");
    if (!codexUsesFileCredentials(profile) || localIdentity(root).continuity !== identity.continuity)
      throw new Error("account-profile-mismatch");
    return identity;
  };
  const expected = await verify();
  const binary = (options.binary ?? findBundledCodex)();
  if (!binary) throw new Error("bundled-codex-unavailable");
  const transport = await (options.transport ?? openTransport)(binary, root);
  try {
    await transport.request("initialize", { clientInfo: { name: "quotapie_thread_reader", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    const before = accountIdentity(await transport.request("account/read", { refreshToken: false }), expected.email);
    const result = await transport.request("thread/read", { threadId: policy.threadId, includeTurns: false });
    const after = accountIdentity(await transport.request("account/read", { refreshToken: false }), expected.email);
    if (before !== after) throw new Error("account-profile-mismatch");
    if ((await verify()).continuity !== expected.continuity) throw new Error("account-profile-mismatch");
    const thread = (result as any)?.thread;
    if (thread?.id !== policy.threadId || typeof thread.cwd !== "string" || !isAbsolute(thread.cwd) ||
        typeof thread.path !== "string" || realpathSync(thread.path) !== path || metadataPath(root, policy.threadId) !== path)
      throw new Error("thread-profile-unverified");
    const status = thread.status?.type;
    return { targetId: policy.id, threadId: policy.threadId, found: true,
      title: typeof thread.name === "string" ? thread.name.slice(0, 1000) : null, account: policy.account,
      appServerStatus: ["notLoaded", "idle", "systemError", "active"].includes(status) ? status : "unknown",
      runtimeStateVerified: false, resumeAllowed: false,
      evidence: { profileMatched: true, accountMatched: true, sessionMetadataMatched: true, rolloutPathMatched: true } };
  } catch (error) {
    const safe = error instanceof Error && /^(?:thread|account|subscription)-[a-z-]+$/.test(error.message) ? error.message : "thread-read-failed";
    throw new Error(safe);
  } finally { await transport.close(); }
}


/** Internal-only effective configuration evidence. Paths and raw merged config
 * never cross the Dot interface. This is a change-detection snapshot, not an
 * atomic lock on Codex's layered configuration. */
export interface ExecutionConfiguration {
  mcpServers: string[];
  unchanged(): boolean;
}
function configurationStamp(path: string): string {
  try { const st = statSync(path); if (!st.isFile()) throw new Error(); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }
  catch (error: any) { if (error?.code === "ENOENT") return "absent"; throw new Error("execution-config-unverified"); }
}
export async function readExecutionConfiguration(config: AppConfig, policy: DotPolicy, cwd: string, options: ThreadReaderOptions = {}): Promise<ExecutionConfiguration> {
  const profile = config.accounts.codex.find(p => p.enabled && p.id === policy.account);
  if (!profile || !isAbsolute(cwd) || resumeProfileKey(config, "codex", policy.account) !== policy.profileKey || !codexUsesFileCredentials(profile))
    throw new Error("execution-config-unverified");
  const root = realpathSync(codexProfileRoot(profile)), identity = localIdentity(root);
  const gateReader = options.readGate ?? (p => readGate(config, p));
  const verify = async () => {
    const gate = await gateReader(policy);
    if (gate.accountKey !== policy.accountKey || gate.profileKey !== policy.profileKey || gate.account !== policy.account ||
        !codexUsesFileCredentials(profile) || localIdentity(root).continuity !== identity.continuity) throw new Error("account-profile-mismatch");
  };
  await verify();
  const binary = (options.binary ?? findBundledCodex)();
  if (!binary) throw new Error("bundled-codex-unavailable");
  const transport = await (options.transport ?? openTransport)(binary, root);
  try {
    await transport.request("initialize", { clientInfo: { name: "quotapie_execution_config_reader", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    accountIdentity(await transport.request("account/read", { refreshToken: false }), identity.email);
    const result = await transport.request("config/read", { cwd, includeLayers: true }) as any;
    if (!result?.config || typeof result.config !== "object" || !Array.isArray(result.layers) || result.layers.length > 128)
      throw new Error("execution-config-unverified");
    const servers = new Set<string>(), paths = new Set<string>([join(root, "config.toml"), "/etc/codex/config.toml", join(cwd, "config.toml")]);
    for (let path = cwd;; path = dirname(path)) { paths.add(join(path, ".codex", "config.toml")); if (dirname(path) === path) break; }
    const collect = (value: any) => {
      if (value === undefined || value === null) return;
      if (typeof value !== "object" || Array.isArray(value)) throw new Error("execution-config-unverified");
      for (const name of Object.keys(value)) {
        if (!name || name.length > 256 || /[\u0000-\u001f]/.test(name) || servers.size >= 512) throw new Error("execution-config-unverified");
        servers.add(name);
      }
    };
    collect(result.config.mcp_servers);
    for (const layer of result.layers) {
      collect(layer?.config?.mcp_servers);
      const source = layer?.name;
      if (!source || typeof source.type !== "string") throw new Error("execution-config-unverified");
      if (["mdm", "enterpriseManaged", "legacyManagedConfigTomlFromMdm"].includes(source.type)) throw new Error("execution-config-external-layer");
      if (source.type === "sessionFlags") continue;
      const path = source.type === "project" && typeof source.dotCodexFolder === "string" ? join(source.dotCodexFolder, "config.toml") : source.file;
      if (typeof path !== "string" || !isAbsolute(path)) throw new Error("execution-config-unverified");
      paths.add(path);
    }
    const stamps = [...paths].map(path => ({ path, stamp: configurationStamp(path) }));
    await verify();
    return { mcpServers: [...servers].sort(), unchanged() {
      try { return stamps.every(({ path, stamp }) => configurationStamp(path) === stamp); } catch { return false; }
    } };
  } finally { await transport.close(); }
}
