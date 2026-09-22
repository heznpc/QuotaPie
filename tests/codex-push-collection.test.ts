import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { parseCodexRateLimits } from "../src/providers/codex-appserver";
import { CODEX_SOURCE, QuotaPieService } from "../src/service";
import { buildWorkBoundary } from "../src/work-boundary";
import type { QuotaObservation } from "../src/types";

function fixture() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.staleAfterSeconds = 60;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  // Exercise the registered service callback without starting a real provider.
  const client = (service as any).createCodexClient(config.accounts.codex[0]);
  const update = (observations: QuotaObservation[]) => client.notificationHandler(observations);
  return { config, service, update, close: async () => { await client.close(); await service.close(); } };
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
