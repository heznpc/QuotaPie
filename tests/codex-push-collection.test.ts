import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { parseCodexRateLimits } from "../src/providers/codex-appserver";
import { CODEX_SOURCE, QuotaPieService } from "../src/service";
import { buildWorkBoundary, writeWorkBoundary } from "../src/work-boundary";
import type { QuotaObservation } from "../src/types";

function fixture() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.staleAfterSeconds = 60;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const directory = mkdtempSync(join(tmpdir(), "quotapie-push-boundary-"));
  const boundaryPath = join(directory, "work-state.json");
  service.publishWorkBoundary = (nowMs = Date.now(), windows) => {
    writeWorkBoundary(buildWorkBoundary(service.accountStates(nowMs, windows), [], config, nowMs), boundaryPath);
  };
  // Exercise the registered service callback without starting a real provider.
  const client = (service as any).createCodexClient(config.accounts.codex[0]);
  const update = (observations: QuotaObservation[]) => client.notificationHandler(observations);
  return { config, service, update, boundaryPath, close: async () => {
    await client.close(); await service.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

function quota(nowMs: number) {
  return parseCodexRateLimits({ rateLimits: { limitId: "codex", primary: {
    usedPercent: 10, windowDurationMins: 300, resetsAt: (nowMs + 3_600_000) / 1_000,
  } } }, nowMs);
}

test("validated push recovery restores collection health alongside fresh quota", async () => {
  const { config, service, update, close } = fixture();
  try {
    const nowMs = Date.now();
    service.collection.recordAttempt("codex", "default", CODEX_SOURCE, nowMs - 120_000, null);
    service.collection.recordAttempt("codex", "default", CODEX_SOURCE, nowMs - 30_000,
      "temporary provider failure", "provider-error");
    await update(quota(nowMs));
    const account = buildWorkBoundary(service.accountStates(nowMs), [], config, nowMs).accounts
      .find(account => account.provider === "codex" && account.account === "default")!;
    expect(account.collectionState).toBe("recent-success");
    expect(account.windows[0]?.freshness).toBe("fresh");
    expect(account.windows[0]?.remainingPercent).toBe(90);
    expect(service.collection.sourceStates()[0]?.lastErrorCategory).toBeNull();
    expect(service.codexPollResults()[0]).toEqual({ account: "default", count: 1, error: null });
  } finally { await close(); }
});

test("empty push reads retain the previous snapshot without reporting collection success", async () => {
  const { service, update, close } = fixture();
  try {
    const nowMs = Date.now();
    service.ingestCodexSnapshot(quota(nowMs - 120_000));
    service.collection.recordAttempt("codex", "default", CODEX_SOURCE, nowMs - 120_000, null);
    await update([]);
    const state = service.collection.sourceStates()[0]!;
    expect(state.lastSuccessMs).toBe(nowMs - 120_000);
    expect(state.lastErrorCategory).toBe("no-windows");
    expect(service.db.latestAll()).toHaveLength(1);
    expect(service.accountStates(nowMs)[0]?.collection.health).toBe("attempted-then-failed");
    expect(service.codexPollResults()[0]).toEqual({ account: "default", count: 0,
      error: "rate limit response contained no windows" });
  } finally { await close(); }
});

test("an exhaustion push reaches the routing boundary before a slow provider finishes, without history analysis", async () => {
  const { service, update, boundaryPath, close } = fixture();
  let release!: () => void;
  const slowProvider = new Promise<void>(resolve => { release = resolve; });
  const poll = spyOn(service, "pollCodex").mockResolvedValue([]);
  const claude = spyOn(service, "pollClaudeOAuth").mockImplementation(async () => { await slowProvider; return []; });
  const history = spyOn(service.db, "analysisHistory");
  const boundary = spyOn(service, "publishBoundary").mockResolvedValue(undefined);
  const tick = service.tick();
  try {
    await Promise.resolve();
    const exhausted = quota(Date.now()).map(window => ({ ...window, usedPercent: 100 }));
    await update(exhausted);
    const document = JSON.parse(readFileSync(boundaryPath, "utf8"));
    expect(document.accounts[0].collectionState).toBe("recent-success");
    expect(document.accounts[0].windows[0].remainingPercent).toBe(0);
    expect(document.accounts[0].windows[0].observedAtMs).toBe(exhausted[0]!.observedAtMs);
    expect(history).not.toHaveBeenCalled();
    expect(boundary).not.toHaveBeenCalled();
  } finally {
    release(); await tick;
    poll.mockRestore(); claude.mockRestore(); history.mockRestore(); boundary.mockRestore(); await close();
  }
});
