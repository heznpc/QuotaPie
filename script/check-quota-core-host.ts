// Run the packaged collector after installer staging, with only synthetic input.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { bundleCollector } from "./prepare-distribution";
import { stageRuntime } from "./install-macos";
import { runtimeSourceHash } from "../src/runtime-identity";

const root = resolve(import.meta.dir, "..");
const stage = mkdtempSync(join(tmpdir(), "quota-core-host-"));
let service: any, server: any, relay: any;
try {
  const app = join(stage, "QuotaPie.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), "packaging fixture");
  const collector = bundleCollector(root, app);
  const runtime = join(stage, "runtime");
  stageRuntime(collector, runtime);
  assert.equal(runtimeSourceHash(runtime), runtimeSourceHash(root));
  assert.equal(existsSync(join(runtime, "node_modules")), false);
  const load = (file: string) => import(pathToFileURL(join(runtime, "src", file)).href);
  const { DEFAULT_CONFIG } = await load("config.ts");
  const { QuotaDatabase } = await load("db.ts");
  const { QuotaPieService } = await load("service.ts");
  const { startDashboard } = await load("server.ts");
  const { startCompactionProxy, DEFAULT_COMPACTION_ROUTE } = await load("codex-compaction.ts");
  const { parseCodexRateLimits } = await load("providers/codex-appserver.ts");
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.codexEnabled = false;
  config.collection.claudeOAuthEnabled = false;
  config.resetSignals.enabled = false;
  config.alerts.enabled = false;
  config.alerts.macOSNotifications = false;
  config.accounts.codex = [{ id: "fixture", label: "Fixture", codexHome: join(stage, "profile"), enabled: true }];
  config.accounts.claude = [];
  config.dashboard.port = 0;
  service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  service.ingest(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: Date.now() + 3600000 } } }, Date.now(), "fixture"));
  const token = "ab".repeat(24), compactionRoot = join(stage, "relay");
  mkdirSync(compactionRoot);
  relay = startCompactionProxy({ token, fetchUpstream: async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(request.model, "gpt-5.6-sol");
    return Response.json({ model: request.model, output: [{ type: "compaction", encrypted_content: "fixture" }] });
  } });
  writeFileSync(join(compactionRoot, "settings.json"), JSON.stringify({ token, port: Number(new URL(relay.baseUrl).port), route: DEFAULT_COMPACTION_ROUTE }));
  writeFileSync(join(compactionRoot, "current.json"), JSON.stringify({ settings_path: join(compactionRoot, "settings.json") }));
  const response = await fetch(relay.baseUrl + "/responses/compact", { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
  assert.equal(response.status, 200);
  await response.text();
  server = startDashboard(service, config, { compactionRoot, preferencesPath: join(stage, "preferences.json"), poolPolicyPath: join(stage, "pool.json"), poolDatabasePath: join(stage, "pool.sqlite") });
  const origin = `http://127.0.0.1:${server.port}`;
  const identity = await (await fetch(origin + "/api/runtime")).json() as any;
  assert.equal(identity.sourceHash, runtimeSourceHash(root));
  let status: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    status = await (await fetch(origin + "/api/status")).json();
    if (status.compaction.recent.length) break;
    await Bun.sleep(100);
  }
  assert.equal(status.accounts[0].windows[0].remainingPercent, 77);
  assert.equal(status.compaction.recent[0].phase, "completed");
  assert.equal(status.compaction.recent[0].responseModel, "gpt-5.6-sol");
  assert.equal(status.compaction.policy.model, "gpt-5.6-sol");
  console.log(JSON.stringify({ packagedCollector: "pass", installedSourceIdentity: "pass", quotaApi: "pass", compactionApi: "pass", developerDependencies: false, liveProvider: "not-tested" }));
} finally {
  server?.stop(true);
  relay?.stop();
  await service?.close();
  rmSync(stage, { recursive: true, force: true });
}
