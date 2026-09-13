import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildWorkBoundary, writeWorkBoundary } from "../src/work-boundary";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { startDashboard } from "../src/server";
import { QuotaPieService } from "../src/service";
import type { QuotaObservation } from "../src/types";

const SESSION = "55555555-5555-4555-8555-555555555555";

describe("resume task API", () => {
  test("requires the action token, enforces states, and returns a prompt-free Claude plan", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-resume-api-"));
    const configDir = resolve(directory, "claude");
    const cwd = resolve(directory, "project");
    const projectDir = resolve(configDir, "projects", "-project");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(resolve(projectDir, `${SESSION}.jsonl`), [
      JSON.stringify({ type: "user", sessionId: SESSION, cwd, message: { content: "private prompt" } }),
      JSON.stringify({ type: "custom-title", sessionId: SESSION, customTitle: "Resume API" }),
    ].join("\n"));

    const config = structuredClone(DEFAULT_CONFIG);
    config.dashboard.port = 0;
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    config.accounts.claude = [{
      id: "default",
      label: "Claude Main",
      configDir,
      enabled: true,
      keychainService: null,
    }];
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(config, db);
    const workPath = resolve(directory, "work-state.json");
    service.publishWorkBoundary = () => writeWorkBoundary(
      buildWorkBoundary(service.accountStates(), service.resumeTasks.active(), config, Date.now()), workPath);

    const nowMs = Date.now();
    const initial: QuotaObservation = {
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: 100,
      resetsAtMs: nowMs + 60_000,
      observedAtMs: nowMs - 1_000,
      source: "test",
      quality: "authoritative",
    };
    service.ingest([initial]);
    const task = service.registerResumeTask({ provider: "claude", nativeId: SESSION, cwd }, nowMs - 900);
    service.ingest([{
      ...initial,
      usedPercent: 80,
      resetsAtMs: nowMs + 120_000,
      observedAtMs: nowMs - 800,
    }]);
    await service.updateResumeReadiness(service.analyses(nowMs - 700), nowMs - 700);

    const server = startDashboard(service, config, { compactionRoot: new URL("fixtures/no-relays", import.meta.url).pathname });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const statusResponse = await fetch(`${origin}/api/status`);
      const status = await statusResponse.json() as {
        actionToken: string;
        resumeTasks: Array<Record<string, unknown>>;
      };
      expect(status.actionToken.length).toBeGreaterThan(30);
      expect(status.resumeTasks[0]).toMatchObject({
        id: task.id,
        provider: "claude",
        account: "default",
        accountLabel: "Claude Main",
        state: "ready",
      });
      expect(JSON.stringify(status.resumeTasks)).not.toContain(SESSION);
      expect(JSON.stringify(status.resumeTasks)).not.toContain(cwd);

      const actionUrl = `${origin}/api/resume-tasks/${task.id}/approve`;
      expect((await fetch(actionUrl, { method: "POST" })).status).toBe(403);
      expect((await fetch(actionUrl, {
        method: "POST",
        headers: { "x-quotapie-action-token": "wrong" },
      })).status).toBe(403);
      expect(service.resumeTasks.get(task.id)?.state).toBe("ready");

      const approvedResponse = await fetch(actionUrl, {
        method: "POST",
        headers: { "x-quotapie-action-token": status.actionToken },
      });
      expect(approvedResponse.status).toBe(200);
      const approved = await approvedResponse.json() as {
        task: { state: string };
        plan: {
          executable: string;
          arguments: string[];
          environment: Record<string, string>;
          workingDirectory: string;
        };
      };
      expect(approved.task.state).toBe("approved");
      expect(JSON.parse(readFileSync(workPath, "utf8")).tasks[0].state).toBe("approved");
      expect(approved.plan).toEqual({
        executable: "claude",
        arguments: ["--resume", SESSION],
        environment: { CLAUDE_CONFIG_DIR: configDir },
        workingDirectory: cwd,
      });
      expect(approved.plan.arguments).not.toContain("--continue");
      expect(approved.plan.arguments).not.toContain("--last");
      expect(approved.plan.arguments).toHaveLength(2);

      expect((await fetch(actionUrl, {
        method: "POST",
        headers: { "x-quotapie-action-token": status.actionToken },
      })).status).toBe(409);
      expect((await fetch(`${origin}/api/resume-tasks/${task.id}/resumed`, {
        method: "POST",
        headers: { "x-quotapie-action-token": status.actionToken },
      })).status).toBe(200);
      const afterResume = await (await fetch(`${origin}/api/status`)).json() as {
        resumeTasks: Array<{ id: string }>;
      };
      expect(afterResume.resumeTasks.some((item) => item.id === task.id)).toBeFalse();
      expect(JSON.parse(readFileSync(workPath, "utf8")).tasks).toEqual([]);
      expect((await fetch(`${origin}/api/resume-tasks/${task.id}/retry`, {
        method: "POST",
        headers: { "x-quotapie-action-token": status.actionToken },
      })).status).toBe(409);
      expect((await fetch(`${origin}/api/resume-tasks/${randomUUID()}/dismiss`, {
        method: "POST",
        headers: { "x-quotapie-action-token": status.actionToken },
      })).status).toBe(404);
      expect((await fetch(`${origin}/api/resume-tasks/not-a-uuid/dismiss`, {
        method: "POST",
        headers: { "x-quotapie-action-token": status.actionToken },
      })).status).toBe(400);
    } finally {
      server.stop(true);
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
