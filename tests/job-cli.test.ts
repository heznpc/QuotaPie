import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { Job, JobSpec, JobSummary } from "../src/jobs/types";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const PRIVATE_PROMPT = "PRIVATE_JOB_PROMPT: inspect the saved work";
const PRIVATE_RESULT = "PRIVATE_LEGACY_RESULT: already completed";
const fixtures: Array<{ root: string; providerMarker: string }> = [];

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-job-cli-")));
  const data = join(root, "isolated-data");
  const workspace = join(root, "private workspace");
  const profile = join(root, "private provider profile");
  const bin = join(root, "bin");
  const configPath = join(root, "config.json");
  const providerMarker = join(root, "unexpected-provider-call");
  fixtures.push({ root, providerMarker });
  for (const directory of [data, workspace, profile, bin]) mkdirSync(directory, { mode: 0o700 });
  for (const command of ["codex", "claude"]) {
    const path = join(bin, command);
    writeFileSync(path, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(providerMarker)}, "provider was invoked");\nprocess.exit(93);\n`);
    chmodSync(path, 0o700);
  }
  const config = structuredClone(DEFAULT_CONFIG);
  config.profile.locale = "en";
  config.accounts.codex = [{ id: "fixture", label: "Fixture account", codexHome: profile, enabled: true }];
  config.accounts.claude = [];
  config.collection.codexCommand = join(bin, "codex");
  config.collection.codexEnabled = false;
  config.collection.claudeOAuthEnabled = false;
  config.alerts.enabled = false;
  config.alerts.macOSNotifications = false;
  config.resetSignals.enabled = false;
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

  function manifest(overrides: Partial<JobSpec> = {}): { path: string; spec: JobSpec } {
    const spec: JobSpec = {
      version: 1, key: "cli-job", label: "Small saved batch", provider: "codex", account: "fixture",
      cwd: workspace, buckets: ["codex:primary:300", "codex:secondary:10080"],
      steps: [{ key: "first", prompt: PRIVATE_PROMPT }, { key: "second", prompt: "PRIVATE_SECOND_PROMPT" }],
      policy: { mode: "manual", expiresAtMs: Date.now() + 3_600_000, maxAttempts: 5 },
      ...overrides,
    };
    const path = join(root, `${spec.key} manifest.json`);
    writeFileSync(path, JSON.stringify(spec), { mode: 0o600 });
    return { path, spec };
  }

  function checkpoint(value: unknown): string {
    const path = join(root, "legacy checkpoint.json");
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  }

  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, CLI, "jobs", ...args], {
      cwd: workspace,
      env: { QUOTAPIE_HOME: data, QUOTAPIE_CONFIG: configPath, PATH: bin, LANG: "en_US.UTF-8" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  }

  return { root, data, workspace, profile, manifest, checkpoint, run };
}

function publicOnly(text: string, context: ReturnType<typeof setup>): void {
  for (const value of [PRIVATE_PROMPT, PRIVATE_RESULT, "PRIVATE_SECOND_PROMPT", context.workspace,
    context.profile, '"prompt"', '"result"', '"profileKey"', '"nativeSessionId"']) {
    expect(text).not.toContain(value);
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try { expect(existsSync(fixture.providerMarker)).toBeFalse(); }
    finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

describe("managed jobs CLI subprocess", () => {
  test("add, list and show persist isolated summaries; content requires the explicit flag", async () => {
    const context = setup();
    const { path, spec } = context.manifest();
    const added = await context.run("add", path);
    expect(added.code, added.stderr).toBe(0);
    publicOnly(added.stdout, context);
    const summary = JSON.parse(added.stdout) as JobSummary;
    expect(summary).toMatchObject({ key: spec.key, account: "fixture", state: "waiting", completedSteps: 0, totalSteps: 2 });
    const list = await context.run("list");
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([summary]);
    publicOnly(list.stdout, context);
    const shown = await context.run("show", summary.id);
    expect(shown.code, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(summary);
    publicOnly(shown.stdout, context);
    const full = await context.run("show", summary.id, "--include-content");
    expect(full.code, full.stderr).toBe(0);
    const job = JSON.parse(full.stdout) as Job;
    expect(job.spec.steps).toEqual(spec.steps);
    expect(job.spec.cwd).toBe(context.workspace);
    expect(job.steps.every(step => step.nativeSessionId === null)).toBeTrue();
    expect(job.attemptCount).toBe(0);
    expect(statSync(join(context.data, "quotapie.sqlite3")).mode & 0o777).toBe(0o600);
  });

  test("auto registration requires both explicit consent and a pinned model", async () => {
    const context = setup();
    const auto = context.manifest({ model: "gpt-5.6-luna", policy: { mode: "auto", expiresAtMs: Date.now() + 3_600_000, maxAttempts: 2 } });
    const denied = await context.run("add", auto.path);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("requires explicit --allow-auto");
    expect(denied.stdout).toBe("");
    expect(JSON.parse((await context.run("list")).stdout)).toEqual([]);
    const unpinned = context.manifest({ key: "no-model", policy: auto.spec.policy });
    const missingModel = await context.run("add", unpinned.path, "--allow-auto");
    expect(missingModel.code).toBe(1);
    expect(missingModel.stderr).toContain("requires an explicit model");
    expect(JSON.parse((await context.run("list")).stdout)).toEqual([]);
    const accepted = await context.run("add", auto.path, "--allow-auto");
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ state: "waiting", policy: { mode: "auto" }, attemptCount: 0 });
    publicOnly(accepted.stdout, context);
  });

  test("imports completed legacy steps once and keeps their results private", async () => {
    const context = setup();
    const { path, spec } = context.manifest();
    const checkpoint = context.checkpoint({
      run_id: spec.key, completed: { first: { result: { value: PRIVATE_RESULT } } }, pending: ["second"],
    });
    const added = await context.run("add", path, "--checkpoint", checkpoint);
    expect(added.code, added.stderr).toBe(0);
    const summary = JSON.parse(added.stdout) as JobSummary;
    expect(summary).toMatchObject({ state: "waiting", completedSteps: 1, totalSteps: 2, attemptCount: 0 });
    publicOnly(added.stdout, context);
    const full = JSON.parse((await context.run("show", summary.id, "--include-content")).stdout) as Job;
    expect(full.steps[0]).toMatchObject({ state: "succeeded", result: JSON.stringify({ value: PRIVATE_RESULT }), attemptCount: 0 });
    expect(full.steps[1]).toMatchObject({ state: "pending", result: null });
    const repeated = await context.run("add", path, "--checkpoint", checkpoint);
    expect(repeated.code).toBe(1);
    expect(repeated.stderr).toContain("legacy import requires a new, unapproved job");
    expect(JSON.parse((await context.run("list")).stdout)).toEqual([summary]);
    const shown = await context.run("show", summary.id);
    publicOnly(shown.stdout, context);
  });

  test("a failed legacy result remains failed while successful checkpoints are preserved", async () => {
    const context = setup();
    const { path, spec } = context.manifest();
    const checkpoint = context.checkpoint({ run_id: spec.key, completed: {
      first: { result: PRIVATE_RESULT }, second: { result: { error: "PRIVATE_LEGACY_ERROR" } },
    }, pending: [] });
    const added = await context.run("add", path, "--checkpoint", checkpoint);
    expect(added.code, added.stderr).toBe(0);
    const summary = JSON.parse(added.stdout) as JobSummary;
    expect(summary).toMatchObject({ state: "failed", completedSteps: 1, totalSteps: 2, reason: "legacy-step-failed", attemptCount: 0 });
    publicOnly(added.stdout, context);
    expect(added.stdout).not.toContain("PRIVATE_LEGACY_ERROR");
    const full = JSON.parse((await context.run("show", summary.id, "--include-content")).stdout) as Job;
    expect(full.steps.map(step => step.state)).toEqual(["succeeded", "failed"]);
    expect(full.steps[0]!.result).toBe(JSON.stringify(PRIVATE_RESULT));
  });

  test("invalid legacy imports roll back registration without leaving partial checkpoints", async () => {
    const context = setup();
    const { path, spec } = context.manifest();
    const invalid = [
      { run_id: "different-run", completed: { first: { result: PRIVATE_RESULT } }, pending: ["second"] },
      { run_id: spec.key, completed: { first: { result: PRIVATE_RESULT } }, pending: ["first", "second"] },
      { run_id: spec.key, completed: { first: { result: PRIVATE_RESULT }, second: {} }, pending: [] },
    ];
    for (const value of invalid) {
      const result = await context.run("add", path, "--checkpoint", context.checkpoint(value));
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(PRIVATE_RESULT);
      expect(JSON.parse((await context.run("list")).stdout)).toEqual([]);
    }
    const missing = await context.run("add", path, "--checkpoint", join(context.root, "missing.json"));
    expect(missing.code).toBe(1);
    expect(JSON.parse((await context.run("list")).stdout)).toEqual([]);
    // A successful registration after rollback proves the failed import did not
    // leave its unique job key or a completed step behind.
    const valid = await context.run("add", path);
    expect(valid.code, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ completedSteps: 0, totalSteps: 2, state: "waiting" });
  });

  test("exports private content to a new 0600 file and refuses overwrite or symlink targets", async () => {
    const context = setup();
    const { path, spec } = context.manifest();
    const added = await context.run("add", path);
    expect(added.code, added.stderr).toBe(0);
    const { id } = JSON.parse(added.stdout) as JobSummary;
    const missingPath = await context.run("export", id);
    expect(missingPath.code).toBe(1);
    expect(missingPath.stdout).toBe("");
    const outputPath = join(context.root, "private export.json");
    const exported = await context.run("export", id, "--output", outputPath);
    expect(exported.code, exported.stderr).toBe(0);
    expect(JSON.parse(exported.stdout)).toEqual({ exported: outputPath });
    expect(exported.stdout).not.toContain(PRIVATE_PROMPT);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    const original = readFileSync(outputPath, "utf8");
    const document = JSON.parse(original) as { schemaVersion: number; job: Job };
    expect(document.schemaVersion).toBe(1);
    expect(document.job.spec.steps).toEqual(spec.steps);
    expect(document.job.id).toBe(id);
    const again = await context.run("export", id, "--output", outputPath);
    expect(again.code).toBe(1);
    expect(readFileSync(outputPath, "utf8")).toBe(original);
    const symlink = join(context.root, "existing link.json");
    symlinkSync(outputPath, symlink);
    const linked = await context.run("export", id, "--output", symlink);
    expect(linked.code).toBe(1);
    expect(readFileSync(outputPath, "utf8")).toBe(original);
  });
});
