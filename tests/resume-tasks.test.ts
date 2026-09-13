import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { ResumeTaskStore, ResumeTaskStoreError } from "../src/storage/resume-task-store";
import { resumeTaskKey } from "../src/session-discovery";
import type { QuotaObservation } from "../src/types";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function observation(
  observedAtMs: number,
  usedPercent: number,
  overrides: Partial<QuotaObservation> = {},
): QuotaObservation {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:300",
    label: "Codex 5h",
    windowSeconds: 18_000,
    usedPercent,
    resetsAtMs: 20_000,
    observedAtMs,
    source: "test",
    quality: "authoritative",
    ...overrides,
  };
}

describe("resume task storage", () => {
  test("is durable, private, and enforces active uniqueness plus CAS transitions", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-resume-store-"));
    const databasePath = resolve(directory, "quotapie.sqlite3");
    const rawSession = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rawCwd = "/private/tmp/quotapie-secret-parent/secret-project";
    const db = new QuotaDatabase(databasePath);
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    const service = new QuotaPieService(config, db);
    service.ingest([observation(1_000, 100)]);
    const created = service.registerResumeTask({
      provider: "codex",
      nativeId: rawSession,
      cwd: rawCwd,
    }, 1_500);
    expect(created.projectLabel).toBe("secret-project");
    expect(() => service.registerResumeTask({
      provider: "codex",
      nativeId: rawSession,
      cwd: rawCwd,
    }, 1_600)).toThrow("already has an active resume task");

    const store = service.resumeTasks;
    expect(() => store.approve(created.id, 2_000)).toThrow(ResumeTaskStoreError);
    expect(store.markReady(created.id, 2_000).state).toBe("ready");
    expect(store.approve(created.id, 2_100).state).toBe("approved");
    expect(() => store.approve(created.id, 2_200)).toThrow("expected ready");
    expect(store.retry(created.id, 2_300).state).toBe("ready");
    expect(store.dismiss(created.id, 2_400).state).toBe("dismissed");
    await service.close();

    const reopened = new QuotaDatabase(databasePath);
    const reopenedStore = new ResumeTaskStore(reopened.storage);
    expect(reopenedStore.get(created.id)?.state).toBe("dismissed");
    expect(reopenedStore.create({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      taskKey: resumeTaskKey("codex", "default", rawSession),
      provider: "codex",
      account: "default",
      projectLabel: "secret-project",
      bucket: "codex:primary:300",
      registeredAtMs: 3_000,
      registeredRemainingPercent: 0,
      expectedResetAtMs: 20_000,
    }).state).toBe("waiting");
    reopened.close();

    const bytes = readFileSync(databasePath).toString("utf8");
    expect(bytes.includes(rawSession)).toBeFalse();
    expect(bytes.includes(rawCwd)).toBeFalse();
    for (const suffix of ["-wal", "-shm"]) {
      if (!existsSync(`${databasePath}${suffix}`)) continue;
      const sidecar = readFileSync(`${databasePath}${suffix}`).toString("utf8");
      expect(sidecar.includes(rawSession)).toBeFalse();
      expect(sidecar.includes(rawCwd)).toBeFalse();
    }
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("resume readiness", () => {
  test("requires a newer fresh positive snapshot for the exact account and bucket", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    config.accounts.codex.push({
      id: "work",
      label: "Work",
      codexHome: "/tmp/quotapie-resume-work",
      enabled: true,
    });
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(config, db);
    service.ingest([
      observation(1_000, 100),
      observation(1_000, 100, { account: "work" }),
    ]);
    const task = service.registerResumeTask({ provider: "codex", nativeId: SESSION_A }, 1_500);

    // Passing the expected reset without a new provider observation is not
    // evidence that capacity really returned.
    expect(await service.updateResumeReadiness(service.analyses(21_000), 21_000)).toEqual([]);
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");

    service.ingest([observation(22_000, 50, { account: "work", resetsAtMs: 40_000 })]);
    expect(await service.updateResumeReadiness(service.analyses(22_000), 22_000)).toEqual([]);
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");

    service.ingest([observation(23_000, 100, { resetsAtMs: 40_000 })]);
    expect(await service.updateResumeReadiness(service.analyses(23_000), 23_000)).toEqual([]);
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");
    expect(service.resumeTasks.get(task.id)?.expectedResetAtMs).toBe(40_000);

    service.ingest([observation(24_000, 90, { resetsAtMs: 40_000 })]);
    const ready = await service.updateResumeReadiness(service.analyses(24_000), 24_000);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ id: task.id, state: "ready", readyAtMs: 24_000 });
    expect(await service.updateResumeReadiness(service.analyses(24_000), 24_001)).toEqual([]);
    service.ingest([observation(25_000, 100, { resetsAtMs: 40_000 })]);
    expect(await service.updateResumeReadiness(service.analyses(25_000), 25_000)).toEqual([]);
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");
    service.resumeTasks.markReady(task.id, 25_100);
    await expect(service.approveResumeTask(task.id, 25_200)).rejects.toThrow(
      "fresh quota is no longer available",
    );
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");
    service.close();
  });

  test("captures the least remaining current bucket unless one is explicit", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(config, db);
    service.ingest([
      observation(1_000, 60),
      observation(1_000, 90, {
        bucket: "codex:secondary:10080",
        label: "Codex weekly",
        windowSeconds: 604_800,
        resetsAtMs: 80_000,
      }),
    ]);
    const lowest = service.registerResumeTask({ provider: "codex", nativeId: SESSION_A }, 1_500);
    expect(service.resumeTasks.get(lowest.id)?.bucket).toBe("codex:secondary:10080");
    service.dismissResumeTask(lowest.id, 1_600);
    const explicit = service.registerResumeTask({
      provider: "codex",
      nativeId: SESSION_B,
      bucket: "codex:primary:300",
    }, 1_700);
    expect(service.resumeTasks.get(explicit.id)?.bucket).toBe("codex:primary:300");
    expect(service.resumeTasks.get(explicit.id)?.expectedResetAtMs).toBe(20_000);
    service.close();
  });

  test("does not call a merely newer positive reading a recovery", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    service.ingest([observation(1_000, 80)]);
    const task = service.registerResumeTask({ provider: "codex", nativeId: SESSION_A }, 1_500);
    expect(service.resumeTasks.get(task.id)?.registeredRemainingPercent).toBe(20);

    service.ingest([observation(2_000, 81, { resetsAtMs: 40_000 })]);
    expect(await service.updateResumeReadiness(service.analyses(2_000), 2_000)).toEqual([]);
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");

    service.ingest([observation(3_000, 70, { resetsAtMs: 40_000 })]);
    expect(await service.updateResumeReadiness(service.analyses(3_000), 3_000)).toHaveLength(1);
    expect(service.resumeTasks.get(task.id)?.state).toBe("ready");
    await service.close();
  });

  test("returns the exact prompt-free Codex resume command for the selected profile", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-codex-plan-"));
    const cwd = resolve(directory, "project");
    const codexHome = resolve(directory, "codex-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    config.accounts.codex = [{ id: "default", label: "Main", codexHome, enabled: true }];
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(config, db);
    service.ingest([observation(1_000, 100)]);
    const task = service.registerResumeTask({ provider: "codex", nativeId: SESSION_A }, 1_500);
    service.ingest([observation(1_900, 80, { resetsAtMs: 40_000 })]);
    await service.updateResumeReadiness(service.analyses(2_000), 2_000);
    const fakeClient = {
      async listThreads() {
        return {
          data: [{ id: SESSION_A, cwd, name: "Current task" }],
          nextCursor: null,
        };
      },
      async close() {},
    };
    (service as unknown as { codexClients: Map<string, unknown> }).codexClients.set(
      "default",
      fakeClient,
    );
    const approved = await service.approveResumeTask(task.id, 2_100);
    expect(approved.plan).toEqual({
      executable: "codex",
      arguments: ["resume", "-C", cwd, SESSION_A],
      environment: { CODEX_HOME: codexHome },
      workingDirectory: cwd,
    });
    expect(approved.plan.arguments).not.toContain("--continue");
    expect(approved.plan.arguments).not.toContain("--last");
    expect(approved.plan.arguments).toHaveLength(4);
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("a dismiss that races async discovery prevents a stale launch plan", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-codex-race-"));
    const cwd = resolve(directory, "project");
    const codexHome = resolve(directory, "codex-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    config.accounts.codex = [{ id: "default", label: "Main", codexHome, enabled: true }];
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    service.ingest([observation(1_000, 100)]);
    const task = service.registerResumeTask({ provider: "codex", nativeId: SESSION_A }, 1_500);
    service.ingest([observation(1_900, 80, { resetsAtMs: 40_000 })]);
    await service.updateResumeReadiness(service.analyses(2_000), 2_000);

    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolveStarted) => { markDiscoveryStarted = resolveStarted; });
    const discoveryRelease = new Promise<void>((resolveRelease) => { releaseDiscovery = resolveRelease; });
    (service as unknown as { codexClients: Map<string, unknown> }).codexClients.set("default", {
      async listThreads() {
        markDiscoveryStarted();
        await discoveryRelease;
        return { data: [{ id: SESSION_A, cwd, name: "Current task" }], nextCursor: null };
      },
      async close() {},
    });
    const approval = service.approveResumeTask(task.id, 2_100);
    await discoveryStarted;
    service.dismissResumeTask(task.id, 2_101);
    releaseDiscovery();
    await expect(approval).rejects.toThrow("expected ready");
    expect(service.resumeTasks.get(task.id)?.state).toBe("dismissed");
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("quota that disappears during async discovery prevents approval", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-codex-capacity-race-"));
    const cwd = resolve(directory, "project");
    const codexHome = resolve(directory, "codex-home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    config.accounts.codex = [{ id: "default", label: "Main", codexHome, enabled: true }];
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    service.ingest([observation(1_000, 100)]);
    const task = service.registerResumeTask({ provider: "codex", nativeId: SESSION_A }, 1_500);
    service.ingest([observation(1_900, 80, { resetsAtMs: 40_000 })]);
    await service.updateResumeReadiness(service.analyses(2_000), 2_000);

    let releaseDiscovery!: () => void;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolveStarted) => { markDiscoveryStarted = resolveStarted; });
    const discoveryRelease = new Promise<void>((resolveRelease) => { releaseDiscovery = resolveRelease; });
    (service as unknown as { codexClients: Map<string, unknown> }).codexClients.set("default", {
      async listThreads() {
        markDiscoveryStarted();
        await discoveryRelease;
        return { data: [{ id: SESSION_A, cwd, name: "Current task" }], nextCursor: null };
      },
      async close() {},
    });
    const approval = service.approveResumeTask(task.id, 2_100);
    await discoveryStarted;
    service.ingest([observation(2_050, 100, { resetsAtMs: 40_000 })]);
    releaseDiscovery();
    await expect(approval).rejects.toThrow("fresh quota is no longer available");
    expect(service.resumeTasks.get(task.id)?.state).toBe("waiting");
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("pause CLI", () => {
  test("infers Codex from the session environment and prints only the reduced task", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-pause-cli-"));
    const configPath = resolve(directory, "config.json");
    const cwd = resolve(directory, "private-project");
    mkdirSync(cwd, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    writeFileSync(configPath, JSON.stringify(config));
    const nowMs = Date.now();
    const db = new QuotaDatabase(resolve(directory, "quotapie.sqlite3"));
    db.ingestObservation(observation(nowMs - 100, 100, { resetsAtMs: nowMs + 60_000 }), config);
    db.close();

    const result = Bun.spawnSync([
      process.execPath,
      "run",
      resolve(import.meta.dir, "..", "src", "cli.ts"),
      "pause",
      "--cwd",
      cwd,
      "--json",
    ], {
      cwd,
      env: {
        ...process.env,
        QUOTAPIE_CONFIG: configPath,
        QUOTAPIE_HOME: directory,
        CODEX_THREAD_ID: SESSION_A,
        CLAUDE_SESSION_ID: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(resolve(directory, "work-state.json"), "utf8")).tasks[0].state).toBe("waiting");
    const output = result.stdout.toString();
    expect(JSON.parse(output)).toMatchObject({
      provider: "codex",
      account: "default",
      projectLabel: "private-project",
      state: "waiting",
    });
    expect(output).not.toContain(SESSION_A);
    expect(output).not.toContain(cwd);
    rmSync(directory, { recursive: true, force: true });
  });

  test("infers the exact account from CODEX_HOME in a multi-account setup", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-pause-account-"));
    const configPath = resolve(directory, "config.json");
    const cwd = resolve(directory, "private-project");
    const defaultRoot = resolve(directory, "codex-default");
    const workRoot = resolve(directory, "codex-work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(defaultRoot, { recursive: true });
    mkdirSync(workRoot, { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    config.accounts.codex = [
      { id: "default", label: "Main", codexHome: defaultRoot, enabled: true },
      { id: "work", label: "Work", codexHome: workRoot, enabled: true },
    ];
    writeFileSync(configPath, JSON.stringify(config));
    const nowMs = Date.now();
    const db = new QuotaDatabase(resolve(directory, "quotapie.sqlite3"));
    db.ingestObservation(observation(nowMs - 100, 100, {
      account: "work",
      resetsAtMs: nowMs + 60_000,
    }), config);
    db.close();

    const result = Bun.spawnSync([
      process.execPath,
      "run",
      resolve(import.meta.dir, "..", "src", "cli.ts"),
      "pause",
      "--cwd",
      cwd,
      "--json",
    ], {
      cwd,
      env: {
        ...process.env,
        QUOTAPIE_CONFIG: configPath,
        QUOTAPIE_HOME: directory,
        CODEX_HOME: workRoot,
        CODEX_THREAD_ID: SESSION_B,
        CLAUDE_SESSION_ID: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      provider: "codex",
      account: "work",
      state: "waiting",
    });
    rmSync(directory, { recursive: true, force: true });
  });
});
