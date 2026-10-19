import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { fakeCodexLogin } from "./helpers/account";

test("new reset evidence requests a real account observation while repeated signals retain the force cooldown", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-reset-wakeup-"));
  fakeCodexLogin(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts = { codex: [{ id: "plus", label: "Fixture Plus", enabled: true, codexHome: root }], claude: [] };
  config.collection.codexEnabled = true; config.collection.claudeOAuthEnabled = false;
  config.collection.pollSeconds = 60; config.alerts.enabled = false; config.resetSignals.enabled = true;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"), { workState: null, quota: null });
  let now = 2_000_000_000_000, reads = 0, evidenceAt = now;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const factory = spyOn(service as any, "createCodexClient").mockImplementation(() => ({
    readRateLimits: async () => {
      reads++;
      return [{ provider: "codex", account: "plus", bucket: "codex:primary:300", label: "5h", windowSeconds: 18000,
        usedPercent: 20, observedAtMs: now, resetsAtMs: now + 3600000, source: "fixture", quality: "authoritative" }];
    }, close: async () => {},
  }));
  const signal = spyOn(service.signalCollector, "poll").mockImplementation(async () => {
    service.resetSignals.setHealth({ lastAttemptMs: now, lastSuccessMs: now, error: null, cursorMs: now, source: "fixture",
      sources: [{ id: "fixture", coverage: "fixture", lastAttemptMs: now, lastSuccessMs: now, error: null,
        cursorMs: now, latestPublishedAtMs: evidenceAt, lastEvidenceMs: evidenceAt, newEvidenceCount: 1, fingerprints: [String(evidenceAt)] }] });
  });
  try {
    (service as any).jobsEnabled = true;
    await service.tick();
    expect(reads).toBe(1);
    now += 1000;
    await service.tick();
    expect(reads).toBe(1); // Normal wake respects this account's future deadline.
    await service.collectResetSignals();
    expect(service.collectionStatus().refreshing).toBe(true);
    await service.tick();
    expect(reads).toBe(2); // A new public signal requests observation, not entitlement.
    expect(service.work.store.executions()).toHaveLength(0);
    const firstRequest = service.collectionStatus().requestedAtMs;
    now += 1000; evidenceAt = now;
    await service.collectResetSignals(); await service.tick();
    expect(reads).toBe(2);
    expect(service.collectionStatus().requestedAtMs).toBe(firstRequest);
    now = firstRequest! + QuotaPieService.FORCED_COLLECTION_MIN_INTERVAL_MS;
    await service.collectResetSignals(); await service.tick();
    expect(reads).toBe(2); // The same already-seen evidence cannot create a loop.
    evidenceAt = now;
    await service.collectResetSignals(); await service.tick();
    expect(reads).toBe(3);
    expect(service.work.store.executions()).toHaveLength(0);
  } finally {
    clock.mockRestore(); factory.mockRestore(); signal.mockRestore();
    await service.close(); rmSync(root, { recursive: true, force: true });
  }
});
