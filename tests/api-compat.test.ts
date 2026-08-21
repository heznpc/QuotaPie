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
    const server = startDashboard(service, config);
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
