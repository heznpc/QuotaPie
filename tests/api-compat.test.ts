import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";

// The wire contract during the rename: displayText/displayDetail are the
// names, and title/detail/summary are deprecated aliases kept only for a menu
// bar app that is momentarily one version behind its daemon. When the Swift
// payload next changes shape for its own reasons, the aliases go with it.
describe("api compatibility during the displayText rename", () => {
  async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
    const config = structuredClone(DEFAULT_CONFIG);
    config.dashboard.port = 0;
    const db = new QuotaDatabase(":memory:");
    db.insertEvent({
      provider: "codex",
      account: "default",
      bucket: "codex:primary:10080",
      kind: "external_relief",
      severity: "info",
      occurredAtMs: 1_000,
      confidence: "high",
      displayText: "Codex weekly was refilled ahead of schedule.",
      details: {},
    });
    const service = new QuotaPieService(config, db);
    const server = startDashboard(service, config, { compactionRoot: new URL("fixtures/no-relays", import.meta.url).pathname });
    try {
      await run(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
      service.close();
    }
  }

  test("a new consumer reads displayText from both endpoints", async () => {
    await withServer(async (origin) => {
      const status = await (await fetch(`${origin}/api/status`)).json() as {
        headline: { displayText: string };
        events: Array<{ displayText: string }>;
      };
      expect(typeof status.headline.displayText).toBe("string");
      expect(status.events[0]!.displayText).toContain("refilled");

      const events = await (await fetch(`${origin}/api/events`)).json() as {
        events: Array<{ displayText: string }>;
      };
      expect(events.events[0]!.displayText).toContain("refilled");
    });
  });

  test("an old consumer still finds the deprecated aliases, equal to the new names", async () => {
    await withServer(async (origin) => {
      const status = await (await fetch(`${origin}/api/status`)).json() as {
        headline: { displayText: string; displayDetail: string | null; title: string; detail: string | null };
        events: Array<{ displayText: string; summary: string }>;
      };
      expect(status.headline.title).toBe(status.headline.displayText);
      expect(status.headline.detail).toBe(status.headline.displayDetail);
      expect(status.events[0]!.summary).toBe(status.events[0]!.displayText);
    });
  });

  test("the SQLite column keeps its old name while the domain does not", () => {
    const db = new QuotaDatabase(":memory:");
    db.insertEvent({
      provider: "codex",
      account: "default",
      bucket: "b",
      kind: "external_relief",
      severity: "info",
      occurredAtMs: 1_000,
      confidence: "high",
      displayText: "stored rendering",
      details: {},
    });
    const raw = db.db.query<{ summary: string }, []>("SELECT summary FROM events").get();
    expect(raw!.summary).toBe("stored rendering");
    expect(db.recentEvents(1)[0]!.displayText).toBe("stored rendering");
  });
});

test("runtime identity is captured once, without paths or configuration", async () => {
  const { runtimeSourceHash } = await import("../src/runtime-identity");
  const config = structuredClone(DEFAULT_CONFIG);
  config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const server = startDashboard(service, config);
  try {
    const url = `http://127.0.0.1:${server.port}/api/runtime`;
    const first = await (await fetch(url)).json();
    expect(first).toEqual(await (await fetch(url)).json());
    expect(first).toMatchObject({ schemaVersion: 1, pid: process.pid, sourceHash: runtimeSourceHash() });
    expect(Object.keys(first).sort()).toEqual(["pid", "schemaVersion", "sourceHash", "startedAt"]);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  } finally { server.stop(true); service.close(); }
});

test("status projections share one analysis pass without caching across requests", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const analyses = service.analyses.bind(service);
  let passes = 0;
  service.analyses = (...args) => { passes++; return analyses(...args); };
  const server = startDashboard(service, config, {compactionRoot: new URL("fixtures/no-relays", import.meta.url).pathname});
  try {
    for (let i = 1; i <= 2; i++) {
      const result = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as any;
      expect(result.accounts).toBeArray(); expect(result.statuses).toBeArray();
      expect(passes).toBe(i);
    }
  } finally { server.stop(true); await service.close(); }
});

test("one status response reads each quota history once and shares it with compatibility consumers", async () => {
  const config=structuredClone(DEFAULT_CONFIG);config.dashboard.port=0;
  const db=new QuotaDatabase(":memory:"),service=new QuotaPieService(config,db);
  service.ingest([{provider:"codex",account:"default",bucket:"codex:primary:300",label:"5h",windowSeconds:18000,
    usedPercent:25,resetsAtMs:Date.now()+3600_000,observedAtMs:Date.now(),source:"codex-app-server",quality:"authoritative"}]);
  let reads=0;const history=db.analysisHistory.bind(db);
  db.analysisHistory=(...args)=>{reads++;return history(...args);};
  const server=startDashboard(service,config);
  try {
    const status:any=await(await fetch(`http://127.0.0.1:${server.port}/api/status`)).json();
    const current=status.accounts.find((a:any)=>a.provider==="codex"&&a.account==="default");
    expect(current.windows[0].remainingPercent).toBe(75);
    expect(status.statuses[0].windows).toEqual(current.windows);
    expect(reads).toBe(1);
  } finally {server.stop(true);service.close();}
});
