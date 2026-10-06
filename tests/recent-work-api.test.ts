import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { startDashboard } from "../src/server";
import { QuotaPieService } from "../src/service";

test("recent work exposes metadata and opens only the selected, still-enabled session", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-work-api-"));
  const configDir = join(root, "claude");
  const project = join(root, "project");
  const sessions = join(configDir, "projects", "-project");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const file = join(sessions, `${sessionId}.jsonl`);
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "response-1", sessionId,
    cwd: project, timestamp: new Date().toISOString(), message: { id: "message-1",
      content: "PRIVATE_TRANSCRIPT", usage: { input_tokens: 30, output_tokens: 10 } } }) + "\n");
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [];
  config.accounts.claude = [{ id: "work", label: "Work", configDir, enabled: true, keychainService: null }];
  config.collection.codexEnabled = false;
  config.dashboard.port = 0;
  config.alerts.enabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const scans = spyOn(service.recentWork, "summaries");
  const server = startDashboard(service, config, { compactionRoot: join(root, "no-relays") });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(origin + "/api/status")).status).toBe(200);
    expect(scans).not.toHaveBeenCalled();
    const statusHeaders = { "x-quotapie-recent-work": "1" };
    let status: any = await (await fetch(origin + "/api/status", { headers: statusHeaders })).json();
    expect(status.recentWorkState).toBe("loading");
    for (let attempt = 0; status.recentWorkState === "loading" && attempt < 100; attempt++) {
      await Bun.sleep(10);
      status = await (await fetch(origin + "/api/status", { headers: statusHeaders })).json();
    }
    expect(status.recentWorkState).toBe("ready");
    expect(status.recentWork).toHaveLength(1);
    expect(status.recentWork[0]).toMatchObject({ provider: "claude", account: "work", accountLabel: "Work", tokenCount: 40 });
    const publicText = JSON.stringify(status.recentWork);
    expect(publicText).not.toContain("PRIVATE_TRANSCRIPT");
    expect(publicText).not.toContain(sessionId);
    expect(publicText).not.toContain(root);
    const url = `${origin}/api/recent-work/${status.recentWork[0].id}/open`;
    const headers = { "x-quotapie-action-token": status.actionToken };
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { ...headers, origin } })).status).toBe(403);
    expect((await fetch(origin + "/api/recent-work/invalid/open", { method: "POST", headers })).status).toBe(400);
    const opened = await fetch(url, { method: "POST", headers });
    expect(opened.status).toBe(200);
    expect((await opened.json() as any).plan).toEqual({ executable: "claude", arguments: ["--resume", sessionId],
      environment: { CLAUDE_CONFIG_DIR: configDir }, workingDirectory: project });
    expect(service.resumeTasks.active()).toEqual([]);
    expect(service.jobs.summaries()).toEqual([]);
    config.accounts.claude[0]!.enabled = false;
    expect((await fetch(url, { method: "POST", headers })).status).toBe(409);
    config.accounts.claude[0]!.enabled = true;
    rmSync(file);
    expect((await fetch(url, { method: "POST", headers })).status).toBe(409);
  } finally {
    server.stop(true);
    await service.close();
    scans.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pending recent-work scan leaves quota status responsive", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [];
  config.accounts.claude = [];
  config.alerts.enabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  let complete!: (items: []) => void;
  service.recentWork.summaries = () => new Promise(resolve => { complete = resolve; });
  try {
    expect(service.recentWorkStatus().recentWorkState).toBe("loading");
    expect(service.recentWorkStatus().recentWork).toEqual([]);
    complete([]);
    await Bun.sleep(0);
    expect(service.recentWorkStatus().recentWorkState).toBe("ready");
  } finally { await service.close(); }
});
