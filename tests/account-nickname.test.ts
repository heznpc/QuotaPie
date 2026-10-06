import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { saveAccountNickname } from "../src/account-nickname";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";

test("nickname API persists each provider independently, refreshes labels, clears to login identity, and rejects unsafe writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "qp-nickname-")), path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ custom: "preserved", collection: { codexEnabled: false },
    accounts: { codex: [{ id: "default", label: "Main", codexHome: null, enabled: true }],
      claude: [{ id: "default", label: "Main", configDir: "~/.claude", keychainService: null, enabled: true }] } }));
  const config = loadConfig(path); config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  (service as any).codexAccountNames.set("default", "synthetic@example.invalid");
  const server = startDashboard(service, config, { preferencesPath: path, compactionRoot: root, poolDatabasePath: join(root, "pool.db"), poolPolicyPath: join(root, "pool.json") });
  const origin = `http://127.0.0.1:${server.port}`;
  const status = async () => await (await fetch(origin + "/api/status")).json() as any;
  try {
    const token = (await status()).actionToken;
    const post = (nickname: unknown, provider = "codex", extra: Record<string, string> = {}) => fetch(origin + "/api/accounts/nickname", {
      method: "POST", headers: { "x-quotapie-action-token": token, "content-type": "application/json", ...extra },
      body: JSON.stringify({ provider, account: "default", nickname }) });
    expect((await post("완두콩즈", "codex", { "x-quotapie-action-token": "wrong" })).status).toBe(403);
    expect((await post("완두콩즈", "codex", { origin: "https://example.invalid" })).status).toBe(403);
    for (const invalid of [12, "x".repeat(81), "a\nb", "a\0b"]) expect((await post(invalid)).status).toBe(400);
    expect((await post("완두콩즈", "invented")).status).toBe(400);
    expect((await post("  완두콩즈  ")).status).toBe(200);
    let payload = await status();
    expect(payload.accounts.find((a: any) => a.provider === "codex").accountLabel).toBe("완두콩즈");
    expect(payload.accounts.find((a: any) => a.provider === "codex").nickname).toBe("완두콩즈");
    expect((await post("Work", "claude")).status).toBe(200);
    const persisted = loadConfig(path);
    expect(persisted.accounts.codex[0]!.nickname).toBe("완두콩즈");
    expect(persisted.accounts.claude[0]!.nickname).toBe("Work");
    expect(persisted.accounts.codex[0]!.id).toBe("default");
    expect(persisted.accounts.codex[0]!.codexHome).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).custom).toBe("preserved");
    // An explicit nickname may equal a legacy setup placeholder.
    expect((await post("Main")).status).toBe(200);
    expect((await status()).accounts.find((a: any) => a.provider === "codex").accountLabel).toBe("Main");
    expect((await post("")).status).toBe(200);
    expect((await status()).accounts.find((a: any) => a.provider === "codex").accountLabel).toBe("synthetic@example.invalid");
    const events: any[] = [];
    (service as any).deliverDecision = async (decision: any) => { events.push(decision); return { complete: true }; };
    await post("완두콩즈");
    service.db.insertEvent({ provider: "codex", account: "default", bucket: "short", kind: "credit_topup", severity: "info",
      occurredAtMs: Date.now(), confidence: "high", displayText: "synthetic", details: { balanceBefore: 1, balanceAfter: 2 } });
    await service.evaluateTriggers();
    expect(events[0].presentation.title.params.account).toBe("완두콩즈");
    expect(() => saveAccountNickname(config, { provider: "codex", account: "missing", nickname: "Other" }, path)).toThrow("account_not_found");
    const changed = JSON.parse(readFileSync(path, "utf8")); changed.accounts.codex[0].label = "Manual change";
    writeFileSync(path, JSON.stringify(changed));
    expect((await post("Other")).status).toBe(409);
    expect(loadConfig(path).accounts.codex[0]!.label).toBe("Manual change");
    expect(() => saveAccountNickname(config, { provider: "codex", account: "missing", nickname: "Other" }, path)).toThrow("settings_changed");
  } finally { server.stop(true); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
