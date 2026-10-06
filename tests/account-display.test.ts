import { expect, test } from "bun:test";
import { codexAccountDisplay } from "../src/account-display";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";

test("aliases win over verified emails; setup placeholders use verified identities", () => {
  expect(codexAccountDisplay("완두콩즈", "collector", "pea@example.invalid")).toBe("완두콩즈");
  expect(codexAccountDisplay("두 번째 계정", "collector", "pea@example.invalid")).toBe("pea@example.invalid");
  expect(codexAccountDisplay("Main", "default", "main@example.invalid")).toBe("main@example.invalid");
  expect(codexAccountDisplay("", "collector")).toBe("collector");
  expect(codexAccountDisplay("두 번째 계정", "collector")).toBe("두 번째 계정");
});

test("quota-verified identity reaches account status and notification titles without changing routing keys", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.codexEnabled = true;
  config.accounts.codex[0]!.label = "두 번째 계정";
  config.alerts.enabled = true;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  service.publishWorkBoundary = () => {};
  let email = "pea@example.invalid";
  let failed = false;
  const now = Date.now();
  (service as any).createCodexClient = () => ({
    get accountEmail() { return email; },
    async readRateLimits() {
      if (failed) throw new Error("synthetic transport error");
      return [{ provider: "codex", account: "default", bucket: "codex:primary:300", label: "Codex 5h",
        usedPercent: 95, windowSeconds: 18000, resetsAtMs: now + 18000_000, observedAtMs: now,
        source: "codex-appserver", quality: "authoritative", metadata: {} }];
    },
    async close() {},
  });
  const sent: any[] = [];
  (service as any).deliverDecision = async (decision: any) => { sent.push(decision); return { complete: true }; };
  try {
    await service.pollCodex();
    expect(service.accountStates(now).find(a => a.provider === "codex")?.accountLabel).toBe(email);
    await service.evaluateTriggers(now);
    expect(sent.some(d => d.presentation?.title.params.account === email)).toBeTrue();
    expect(sent.every(d => d.key.includes("codex") && !d.key.includes(email))).toBeTrue();
    expect(JSON.stringify(service.db.db.query("select metadata_json from snapshots").all())).not.toContain(email);
    failed = true;
    await expect(service.pollCodex()).rejects.toThrow("all configured Codex accounts failed");
    expect(service.accountStates(now).find(a => a.provider === "codex")?.accountLabel).toBe(email);
    config.accounts.codex[0]!.label = "완두콩즈";
    expect(service.accountStates(now).find(a => a.provider === "codex")?.accountLabel).toBe("완두콩즈");
    config.accounts.codex[0]!.label = "Main"; failed = false; email = "changed@example.invalid";
    await service.pollCodex();
    expect(service.accountStates(now).find(a => a.provider === "codex")?.accountLabel).toBe(email);
  } finally { await service.close(); }
});
