import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../src/config";
import { RecentWorkIndex } from "../src/recent-work";
import { resumeTaskKey } from "../src/session-discovery";
const NOW = Date.now();
const DAY = 86400_000;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): { dir: string; codex: string; claude: string; config: AppConfig } {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-recent-")); cleanup.push(dir);
  const codex = join(dir, "codex"), claude = join(dir, "claude");
  mkdirSync(join(codex, "sessions", "2026", "10", "06"), { recursive: true });
  mkdirSync(join(claude, "projects", "project"), { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts = {
    codex: [{ id: "work", label: "Work", enabled: true, codexHome: codex }],
    claude: [{ id: "personal", label: "Personal", enabled: true, configDir: claude, keychainService: null }],
  };
  return { dir, codex, claude, config };
}
const iso = (at: number) => new Date(at).toISOString();
const meta = (id = A, fork?: string) => ({ type: "session_meta", timestamp: iso(NOW - DAY), payload: { id, cwd: "/private/home/hidden/project", ...(fork ? { forked_from_id: fork } : {}) } });
const usage = (tokens: number, at: number, last?: number) => ({ type: "event_msg", timestamp: iso(at), payload: { type: "token_count", info: { total_token_usage: { total_tokens: tokens }, last_token_usage: { total_tokens: last } } } });
function codexFile(root: string, name: string, records: unknown[]): string {
  const path = join(root, "sessions", "2026", "10", "06", name + ".jsonl");
  writeFileSync(path, records.map(value => JSON.stringify(value)).join("\n") + "\n"); return path;
}
function claudeFile(root: string, id: string, records: unknown[], project = "project"): string {
  mkdirSync(join(root, "projects", project), { recursive: true });
  const path = join(root, "projects", project, id + ".jsonl");
  writeFileSync(path, records.map(value => JSON.stringify(value)).join("\n") + "\n"); return path;
}
function claudeUsage(id: string, tokens: number, at: number, session = A): unknown {
  return { type: "assistant", sessionId: session, cwd: "/private/home/hidden/project", uuid: "stream-" + id, timestamp: iso(at),
    message: { id, content: "SECRET CONTENT AND TITLE", usage: { input_tokens: tokens, output_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 } } };
}
const index = () => new RecentWorkIndex({ inventoryTtlMs: 0 });
describe("recent work metadata index", () => {
  test("Codex counts cumulative deltas inside the window and deduplicates mirrored totals", async () => {
    const f = fixture();
    const records = [meta(), usage(1000, NOW - 9 * DAY), usage(1500, NOW - 2 * DAY), usage(1500, NOW - DAY), usage(1700, NOW - 1000)];
    codexFile(f.codex, "original", records); codexFile(f.codex, "mirror", records);
    const items = await index().summaries(f.config, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.tokenCount).toBe(700);
    expect(items[0]!.id).toBe(resumeTaskKey("codex", "work", A));
    expect(items[0]!.lastActiveAtMs).toBe(NOW - 1000);
  });
  test("fork history establishes a baseline without counting inherited work", async () => {
    const f = fixture();
    codexFile(f.codex, "fork", [meta(B, A), usage(5000, NOW - 3 * DAY), usage(7000, NOW - 2 * DAY), usage(7500, NOW - 1000)]);
    expect((await index().summaries(f.config, NOW))[0]!.tokenCount).toBe(500);
  });
  test("Claude streaming and mirrored assistant IDs count the greatest usage once", async () => {
    const f = fixture();
    claudeFile(f.claude, A, [claudeUsage("message1", 100, NOW - 2000), claudeUsage("message1", 120, NOW - 1000), claudeUsage("message2", 10, NOW - 500)]);
    claudeFile(f.claude, A, [claudeUsage("message1", 120, NOW - 1000)], "mirror");
    const items = await index().summaries(f.config, NOW);
    expect(items).toHaveLength(1); expect(items[0]!.tokenCount).toBe(200);
    const exported = JSON.stringify(items);
    for (const privateText of ["SECRET", "/private", "hidden", A, "message1"]) expect(exported).not.toContain(privateText);
    expect(items[0]!.projectLabel).toBe("project");
  });
  test("incremental appends, split lines and rewritten files update without double counting", async () => {
    const f = fixture(); const reader = index();
    const path = codexFile(f.codex, "changes", [meta(), usage(100, NOW - 2000)]);
    expect((await reader.summaries(f.config, NOW))[0]!.tokenCount).toBe(100);
    const next = JSON.stringify(usage(200, NOW - 1000));
    appendFileSync(path, next.slice(0, 30));
    expect((await reader.summaries(f.config, NOW))[0]!.tokenCount).toBe(100);
    appendFileSync(path, next.slice(30) + "\n");
    expect((await reader.summaries(f.config, NOW))[0]!.tokenCount).toBe(200);
    expect((await reader.summaries(f.config, NOW))[0]!.tokenCount).toBe(200);
    codexFile(f.codex, "changes", [meta(), usage(50, NOW - 500)]);
    expect((await reader.summaries(f.config, NOW))[0]!.tokenCount).toBe(50);
  });
  test("enabled profiles, helper exclusion, malformed metadata and symlink escapes", async () => {
    const f = fixture();
    codexFile(f.codex, "valid", [meta(), usage(10, NOW - 1000)]);
    codexFile(f.codex, "helper", [{ ...meta(B), payload: { ...meta(B).payload, source: { subagent: { thread_spawn: {} } } } }, usage(500, NOW - 500)]);
    claudeFile(f.claude, B, [{ ...claudeUsage("helper", 200, NOW - 500) as object, isSidechain: true }]);
    const outside = join(f.dir, "outside.jsonl"); writeFileSync(outside, JSON.stringify(meta(C)) + "\n" + JSON.stringify(usage(900, NOW - 10)) + "\n");
    symlinkSync(outside, join(f.codex, "sessions", "escape.jsonl"));
    f.config.accounts.claude[0]!.enabled = false;
    f.config.accounts.codex.push({ ...f.config.accounts.codex[0]!, id: "duplicate" });
    const reader = index(); const items = await reader.summaries(f.config, NOW);
    expect(items).toHaveLength(1); expect(items[0]!.tokenCount).toBe(10);
    expect(await reader.target(items[0]!.id, f.config, NOW)).toEqual({ provider: "codex", account: "work", taskKey: items[0]!.id });
    expect(await reader.target("../outside", f.config, NOW)).toBeNull();
    f.config.accounts.codex.forEach(profile => profile.enabled = false);
    expect(await reader.target(items[0]!.id, f.config, NOW)).toBeNull();
  });
  test("recent zero-usage activity ranks ahead of older usage and stale usage is omitted", async () => {
    const f = fixture();
    codexFile(f.codex, "older", [meta(), usage(10000, NOW - DAY)]);
    codexFile(f.codex, "newer", [meta(B), { timestamp: iso(NOW - 100), type: "response_item", payload: { type: "message", content: "SECRET".repeat(20_000) } }]);
    codexFile(f.codex, "stale", [meta(C), usage(100000, NOW - 8 * DAY)]);
    const items = await index().summaries(f.config, NOW);
    expect(items.map(item => item.tokenCount)).toEqual([0, 10000]);
  });
  test("limits displayed rows to ten with deterministic ranking", async () => {
    const f = fixture();
    for (let n = 0; n < 12; n++) {
      const id = `${String(n + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
      codexFile(f.codex, String(n), [{ ...meta(id), payload: { id, cwd: `/private/project${n}` } }, usage(100, NOW - n * 1000)]);
    }
    const reader = index();
    expect(await reader.summaries(f.config, NOW)).toHaveLength(10);
    expect(await reader.summaries(f.config, NOW)).toEqual(await reader.summaries(f.config, NOW));
  });
  test("Claude copied records from a different session cannot become a resume target", async () => {
    const f = fixture();
    claudeFile(f.claude, B, [claudeUsage("copied", 500, NOW - 1000, A), claudeUsage("own", 10, NOW - 500, B)]);
    const items = await index().summaries(f.config, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(resumeTaskKey("claude", "personal", B));
    expect(items[0]!.tokenCount).toBe(45);
  });
  test("bounded tail reads retain metadata without importing the inherited total", async () => {
    const f = fixture();
    codexFile(f.codex, "large", [meta(), { type: "response_item", payload: { type: "message", content: "SECRET".repeat(10_000) } }, usage(10000, NOW - 1000, 50), usage(10100, NOW - 500, 100)]);
    const reader = new RecentWorkIndex({ inventoryTtlMs: 0, maxBytesPerFile: 500 });
    const items = await reader.summaries(f.config, NOW);
    expect(items).toHaveLength(1); expect(items[0]!.tokenCount).toBe(150);
    expect(JSON.stringify(items)).not.toContain("SECRET");
  });
  test("Git origin credentials and owner paths are absent from public project labels", async () => {
    const f = fixture(); const project = join(f.dir, "git-project");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(project, ".git", "objects")); mkdirSync(join(project, ".git", "refs"));
    writeFileSync(join(project, ".git", "config"), '[core]\n  repositoryformatversion = 0\n[remote "origin"]\n  url = https://secret-user:secret-token@example.com/private-owner/actual-repo.git?token=secret\n');
    codexFile(f.codex, "remote", [{ ...meta(), payload: { id: A, cwd: project } }, usage(10, NOW - 1000)]);
    const items = await index().summaries(f.config, NOW);
    expect(items[0]!.projectLabel).toBe("actual-repo");
    expect(JSON.stringify(items)).not.toContain("secret");
    expect(JSON.stringify(items)).not.toContain("private-owner");
  });
  test("invalid counters and identifiers never become usage", async () => {
    const f = fixture();
    codexFile(f.codex, "valid", [meta(), usage(-10, NOW - 1000), usage(Number.MAX_SAFE_INTEGER + 1, NOW - 500)]);
    codexFile(f.codex, "bad", [meta("not-a-uuid"), usage(99, NOW - 10)]);
    const items = await index().summaries(f.config, NOW);
    expect(items).toHaveLength(1); expect(items[0]!.tokenCount).toBe(0);
  });
});
