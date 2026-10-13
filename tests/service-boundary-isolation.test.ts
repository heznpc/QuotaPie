import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as boundary from "../src/boundary";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-boundary-isolation-"));
  const app = join(root, "app"), other = join(root, "other"), database = join(root, "fixture-db");
  for (const directory of [app, other, database]) mkdirSync(directory);
  for (const directory of [app, other]) for (const name of ["work-state.json", "quota.json"])
    writeFileSync(join(directory, name), "sentinel:" + name);
  const previous = process.env.QUOTAPIE_HOME;
  process.env.QUOTAPIE_HOME = app;
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts = { codex: [], claude: [] };
  config.collection.codexEnabled = false;
  config.collection.claudeOAuthEnabled = false;
  config.alerts.enabled = false;
  config.resetSignals.enabled = false;
  return { root, app, other, database, config, cleanup: () => {
    if (previous === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  } };
}
function expectSentinels(directory: string) {
  for (const name of ["work-state.json", "quota.json"]) expect(readFileSync(join(directory, name), "utf8")).toBe("sentinel:" + name);
}

test("an injected in-memory service cannot overwrite ambient application boundaries", async () => {
  const f = fixture(), service = new QuotaPieService(f.config, new QuotaDatabase(":memory:"));
  try {
    // This is the same path that a fixture tick and API resume action used to
    // reach. Both exports must remain disabled without explicit destinations.
    service.publishWorkBoundary();
    await service.publishBoundary();
    expectSentinels(f.app);
    expectSentinels(f.other);
  } finally { await service.close(); f.cleanup(); }
});

test("a supplied file database publishes beside itself and binds explicit destinations at construction", async () => {
  const f = fixture();
  const leaderboard = spyOn(boundary, "cachedLeaderboard").mockResolvedValue([]);
  const service = new QuotaPieService(f.config, new QuotaDatabase(join(f.database, "fixture.sqlite3")));
  const explicit = new QuotaPieService(f.config, new QuotaDatabase(":memory:"), {
    workState: join(f.database, "explicit-work.json"), quota: join(f.database, "explicit-quota.json"),
  });
  try {
    process.env.QUOTAPIE_HOME = f.other;
    await service.publishBoundary();
    await explicit.publishBoundary();
    expectSentinels(f.app); expectSentinels(f.other);
    for (const name of ["work-state.json", "quota.json", "explicit-work.json", "explicit-quota.json"])
      expect(JSON.parse(readFileSync(join(f.database, name), "utf8")).schemaVersion).toBeGreaterThan(0);
  } finally { leaderboard.mockRestore(); await service.close(); await explicit.close(); f.cleanup(); }
});

test("the default collector retains its own isolated destinations across an asynchronous environment change", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const leaderboard = spyOn(boundary, "cachedLeaderboard").mockImplementation(async () => { await pending; return []; });
  // Production uses this constructor with no database argument. Isolated
  // QUOTAPIE_HOME must apply to both exports as well as the database.
  const service = new QuotaPieService(f.config);
  try {
    expect(existsSync(join(f.app, "quotapie.sqlite3"))).toBe(true);
    const publishing = service.publishBoundary();
    process.env.QUOTAPIE_HOME = f.other;
    release(); await publishing;
    expectSentinels(f.other);
    for (const name of ["work-state.json", "quota.json"])
      expect(JSON.parse(readFileSync(join(f.app, name), "utf8")).schemaVersion).toBeGreaterThan(0);
  } finally { release(); leaderboard.mockRestore(); await service.close(); f.cleanup(); }
});
