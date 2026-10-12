import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { codexProfileRoot, configPath, dataDirectory, loadConfig, type AppConfig } from "../config";
import { DotStore } from "./store";

const alias = "quotapie-dots";
export const connectionSetupURL = "https://platform.openai.com/settings/organization/tunnels";
const pluginsURL = "https://chatgpt.com/plugins";
interface Binding { account: string; workspaceId: string; tunnelId: string; runtimeKeyRef: string }
type Runner = (binary: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<any>;
export interface ConnectionStatus {
  state: "tool-missing" | "authorization-required" | "account-mismatch" | "stopped" | "starting" | "plugin-required" | "subscription-required" | "subscribed" | "unavailable";
  toolAvailable: boolean; configured: boolean; processRunning: boolean; healthy: boolean; ready: boolean;
  discoveryObserved: boolean; activeSubscriptions: number; enabledTargets: number;
  nextURL: string | null; canConnect: boolean; canDisconnect: boolean;
}

function readObject(path: string): any {
  try {
    if (statSync(path).size > 1024 * 1024) return null;
    const content = readFileSync(path, "utf8");
    return path.endsWith(".json") ? JSON.parse(content) : Bun.YAML.parse(content);
  } catch { return null; }
}

/** Read only the executable word from the official manager's saved command.
 * Never execute that command or inherit another application's MCP binding. */
export function commandExecutable(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const word = command.match(/^(?:'([^']+)'|"([^"$`]+)"|([^\s'"$`]+))(?:\s|$)/);
  const path = word?.[1] ?? word?.[2] ?? word?.[3];
  return path && isAbsolute(path) && basename(path) === "tunnel-client" ? path : null;
}

export function findTunnelClient(home = homedir(), env = process.env): string | null {
  const stateRoot = join(home, "Library/Application Support/tunnel-client");
  const processes = readObject(join(stateRoot, "processes.yaml"));
  const candidates = [env.QUOTAPIE_TUNNEL_CLIENT, Bun.which("tunnel-client", { PATH: env.PATH ?? "" }),
    "/opt/homebrew/bin/tunnel-client", "/usr/local/bin/tunnel-client",
    ...Object.values(processes ?? {}).map((p: any) => commandExecutable(p?.command))];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || basename(candidate) !== "tunnel-client") continue;
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return realpathSync(candidate); } catch {}
  }
  return null;
}

export function validateBinding(input: unknown, config: AppConfig): Binding {
  const b = input as Binding;
  if (!b || typeof b !== "object" || Array.isArray(b) ||
      Object.keys(b).some(k => !["account", "workspaceId", "tunnelId", "runtimeKeyRef"].includes(k)) ||
      typeof b.account !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(b.workspaceId ?? "") ||
      !/^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(b.tunnelId ?? "") ||
      typeof b.runtimeKeyRef !== "string" || !/^(?:env:[A-Z][A-Z0-9_]*|file:\/[^\n\r\0]+)$/.test(b.runtimeKeyRef))
    throw new Error("invalid-connection");
  const profile = config.accounts.codex.find(p => p.id === b.account && p.enabled);
  if (!profile) throw new Error("account-mismatch");
  const auth = readObject(join(codexProfileRoot(profile), "auth.json"));
  if (auth?.tokens?.account_id !== b.workspaceId) throw new Error("account-mismatch");
  // A reference is enough; credentials never enter HTTP responses or command arguments.
  if (b.runtimeKeyRef.startsWith("file:")) {
    const stat = statSync(b.runtimeKeyRef.slice(5));
    if (!stat.isFile() || stat.size === 0 || stat.size > 16384 || (stat.mode & 0o077) !== 0)
      throw new Error("private-runtime-key-required");
  } else if (!process.env[b.runtimeKeyRef.slice(4)]) throw new Error("runtime-key-unavailable");
  return { account: b.account, workspaceId: b.workspaceId, tunnelId: b.tunnelId, runtimeKeyRef: b.runtimeKeyRef };
}

