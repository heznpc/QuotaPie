import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config";
import { buildWorkBoundary, profileReference, writeWorkBoundary } from "../src/work-boundary";
import { resumeTaskKey } from "../src/session-discovery";
import type { AccountState, ResumeTask, WindowAnalysis } from "../src/types";

const now = 1_800_000_000_000;
const nativeID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const task: ResumeTask = {
  id: "11111111-2222-4333-8444-555555555555", taskKey: resumeTaskKey("codex", "main", nativeID),
  provider: "codex", account: "main", projectLabel: "Example", bucket: "weekly", state: "ready",
  registeredAtMs: now - 60_000, registeredRemainingPercent: 0, expectedResetAtMs: now,
  readyAtMs: now, approvedAtMs: null, resumedAtMs: null, dismissedAtMs: null, updatedAtMs: now,
  errorDetail: "private diagnostic",
};
const account: AccountState = {
  provider: "codex", account: "main", accountLabel: "Main", enabled: true,
  bottleneckBucket: "weekly", updatedAtMs: now,
  collection: { health: "recent-success", activeSource: "codex-appserver", lastSuccessAtMs: now,
    errorCategory: null, errorDetail: null, sources: [] },
  windows: [{ bucket: "weekly", label: "Weekly", remainingPercent: 90, resetsAtMs: now + 60_000,
    observedAtMs: now - 1000, freshness: "fresh" } as WindowAnalysis],
};

test("work boundary links account and task without exporting native IDs, paths or approval data", () => {
  const directory = mkdtempSync(join(tmpdir(), "quotapie-work-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.codex = [{ id: "main", label: "Main", enabled: true, codexHome: directory }];
    const document = buildWorkBoundary([account], [task], config, now);
    expect(document.schemaVersion).toBe(1);
    expect(document.expiresAtMs).toBe(now + 600_000);
    expect(document.accounts[0]!.profileKey).toBe(profileReference(directory));
    expect(document.accounts[0]!.windows[0]!.validUntilMs).toBe(now - 1000 + config.collection.staleAfterSeconds * 1000);
    expect(document.tasks[0]!.sessionKey).toBe(task.taskKey);
    const raw = JSON.stringify(document);
    for (const secret of [nativeID, directory, "private diagnostic", "actionToken", "environment", "arguments"]) {
      expect(raw).not.toContain(secret);
    }
    const output = join(directory, "work-state.json");
    writeWorkBoundary(document, output);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(document);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("disabled accounts and terminal tasks do not become resumable; stale observations stay stale", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const stale = { ...account, windows: [{ ...account.windows[0]!, freshness: "stale" as const }] };
  const document = buildWorkBoundary([stale], [task, { ...task, id: "done", state: "resumed" }], config, now);
  expect(document.tasks).toHaveLength(1);
  expect(document.accounts[0]!.windows[0]!.freshness).toBe("stale");
  expect(buildWorkBoundary([{ ...account, enabled: false }], [task], config, now).tasks).toEqual([]);
  expect(profileReference("/a/path/that/does/not/exist")).toBeNull();
});
