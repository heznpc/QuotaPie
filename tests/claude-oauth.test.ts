import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  fetchClaudeUsage,
  keychainServiceCandidates,
  mapClaudeUsage,
  readClaudeCredentials,
  readClaudeCredentialsAsync,
} from "../src/providers/claude-oauth";

// The fixtures follow the two official usage response shapes CodexBar
// recorded from real traffic: the older flat fields, and the mixed form with
// the limits array (weekly_scoped) seen from 2026-07 onwards.

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
    // five_hour/seven_day already filled from the flat fields are not
    // overwritten by the 99/88 in limits.
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
  const missingKeychain = {
    platform: "darwin" as const,
    keychainLookup: () => ({ exitCode: 44, stdout: Buffer.alloc(0) }),
  };
  test("the default profile uses the shared service name", () => {
    expect(keychainServiceCandidates(join(homedir(), ".claude"))).toEqual(["Claude Code-credentials"]);
  });

  test("a separate profile never falls back to the default account's keychain item", () => {
    const candidates = keychainServiceCandidates("/tmp/quotapie-claude-work");
    const hash = createHash("sha256").update("/tmp/quotapie-claude-work").digest("hex").slice(0, 8);
    expect(candidates).toEqual([`Claude Code-credentials-${hash}`]);
    expect(candidates).not.toContain("Claude Code-credentials");
  });

  test("different profile roots with the same basename do not share credentials", () => {
    expect(keychainServiceCandidates("/tmp/one/work")).not.toEqual(keychainServiceCandidates("/tmp/two/work"));
    expect(keychainServiceCandidates("/tmp/caf\u00e9")).toEqual(keychainServiceCandidates("/tmp/cafe\u0301"));
  });

  test("an explicit keychainService overrides the derived candidates", () => {
    expect(keychainServiceCandidates("/tmp/whatever", "Custom-credentials")).toEqual(["Custom-credentials"]);
  });

  test("a profile directory without credentials reports auth-required, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    const lookup = readClaudeCredentials(dir, null, missingKeychain);
    expect(lookup.accessToken).toBeNull();
    expect(lookup.errorCategory).toBe("auth-required");
  });

  test("an empty token in the credentials file is auth-required rather than a bearer of nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "" } }));
    const lookup = readClaudeCredentials(dir, null, missingKeychain);
    expect(lookup.accessToken).toBeNull();
    expect(lookup.errorCategory).toBe("auth-required");
    expect(lookup.error).toContain("no access token");
  });

  test("an expired token is reported as expired so the fix differs from first login", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "token", expiresAt: Date.now() - 1_000 },
    }));
    expect(readClaudeCredentials(dir, null, missingKeychain).errorCategory).toBe("auth-expired");
  });

  test("keychain access denial, locked keychain and timeouts are not described as signed out", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    for (const [exitCode, signalCode, message] of [
      [35, null, "access was denied"],
      [36, null, "locked or requires user interaction"],
      [128, null, "access was denied"],
      [143, "SIGTERM", "timeout"],
      [1, null, "exit 1"],
    ] as const) {
      const lookup = readClaudeCredentials(dir, null, {
        platform: "darwin",
        keychainLookup: () => ({ exitCode, signalCode, stdout: Buffer.alloc(0), stderr: Buffer.from("secret") }),
      });
      expect(lookup.accessToken).toBeNull();
      expect(lookup.errorCategory).toBe("provider-error");
      expect(lookup.error).toContain(message);
      expect(lookup.error).not.toContain("secret");
      expect(lookup.error).not.toContain("login");
    }
  });

  test("a protected keychain item reported missing is distinguished from a missing login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-keychain-"));
    for (const asynchronous of [false, true]) {
      const lookups: boolean[] = [];
      const lookup = (_service: string, includeData: boolean) => {
        lookups.push(includeData);
        return { exitCode: includeData ? 44 : 0, stdout: Buffer.from("private metadata") };
      };
      const result = asynchronous
        ? await readClaudeCredentialsAsync(dir, null, { platform: "darwin", keychainLookup: async (...args) => lookup(...args) })
        : readClaudeCredentials(dir, null, { platform: "darwin", keychainLookup: lookup });
      expect(lookups).toEqual([true, false]);
      expect(result.errorCategory).toBe("provider-error");
      expect(result.error).toContain("item exists");
      expect(result.error).not.toContain("private metadata");
      expect(result.accessToken).toBeNull();
    }
  });

  test("metadata is probed only after a missing-data result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-keychain-"));
    for (const exitCode of [0, 35, 36, 128]) {
      const lookups: boolean[] = [];
      await readClaudeCredentialsAsync(dir, null, {
        platform: "darwin",
        keychainLookup: async (_service, includeData) => {
          lookups.push(includeData);
          return { exitCode, stdout: Buffer.from("{}") };
        },
      });
      expect(lookups).toEqual([true]);
    }
  });

  test("the current keychain account wins over a leftover plaintext fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old-account" } }));
    const lookup = readClaudeCredentials(dir, null, {
      platform: "darwin",
      keychainLookup: () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: "current-account" } })) }),
    });
    expect(lookup.accessToken).toBe("current-account");
  });

  test("a signed-out or inaccessible keychain never restores an old plaintext login", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old-account" } }));
    for (const result of [
      { exitCode: 0, stdout: Buffer.from("{}") },
      { exitCode: 35, stdout: Buffer.alloc(0) },
    ]) {
      const lookup = readClaudeCredentials(dir, null, { platform: "darwin", keychainLookup: () => result });
      expect(lookup.accessToken).toBeNull();
    }
  });

  test("an unavailable keychain command does not expose raw exception data", () => {
    const lookup = readClaudeCredentials("/tmp/profile", null, {
      platform: "darwin",
      keychainLookup: () => { throw new Error("secret"); },
    });
    expect(lookup.errorCategory).toBe("provider-error");
    expect(lookup.error).not.toContain("secret");
  });

  test("asynchronous lookup keeps the event loop responsive while the real child waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-keychain-"));
    const command = join(dir, "keychain-fixture");
    writeFileSync(command, `#!${process.execPath}\nawait Bun.sleep(180); process.exit(35);\n`);
    chmodSync(command, 0o755);
    let settled = false;
    const pending = readClaudeCredentialsAsync(dir, null, {
      platform: "darwin", keychainCommand: command, timeoutMs: 2_000,
    }).then(value => { settled = true; return value; });
    // A blocking spawn lets the child settle before this UI/status timer runs.
    await Bun.sleep(20);
    expect(settled).toBe(false);
    const result = await pending;
    expect(result.errorCategory).toBe("provider-error");
    expect(result.error).toContain("access was denied");
  });

  test("asynchronous keychain lookup kills a stuck child at its timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-keychain-"));
    const command = join(dir, "keychain-fixture");
    writeFileSync(command, `#!${process.execPath}\nawait Bun.sleep(30_000);\n`);
    chmodSync(command, 0o755);
    const started = Date.now();
    const result = await readClaudeCredentialsAsync(dir, null, {
      platform: "darwin", keychainCommand: command, timeoutMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.errorCategory).toBe("provider-error");
    expect(result.error).toContain("timeout");
  });

  test("asynchronous credential lookup retains the same account priority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-keychain-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fallback" } }));
    const result = await readClaudeCredentialsAsync(dir, null, {
      platform: "darwin",
      keychainLookup: async () => ({ exitCode: 0, stdout: Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: "current" } })) }),
    });
    expect(result.accessToken).toBe("current");
    const missing = await readClaudeCredentialsAsync(dir, null, {
      platform: "darwin", keychainLookup: async () => ({ exitCode: 44, stdout: Buffer.alloc(0) }),
    });
    expect(missing.accessToken).toBe("fallback");
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
