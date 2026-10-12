import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { commandExecutable, DotsConnection, findTunnelClient, validateBinding } from "../src/dots/connection";
import { DotStore } from "../src/dots/store";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-dots-connection-"));
  const home = join(root, "profile"); mkdirSync(home);
  const workspaceId = "11111111-2222-3333-4444-555555555555";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: workspaceId } }));
  const key = join(root, "runtime-key"); writeFileSync(key, "fixture-runtime-key", { mode: 0o600 });
  const binding = { account: "original", workspaceId, tunnelId: "tunnel_" + "a".repeat(32), runtimeKeyRef: "file:" + key };
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "original", label: "Original", enabled: true, codexHome: home }];
  let started = false, ready = true, remoteWorkspace = workspaceId, collision = false;
  const calls: string[][] = [];
  const connection = new DotsConnection({ root, config: () => config, binary: () => "/fixture/tunnel-client",
    command: "'/fixture/quotapie' 'dots' 'mcp'",
    runner: async (_binary, args, env) => {
      calls.push(args);
      if (args[0] === "admin") {
        expect(env?.CONTROL_PLANE_API_KEY).toBe("fixture-runtime-key");
        expect(args).not.toContain("fixture-runtime-key");
        return { id: binding.tunnelId, workspace_ids: [remoteWorkspace] };
      }
      if (args[1] === "list") return { aliases: started || collision ? [{ alias: "quotapie-dots", tunnel_id: collision ? "other" : binding.tunnelId }] : [] };
      if (args[1] === "connect") { started = true; return {}; }
      if (args[1] === "stop") { started = false; return {}; }
      if (args[1] === "status") return { tunnel_id: binding.tunnelId,
        remote: { id: binding.tunnelId, workspace_ids: [remoteWorkspace] }, process_running: started,
        healthy: started, ready, process: { target_value: "'/fixture/quotapie' 'dots' 'mcp'" } };
      throw new Error("unexpected operation");
    } });
  return { root, home, binding, config, key, connection, calls,
    setRemote: (value: string) => { remoteWorkspace = value; },
    setCollision: () => { collision = true; }, setReady: (value: boolean) => { ready = value; },
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("first-run inspection does not create a tunnel, start a process, or require a Dot name", async () => {
  const f = fixture();
  try {
    expect(await f.connection.status()).toMatchObject({ state: "authorization-required", configured: false, canConnect: false });
    expect(f.calls).toHaveLength(0);
    f.connection.save(f.binding);
    expect(statSync(join(f.root, "dots-connection.json")).mode & 0o777).toBe(0o600);
    const status = await f.connection.status();
    expect(status.state).toBe("stopped");
    expect(JSON.stringify(status)).not.toContain(f.binding.runtimeKeyRef);
    expect(JSON.stringify(status)).not.toContain(f.binding.workspaceId);
    expect(f.calls.some(a => a[1] === "connect")).toBeFalse();
  } finally { f.close(); }
});

test("connect owns only the QuotaPie runtime, is idempotent, and separates readiness from subscription", async () => {
  const f = fixture();
  try {
    f.connection.save(f.binding);
    expect((await f.connection.connect()).state).toBe("plugin-required");
    await f.connection.connect();
    expect(f.calls.filter(a => a[1] === "connect")).toHaveLength(1);
    const connect = f.calls.find(a => a[1] === "connect")!;
    expect(connect).toContain("quotapie-dots");
    expect(connect).toContain(f.binding.runtimeKeyRef);
    expect(connect).not.toContain("fixture-runtime-key");
    const store = new DotStore(join(f.root, "dots.sqlite"));
    try {
      store.observe("events/list", Date.now());
      expect((await f.connection.status()).state).toBe("subscription-required");
      store.subscribe({ id: "verified", targetId: "original", name: "quota.ready", url: "https://callback.example", secret: "fixture", expiresAtMs: Date.now() + 60000 });
      expect((await f.connection.status()).state).toBe("subscribed");
      f.setReady(false);
      expect((await f.connection.status()).state).toBe("starting");
      expect((await f.connection.disconnect()).state).toBe("stopped");
      expect(f.calls.filter(a => a[1] === "stop")).toEqual([["runtimes", "stop", "quotapie-dots"]]);
    } finally { store.close(); }
  } finally { f.close(); }
});

test("local account changes and remote workspace mismatches block startup", async () => {
  const f = fixture();
  try {
    f.connection.save(f.binding);
    f.setRemote("other-workspace");
    expect((await f.connection.status()).state).toBe("unavailable");
    await expect(f.connection.connect()).rejects.toThrow("connection-unverified");
    expect(f.calls.some(a => a[1] === "connect")).toBeFalse();
    writeFileSync(join(f.home, "auth.json"), JSON.stringify({ tokens: { account_id: "another-login" } }));
    expect((await f.connection.status()).state).toBe("account-mismatch");
    expect(() => validateBinding(f.binding, f.config)).toThrow("account-mismatch");
  } finally { f.close(); }
});

test("alias collision is never overwritten and stored secrets must remain private", async () => {
  const f = fixture();
  try {
    f.connection.save(f.binding); f.setCollision();
    await expect(f.connection.connect()).rejects.toThrow("connection-unverified");
    expect(f.calls.some(a => a[1] === "connect")).toBeFalse();
    expect(() => validateBinding({ ...f.binding, runtimeKeyRef: "sk-literal" }, f.config)).toThrow("invalid-connection");
    chmodSync(f.key, 0o644);
    expect(() => validateBinding(f.binding, f.config)).toThrow("private-runtime-key-required");
    expect(readFileSync(join(f.root, "dots-connection.json"), "utf8")).not.toContain("fixture-runtime-key");
  } finally { f.close(); }
});

test("disconnect still stops the owned runtime after the local login changes", async () => {
  const f = fixture();
  try {
    f.connection.save(f.binding); await f.connection.connect();
    writeFileSync(join(f.home, "auth.json"), JSON.stringify({ tokens: { account_id: "another-login" } }));
    expect((await f.connection.disconnect()).state).toBe("account-mismatch");
    expect(f.calls.filter(a => a[1] === "stop")).toEqual([["runtimes", "stop", "quotapie-dots"]]);
  } finally { f.close(); }
});

test("discover official manager's executable outside PATH without executing its saved shell command", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-tunnel-discovery-"));
  try {
    const binary = join(root, "tools with spaces", "tunnel-client"); mkdirSync(join(root, "tools with spaces"));
    writeFileSync(binary, "fixture", { mode: 0o700 });
    const state = join(root, "Library/Application Support/tunnel-client"); mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "processes.yaml"), JSON.stringify({ anotherApp: { command: "'" + binary + "' run --profile unrelated" } }));
    expect(findTunnelClient(root, { PATH: "" })).toBe(realpathSync(binary));
    expect(commandExecutable("/bin/sh -c 'something'")).toBeNull();
    expect(commandExecutable("$(touch /tmp/unwanted)" )).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
