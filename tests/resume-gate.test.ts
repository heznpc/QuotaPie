import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { evaluateResumeGate } from "../src/resume-gate";
import { startDashboard } from "../src/server";
import { QuotaPieService } from "../src/service";
import type { AccountState, WindowAnalysis } from "../src/types";
import { fakeCodexLogin } from "./helpers/account";

const NOW = 10_000_000;
function account(): AccountState {
  return { provider: "codex", account: "fixture", accountLabel: "Fixture", enabled: true,
    collection: { health: "recent-success", activeSource: "codex-appserver",
      lastSuccessAtMs: NOW - 1000, errorCategory: null, errorDetail: null, sources: [] },
    windows: [300 * 60, 7 * 86400].map((seconds, i) => ({
      provider: "codex", account: "fixture", bucket: i ? "codex:secondary:10080" : "codex:primary:300",
      quality: "authoritative", freshness: "fresh", remainingPercent: 40, reservePercent: i ? 15 : 10,
      observedAtMs: NOW - 1000, resetsAtMs: NOW + seconds * 1000,
    } as WindowAnalysis)), bottleneckBucket: "short", updatedAtMs: NOW - 1000 };
}
test("the host may resume only when every measured window exceeds its own reserve", () => {
  const state = account();
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeTrue();
  state.windows[1]!.remainingPercent = 15;
  expect(evaluateResumeGate(state, "codex", "fixture", NOW)).toMatchObject({
    ready: false, reason: "reserve-reached", retryAtMs: state.windows[1]!.resetsAtMs });
  state.windows[1]!.remainingPercent = 0;
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeFalse();
});
test("reset clock passing is never treated as quota recovery", () => {
  const state = account();
  state.windows[0]!.resetsAtMs = NOW;
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).reason).toBe("reset-unconfirmed");
  state.windows[0]!.resetsAtMs = NOW + 3600000;
  state.windows[0]!.remainingPercent = 90;
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeTrue();
});

test("independent model lanes are opt-in and cannot replace a missing general allowance", () => {
  const state = account();
  const spark = { ...state.windows[0]!, bucket: "codex_bengalfox:primary:300", remainingPercent: 0 };
  state.windows.push(spark);
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeTrue();
  expect(evaluateResumeGate(state, "codex", "fixture", NOW, 120000, spark.bucket).ready).toBeFalse();
  expect(evaluateResumeGate(state, "codex", "fixture", NOW, 120000, "absent").reason).toBe("quota-unknown");
  state.windows = [{ ...spark, remainingPercent: 50 }];
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).reason).toBe("quota-unknown");
});
test("unknown, stale, estimated and future snapshots cannot permit an unattended continuation", () => {
  for (const patch of [
    { remainingPercent: null }, { remainingPercent: NaN }, { reservePercent: NaN },
    { quality: "estimated" }, { observedAtMs: NOW + 1 }, { observedAtMs: NOW - 120001 },
    { freshness: "stale" }, { freshness: "unknown" }, { resetsAtMs: null },
  ]) {
    const state = account(); Object.assign(state.windows[0]!, patch);
    expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeFalse();
  }
  const state = account(); state.windows = [];
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeFalse();
});
test("a different, disabled or failed account cannot stand in for the requested account", () => {
  const state = account();
  expect(evaluateResumeGate(state, "codex", "other", NOW).reason).toBe("account-unavailable");
  state.enabled = false;
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).ready).toBeFalse();
  state.enabled = true; state.collection.errorCategory = "auth-required";
  expect(evaluateResumeGate(state, "codex", "fixture", NOW).reason).toBe("collection-unavailable");
});
test("the running API and real CLI return the same recovery decision without starting a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-resume-gate-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dashboard.port = 0;
  config.accounts.codex = [{ id: "fixture", label: "Fixture", codexHome: join(root, "profile"), enabled: true }];
  config.accounts.claude = [];
  config.alerts.enabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const now = Date.now();
  const state = account();
  for (const w of state.windows) { w.observedAtMs = now; w.resetsAtMs = now + 3600000; }
  state.collection.lastSuccessAtMs = now;
  service.accountStates = () => [state];
  const server = startDashboard(service, config, { compactionRoot: join(root, "no-relays") });
  config.dashboard.port = server.port!;
  const path = join(root, "config.json");
  mkdirSync(join(root, "profile"));
  fakeCodexLogin(join(root, "profile"));
  writeFileSync(path, JSON.stringify(config));
  const url = "http://127.0.0.1:" + server.port + "/api/resume-check?provider=codex&account=fixture";
  async function check() {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "resume-check", "--account", "fixture", "--json"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, QUOTAPIE_CONFIG: path,
        QUOTAPIE_HOME: join(root, "data"), CODEX_HOME: join(root, "profile") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); return { code, gate: JSON.parse(stdout) };
  }
  try {
    expect((await (await fetch(url)).json() as { ready: boolean }).ready).toBeTrue();
    const originalKey = (await (await fetch(url)).json() as { accountKey: string }).accountKey;
    expect(originalKey).toMatch(/^[a-f0-9]{64}$/);
    fakeCodexLogin(join(root, "profile"), "another-account");
    expect((await (await fetch(url)).json() as { accountKey: string }).accountKey).not.toBe(originalKey);
    fakeCodexLogin(join(root, "profile"));
    expect((await (await fetch(url)).json() as { accountKey: string }).accountKey).toBe(originalKey);
    expect(await check()).toMatchObject({ code: 0, gate: { ready: true, account: "fixture" } });
    const otherRoot = join(root, "other-profile");
    mkdirSync(otherRoot);
    config.accounts.codex[0]!.codexHome = otherRoot;
    writeFileSync(path, JSON.stringify(config));
    // The daemon keeps its old profile while the CLI reads the changed file.
    service.config.accounts.codex[0]!.codexHome = join(root, "profile");
    expect(await check()).toMatchObject({ code: 69, gate: { ready: false, reason: "profile-mismatch" } });
    writeFileSync(path, JSON.stringify(service.config));
    state.windows[1]!.remainingPercent = 0;
    expect(await check()).toMatchObject({ code: 3, gate: { ready: false, reason: "reserve-reached" } });
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(url.replace("provider=codex", "provider=invalid"))).status).toBe(400);
    expect(service.jobs.summaries()).toEqual([]);
    expect(service.resumeTasks.active()).toEqual([]);
    server.stop(true);
    expect(await check()).toMatchObject({ code: 69, gate: { ready: false, reason: "service-unavailable" } });
  } finally { server.stop(true); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
