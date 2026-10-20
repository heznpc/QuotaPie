import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { createRelayRuntime, type RelayRuntime, type RuntimeMemory } from "../src/codex-relay-runtime";
import { profileReference } from "../src/work-boundary";

test("a disabled historical profile cannot shadow the enabled profile sharing its directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "qp-runtime-profile-"));
  const home = join(root, "profile"), data = join(root, "data"), configPath = join(root, "config.json");
  mkdirSync(home); mkdirSync(data);
  const previousHome = process.env.QUOTAPIE_HOME, previousConfig = process.env.QUOTAPIE_CONFIG;
  process.env.QUOTAPIE_HOME = data; process.env.QUOTAPIE_CONFIG = configPath;
  const memory: RuntimeMemory = {};
  let runtime: RelayRuntime | undefined;
  const originalFetch = globalThis.fetch;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.codex = [
      { id: "historical", label: "Historical", enabled: false, codexHome: home },
      { id: "current", label: "Current", enabled: true, codexHome: home },
    ];
    config.accounts.claude = [];
    writeFileSync(configPath, JSON.stringify(config));
    const now = Date.now(), authPath = join(home, "auth.json");
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: "fixture-person", exp: (now + 3600000) / 1000 })).toString("base64url")}.fixture`;
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "fixture-workspace", access_token: token } }));
    utimesSync(authPath, (now - 5000) / 1000, (now - 5000) / 1000);
    writeFileSync(join(data, "work-state.json"), JSON.stringify({ schemaVersion: 1, generatedAtMs: now - 1000, expiresAtMs: now + 600000,
      accounts: [{ provider: "codex", account: "current", profileKey: profileReference(home), collectionState: "recent-success", collectionErrorCategory: null,
        windows: [{ bucket: "codex:primary:300", quality: "authoritative", freshness: "fresh", remainingPercent: 9,
          observedAtMs: now - 1000, resetsAtMs: now + 3600000, validUntilMs: now + 600000 }] }] }));
    const sent: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: await new Response(init?.body).text() });
      return Response.json({ native: true }, { headers: { "x-codex-primary-used-percent": "13", "x-codex-secondary-used-percent": "bad" } });
    }) as typeof fetch;
    runtime = createRelayRuntime({ port: 45000, token: "a".repeat(48), codex_home: home,
      route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" },
      taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } }, memory);
    expect(memory.sourceAccount).toBe("current");
    const health = runtime.snapshot!() as any;
    expect(health.subscriptionGuard).toMatchObject({ account: "current", ready: true, reason: "ready" });
    expect(health.subscriptionGuard.enforcement).toBe("source-identity");
    expect(health.subscriptionGuard.sourceHistoryPolicy).toBe("authenticated-source");
    expect(health.sourceContinuationRevision).toBe(3);
    expect(health.nativeRequestPolicy).toBe("source-origin");
    expect(memory.accountPool).toBeUndefined();
    const headers = { authorization: `Bearer ${token}`, "chatgpt-account-id": "fixture-workspace", "thread-id": "00000000-0000-0000-0000-000000000001" };
    const body = '{"model":"future-model","background":true,"input":[]}';
    const response = await runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/responses`, { method: "POST", headers, body }));
    expect(response.status).toBe(200); await response.text();
    expect(sent).toEqual([{ url: "https://chatgpt.com/backend-api/codex/responses", body }]);
    const evidence = (runtime.snapshot!() as any).recent.at(-1);
    expect(evidence.processingAccount).toEqual({ account: "current", evidence: "validated-outgoing-credentials" });
    expect(evidence.accountRouting).toBeUndefined();
    expect(evidence.providerQuota).toEqual({ "x-codex-primary-used-percent": 13 });
    expect(JSON.stringify(evidence)).not.toContain(token);
    // Reload must preserve an old handler's resources without invoking its old,
    // stricter continuation checker for new interactive requests.
    const oldPool = { assertSourceContinuationAsync() { throw new Error("legacy check invoked"); }, close() {} } as any;
    memory.accountPool = oldPool;
    const oldGuard = memory.guard, oldSavings = memory.savings;
    const next = createRelayRuntime({ port: 45000, token: "a".repeat(48), codex_home: home,
      route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" } }, memory);
    expect(memory.accountPool).toBe(oldPool);
    expect(memory.guard).toBe(oldGuard); expect(memory.savings).toBe(oldSavings);
    const same = createRelayRuntime({ port: 45000, token: "a".repeat(48), codex_home: home,
      route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" } }, memory);
    same.close(); next.close();
  } finally {
    globalThis.fetch = originalFetch;
    runtime?.close(); memory.dispose?.();
    if (previousHome === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.QUOTAPIE_CONFIG; else process.env.QUOTAPIE_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
