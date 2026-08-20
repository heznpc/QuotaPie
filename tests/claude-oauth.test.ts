import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchClaudeUsage,
  keychainServiceCandidates,
  mapClaudeUsage,
  readClaudeCredentials,
} from "../src/providers/claude-oauth";

// 픽스처는 CodexBar가 실측으로 기록한 공식 usage 응답 형식 두 가지를 따른다:
// 구형 flat 필드와, 2026-07 이후의 limits 배열(weekly_scoped) 혼합형.

describe("claude oauth usage mapping", () => {
  test("maps flat five_hour/seven_day fields to statusline-compatible buckets", () => {
    const observations = mapClaudeUsage({
      five_hour: { utilization: 12.5, resets_at: "2026-12-25T12:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2026-12-31T00:00:00.000Z" },
      seven_day_sonnet: { utilization: 5 },
    }, "default", 1_000);
    expect(observations).toHaveLength(3);
    const fiveHour = observations.find((item) => item.bucket === "five_hour")!;
    expect(fiveHour.usedPercent).toBe(12.5);
    expect(fiveHour.resetsAtMs).toBe(Date.parse("2026-12-25T12:00:00.000Z"));
    expect(fiveHour.label).toBe("Claude 5h");
    expect(fiveHour.windowSeconds).toBe(5 * 3_600);
    expect(fiveHour.source).toBe("claude-oauth");
    const sonnet = observations.find((item) => item.bucket === "seven_day_sonnet")!;
    expect(sonnet.usedPercent).toBe(5);
    expect(sonnet.resetsAtMs).toBeNull();
  });

  test("null flat weeklies fall through to the limits array without duplicating filled buckets", () => {
    const observations = mapClaudeUsage({
      five_hour: { utilization: 11, resets_at: "2026-07-03T00:30:00.282668+00:00" },
      seven_day: { utilization: 9, resets_at: "2026-07-08T09:00:00.282694+00:00" },
      seven_day_opus: null,
      limits: [
        { kind: "session", group: "session", percent: 99, resets_at: "2026-07-03T00:30:00.282668+00:00", scope: null, is_active: true },
        { kind: "weekly_all", group: "weekly", percent: 88, resets_at: "2026-07-08T09:00:00.282694+00:00", scope: null, is_active: false },
        {
          kind: "weekly_scoped", group: "weekly", percent: 5,
          resets_at: "2026-07-08T09:00:00.283070+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: false,
        },
      ],
    }, "default", 1_000);
    // flat이 이미 채운 five_hour/seven_day는 limits의 99/88이 덮어쓰지 못한다.
    expect(observations.find((item) => item.bucket === "five_hour")!.usedPercent).toBe(11);
    expect(observations.find((item) => item.bucket === "seven_day")!.usedPercent).toBe(9);
    const fable = observations.find((item) => item.bucket === "seven_day_fable")!;
    expect(fable.usedPercent).toBe(5);
    expect(fable.windowSeconds).toBe(7 * 86_400);
  });

  test("garbage payloads produce no observations", () => {
    expect(mapClaudeUsage(null)).toHaveLength(0);
    expect(mapClaudeUsage("nope")).toHaveLength(0);
    expect(mapClaudeUsage({ five_hour: { utilization: "high" } })).toHaveLength(0);
    expect(mapClaudeUsage({ limits: [{ kind: "session" }] })).toHaveLength(0);
  });
});

describe("claude oauth credential lookup", () => {
  test("the default profile uses the shared service name", () => {
    expect(keychainServiceCandidates(join(homedir(), ".claude"))).toEqual(["Claude Code-credentials"]);
  });

  test("a separate profile never falls back to the default account's keychain item", () => {
    const candidates = keychainServiceCandidates("/tmp/quotapie-claude-work");
    expect(candidates).toEqual([
      "Claude Code-credentials-/tmp/quotapie-claude-work",
      "Claude Code-credentials-quotapie-claude-work",
    ]);
    expect(candidates).not.toContain("Claude Code-credentials");
  });

  test("an explicit keychainService overrides the derived candidates", () => {
    expect(keychainServiceCandidates("/tmp/whatever", "Custom-credentials")).toEqual(["Custom-credentials"]);
  });

  test("a profile directory without credentials reports auth-required, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    const lookup = readClaudeCredentials(dir);
    expect(lookup.accessToken).toBeNull();
    expect(lookup.errorCategory).toBe("auth-required");
  });

  test("an empty token in the credentials file is auth-required rather than a bearer of nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "" } }));
    const lookup = readClaudeCredentials(dir);
    expect(lookup.accessToken).toBeNull();
    expect(lookup.errorCategory).toBe("auth-required");
  });

  test("an expired token is reported as expired so the fix differs from first login", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "token", expiresAt: Date.now() - 1_000 },
    }));
    expect(readClaudeCredentials(dir).errorCategory).toBe("auth-expired");
  });
});

describe("claude usage fetch failure categories", () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("a rejected login is auth-expired, not a generic provider error", async () => {
    await expect(fetchClaudeUsage("t", ok({}, 401))).rejects.toMatchObject({ category: "auth-expired" });
    await expect(fetchClaudeUsage("t", ok({}, 403))).rejects.toMatchObject({ category: "auth-expired" });
  });

  test("provider throttling is its own category so the UI can say so", async () => {
    await expect(fetchClaudeUsage("t", ok({}, 429))).rejects.toMatchObject({ category: "rate-limited" });
  });

  test("a server error is a provider error", async () => {
    await expect(fetchClaudeUsage("t", ok({}, 503))).rejects.toMatchObject({ category: "provider-error" });
  });

  test("a hanging endpoint aborts on the timeout instead of stalling collection", async () => {
    const hang = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(fetchClaudeUsage("t", hang, 200)).rejects.toMatchObject({ category: "network" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
