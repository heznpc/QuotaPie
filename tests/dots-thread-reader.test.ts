import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { resumeProfileKey, type ResumeGate } from "../src/resume-gate";
import { readConfiguredThread, readExecutionConfiguration, type ThreadReadTransport } from "../src/dots/thread-reader";
import type { DotPolicy } from "../src/dots/store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function credentials(root: string, subject = "fixture-user", accessEmail = "fixture@example.test") {
  const jwt = (claims: unknown) => "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".signature";
  const claims = { sub: subject, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } };
  writeFileSync(join(root, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { account_id: "fixture-account", id_token: jwt({ ...claims, email: "fixture@example.test" }),
      access_token: jwt({ ...claims, "https://api.openai.com/profile": { email: accessEmail } }) } }));
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-thread-reader-"))); roots.push(root);
  credentials(root);
  const threadId = "11111111-2222-3333-4444-555555555555";
  mkdirSync(join(root, "sessions"));
  const path = join(root, "sessions", "rollout.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: threadId } }) + "\n");
  const db = new Database(join(root, "state_5.sqlite"));
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  db.run("INSERT INTO threads VALUES (?,?)", [threadId, path]); db.close();
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "plus-profile", label: "Plus", enabled: true, codexHome: root }];
  const policy: DotPolicy = { id: "original", threadId, account: "plus-profile", profileKey: resumeProfileKey(config, "codex", "plus-profile")!,
    accountKey: "a".repeat(64), continuation: "unused", enabled: false, trigger: "quota.ready", resetWithinMinutes: 30,
    reservePercent: 10, maxTurns: 1, maxUsagePercent: 5, expiresAtMs: Date.now() + 3600000, priority: 0 };
  let gate: ResumeGate = { schemaVersion: 1, provider: "codex", account: policy.account, profileKey: policy.profileKey,
    accountKey: policy.accountKey, ready: false, reason: "reserve-reached", checkedAtMs: Date.now(), retryAtMs: null, windows: [] };
  let thread: any = { id: threadId, cwd: root, path, name: "Original task", status: { type: "notLoaded" },
    preview: "private transcript", turns: [{ content: "private transcript" }], tokens: "private credential" };
  let account: any = { account: { type: "chatgpt", email: "fixture@example.test", planType: "plus" } };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closed = 0, opened = 0;
  const options = {
    readGate: async () => gate,
    binary: () => "/official/bundled/codex",
    transport: async (binary: string, codexHome: string): Promise<ThreadReadTransport> => {
      expect(binary).toBe("/official/bundled/codex"); expect(codexHome).toBe(root); opened++;
      return { request: async (method, params) => {
        calls.push({ method, params });
        return method === "thread/read" ? { thread } : method === "account/read" ? account : {};
      }, close: async () => { closed++; } };
    },
  };
  return { root, path, config, policy, options, calls, get opened() { return opened; }, get closed() { return closed; },
    setThread: (next: any) => { thread = { ...thread, ...next }; }, setGate: (next: Partial<ResumeGate>) => { gate = { ...gate, ...next }; },
    setAccount: (next: any) => { account = next; } };
}

test("reads only the configured profile and excludes transcript, credentials and live-state claims", async () => {
  const f = fixture();
  const result = await readConfiguredThread(f.config, f.policy, f.options);
  expect(result).toMatchObject({ threadId: f.policy.threadId, title: "Original task", account: "plus-profile", found: true,
    appServerStatus: "notLoaded", runtimeStateVerified: false, resumeAllowed: false });
  expect(JSON.stringify(result)).not.toMatch(/private transcript|private credential|example\.test/);
  expect(result).not.toHaveProperty("cwd"); expect(JSON.stringify(result)).not.toContain(f.root);
  expect(f.calls.map(c => c.method)).toEqual(["initialize", "account/read", "thread/read", "account/read"]);
  expect(f.calls[2]!.params).toEqual({ threadId: f.policy.threadId, includeTurns: false });
  expect(f.closed).toBe(1);
});

test("rejects the default-host profile or changed account before opening a client", async () => {
  const f = fixture();
  await expect(readConfiguredThread(f.config, { ...f.policy, account: "default" }, f.options)).rejects.toThrow("profile-mismatch");
  f.setGate({ accountKey: "b".repeat(64) });
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("account-profile-mismatch");
  expect(f.opened).toBe(0);
});

