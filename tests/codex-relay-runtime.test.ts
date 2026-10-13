import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { createRelayRuntime, type RelayRuntime, type RuntimeMemory } from "../src/codex-relay-runtime";
import { profileReference } from "../src/work-boundary";

test("a disabled historical profile cannot shadow the enabled profile sharing its directory", () => {
  const root = mkdtempSync(join(tmpdir(), "qp-runtime-profile-"));
  const home = join(root, "profile"), data = join(root, "data"), configPath = join(root, "config.json");
  mkdirSync(home); mkdirSync(data);
  const previousHome = process.env.QUOTAPIE_HOME, previousConfig = process.env.QUOTAPIE_CONFIG;
  process.env.QUOTAPIE_HOME = data; process.env.QUOTAPIE_CONFIG = configPath;
  const memory: RuntimeMemory = {};
  let runtime: RelayRuntime | undefined;
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
    runtime = createRelayRuntime({ port: 45000, token: "a".repeat(48), codex_home: home,
      route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" },
      taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } }, memory);
    expect(memory.sourceAccount).toBe("current");
    const health = runtime.snapshot!() as any;
    expect(health.subscriptionGuard).toMatchObject({ account: "current", ready: true, reason: "ready" });
    expect(health.subscriptionGuard.windows[0].remainingPercent).toBe(9);
  } finally {
    runtime?.close(); memory.dispose?.();
    if (previousHome === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.QUOTAPIE_CONFIG; else process.env.QUOTAPIE_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