const run: Runner = async (binary, args, env) => {
  const child = Bun.spawn([binary, ...args, "--json"], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0 || output.length > 1024 * 1024) throw new Error("connection-command-failed");
    return JSON.parse(output);
  } finally { clearTimeout(timer); }
};
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export class DotsConnection {
  private busy = false;
  constructor(private readonly options: {
    root?: string; config?: () => AppConfig; binary?: () => string | null; runner?: Runner; command?: string;
  } = {}) {}
  private get root() { return this.options.root ?? dataDirectory(); }
  private get path() { return join(this.root, "dots-connection.json"); }
  private config() { return (this.options.config ?? loadConfig)(); }
  private binary() { return (this.options.binary ?? findTunnelClient)(); }
  private invoke(binary: string, args: string[], env?: NodeJS.ProcessEnv) { return (this.options.runner ?? run)(binary, args, env); }
  private binding() { return validateBinding(readObject(this.path), this.config()); }
  private async verifyRemote(binary: string, b: Binding) {
    const key = b.runtimeKeyRef.startsWith("file:") ? readFileSync(b.runtimeKeyRef.slice(5), "utf8").trim() :
      process.env[b.runtimeKeyRef.slice(4)]!;
    const remote = await this.invoke(binary, ["admin", "tunnels", "get", b.tunnelId,
      "--control-plane.base-url", "https://api.openai.com"], { ...process.env,
      CONTROL_PLANE_API_KEY: key, OPENAI_ADMIN_KEY: undefined, CONTROL_PLANE_URL_PATH: undefined });
    if (remote?.id !== b.tunnelId || remote.workspace_ids?.length !== 1 ||
        remote.workspace_ids[0] !== b.workspaceId) throw new Error("workspace-unverified");
  }
  private command() {
    if (this.options.command) return this.options.command;
    // Resolve to the same CLI distribution as this server, not an older installation.
    const cli = resolve(import.meta.dir, "../cli.ts");
    if (!existsSync(cli)) throw new Error("cli-unavailable");
    return ["/usr/bin/env", "QUOTAPIE_HOME=" + this.root, "QUOTAPIE_CONFIG=" + configPath(),
      process.execPath, cli, "dots", "mcp"].map(quote).join(" ");
  }
  save(input: unknown) {
    const binding = validateBinding(input, this.config());
    if (existsSync(this.path)) {
      const old = readObject(this.path);
      if (JSON.stringify(old) !== JSON.stringify(binding)) throw new Error("connection-already-configured");
      return;
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = this.path + ".tmp";
    writeFileSync(temp, JSON.stringify(binding, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, this.path);
  }
  async status(): Promise<ConnectionStatus> {
    const binary = this.binary();
    const result: ConnectionStatus = { state: binary ? "authorization-required" : "tool-missing",
      toolAvailable: !!binary, configured: existsSync(this.path), processRunning: false, healthy: false, ready: false,
      discoveryObserved: false, activeSubscriptions: 0, enabledTargets: 0,
      nextURL: connectionSetupURL, canConnect: false, canDisconnect: false };
    if (!binary || !result.configured) return result;
    let b: Binding;
    try { b = this.binding(); } catch (e) {
      result.state = e instanceof Error && e.message === "account-mismatch" ? "account-mismatch" : "authorization-required";
      return result;
    }
    result.canConnect = true;
    try {
      const list = await this.invoke(binary, ["runtimes", "list"]);
      const own = list.aliases?.find((a: any) => a.alias === alias);
      if (!own) {
        await this.verifyRemote(binary, b);
        result.state = "stopped"; return result;
      }
      if (own.tunnel_id !== b.tunnelId) throw new Error("alias-mismatch");
      const s = await this.invoke(binary, ["runtimes", "status", alias]);
      if (s.tunnel_id !== b.tunnelId) throw new Error("binding-mismatch");
      result.processRunning = s.process_running === true;
      if (result.processRunning && s.process?.target_value !== this.command()) throw new Error("binding-mismatch");
      result.canDisconnect = result.processRunning;
      if (s.remote?.id !== b.tunnelId || s.remote?.workspace_ids?.length !== 1 ||
          s.remote.workspace_ids[0] !== b.workspaceId) throw new Error("workspace-unverified");
      result.healthy = result.processRunning && s.healthy === true;
      result.ready = result.healthy && s.ready === true;
      const store = new DotStore(join(this.root, "dots.sqlite"));
      try {
        result.discoveryObserved = store.observed("events/list") != null;
        result.activeSubscriptions = store.subscriptions().filter(s => s.expiresAtMs > Date.now()).length;
        result.enabledTargets = store.targets().filter(s => s.policy.enabled && s.policy.expiresAtMs > Date.now()).length;
      } finally { store.close(); }
      result.state = !result.processRunning ? "stopped" : !result.ready ? "starting" :
        !result.discoveryObserved ? "plugin-required" : !result.activeSubscriptions ? "subscription-required" : "subscribed";
      result.nextURL = result.state === "plugin-required" ? pluginsURL : null;
      return result;
    } catch {
      result.state = "unavailable"; result.canConnect = false;
      result.ready = false; return result;
    }
  }
  async connect() {
    if (this.busy) throw new Error("connection-busy");
    this.busy = true;
    try {
      const b = this.binding(), binary = this.binary();
      if (!binary) throw new Error("tool-missing");
      const current = await this.status();
      if (!current.canConnect) throw new Error("connection-unverified");
      await this.verifyRemote(binary, b);
      if (!current.processRunning) await this.invoke(binary, ["runtimes", "connect", "--alias", alias,
        "--tunnel-id", b.tunnelId, "--runtime-api-key", b.runtimeKeyRef,
        "--control-plane-base-url", "https://api.openai.com",
        "--profile-dir", join(this.root, "dots-tunnel"), "--profile", alias, "--mcp-command", this.command()]);
      return await this.status();
    } finally { this.busy = false; }
  }
  async disconnect() {
    if (this.busy) throw new Error("connection-busy");
    this.busy = true;
    try {
      // Revocation must still work after login changes or remote connectivity is lost.
      // Use the saved local runtime identity, never a new account's credentials.
      const saved = readObject(this.path), binary = this.binary();
      if (!binary || !/^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(saved?.tunnelId ?? ""))
        throw new Error("connection-unverified");
      const list = await this.invoke(binary, ["runtimes", "list"]);
      const own = list.aliases?.find((a: any) => a.alias === alias);
      if (own?.tunnel_id !== saved.tunnelId) throw new Error("connection-unverified");
      const local = await this.invoke(binary, ["runtimes", "status", alias]);
      if (local.tunnel_id !== saved.tunnelId || local.process?.target_value !== this.command())
        throw new Error("connection-unverified");
      const store = new DotStore(join(this.root, "dots.sqlite"));
      try { for (const state of store.targets()) store.setEnabled(state.policy.id, false); } finally { store.close(); }
      await this.invoke(binary, ["runtimes", "stop", alias]);
      return await this.status();
    } finally { this.busy = false; }
  }
}