test("rejects a database path pointing to another profile or mismatched session metadata", async () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ type: "session_meta", payload: { id: "other" } }) + "\n");
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("thread-profile-unverified");
  rmSync(f.path); symlinkSync(join(f.root, "outside.jsonl"), f.path);
  writeFileSync(join(f.root, "outside.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: f.policy.threadId } }) + "\n");
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("thread-profile-unverified");
  expect(f.opened).toBe(0);
});

test("rejects API billing auth and always reaps the metadata child", async () => {
  const f = fixture(); f.setAccount({ account: { type: "apiKey" } });
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("subscription-account-unverified");
  expect(f.closed).toBe(1); expect(f.calls.some(c => c.method === "thread/read")).toBeFalse();
});

test("revalidates account binding after the read and never accepts another thread", async () => {
  const f = fixture(); let reads = 0;
  const original = f.options.readGate;
  f.options.readGate = async () => { if (++reads === 2) f.setGate({ accountKey: "b".repeat(64) }); return original(); };
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("account-profile-mismatch");
  expect(f.closed).toBe(1);
  f.setGate({ accountKey: f.policy.accountKey }); f.options.readGate = original;
  f.setThread({ id: "other" });
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("thread-profile-unverified");
  expect(f.closed).toBe(2);
});

test("even an idle status from the separate metadata server cannot authorize continuation", async () => {
  const f = fixture(); f.setThread({ status: { type: "idle" } });
  expect(await readConfiguredThread(f.config, f.policy, f.options)).toMatchObject({ appServerStatus: "idle", runtimeStateVerified: false, resumeAllowed: false });
});

test("rejects keychain credentials and internally inconsistent local identity before launching", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("subscription-file-credentials-required");
  writeFileSync(join(f.root, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  credentials(f.root, "fixture-user", "other@example.test");
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("subscription-account-unverified");
  expect(f.opened).toBe(0);
});

test("rejects a stable app-server account that differs from the bound profile", async () => {
  const f = fixture();
  f.setAccount({ account: { type: "chatgpt", email: "other@example.test", planType: "pro" } });
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("account-profile-mismatch");
  expect(f.calls.some(c => c.method === "thread/read")).toBeFalse(); expect(f.closed).toBe(1);
});

test("rejects a same-email subject change during the read even if the gate response is stale", async () => {
  const f = fixture(), original = f.options.transport;
  f.options.transport = async (binary, root) => {
    const transport = await original(binary, root), request = transport.request;
    transport.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/read") credentials(f.root, "another-subject");
      return result;
    };
    return transport;
  };
  await expect(readConfiguredThread(f.config, f.policy, f.options)).rejects.toThrow("account-profile-mismatch");
  expect(f.closed).toBe(1);
});


test("effective config extracts every MCP name but no values and detects layer changes", async () => {
  const f = fixture(), original = f.options.transport;
  const layer = join(f.root, "config.toml"); writeFileSync(layer, 'cli_auth_credentials_store="file"\n');
  f.options.transport = async (...args) => {
    const transport = await original(...args), request = transport.request;
    transport.request = async (method, params) => method === "config/read" ? {
      config: { mcp_servers: { inherited: { command: "private-command", env: { SECRET: "private-key" } } } },
      layers: [{ name: { type: "user", file: layer }, config: { mcp_servers: { disabled: { enabled: false } } } }],
    } : request(method, params);
    return transport;
  };
  const result = await readExecutionConfiguration(f.config, f.policy, f.root, f.options);
  expect(result.mcpServers).toEqual(["disabled", "inherited"]); expect(result.unchanged()).toBeTrue();
  expect(JSON.stringify(result)).not.toMatch(/private-command|private-key|config.toml/);
  writeFileSync(layer, 'cli_auth_credentials_store="file"\n# changed\n'); expect(result.unchanged()).toBeFalse();
  expect(f.closed).toBe(1);
});

test("non-file managed config layers cannot pretend to have a stable local snapshot", async () => {
  const f = fixture(), original = f.options.transport;
  f.options.transport = async (...args) => {
    const transport = await original(...args), request = transport.request;
    transport.request = async (method, params) => method === "config/read" ? {
      config: {}, layers: [{ name: { type: "enterpriseManaged", id: "private", name: "private" }, config: {} }],
    } : request(method, params);
    return transport;
  };
  await expect(readExecutionConfiguration(f.config, f.policy, f.root, f.options)).rejects.toThrow("execution-config-external-layer");
  expect(f.closed).toBe(1);
});
