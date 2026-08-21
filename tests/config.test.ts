import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";

function withConfig(value: unknown, run: (path: string) => void): void {
  const directory = mkdtempSync(resolve(tmpdir(), "quotapie-config-"));
  const path = resolve(directory, "config.json");
  writeFileSync(path, JSON.stringify(value));
  try {
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("account config", () => {
  test("rejects duplicate aliases before clients can be shared", () => {
    withConfig({
      accounts: {
        codex: [
          { id: "main", label: "Main", codexHome: "/tmp/a", enabled: true },
          { id: "main", label: "Other", codexHome: "/tmp/b", enabled: true },
        ],
      },
    }, (path) => expect(() => loadConfig(path)).toThrow("duplicate codex account id"));
  });

  test("rejects active aliases that share one credential directory", () => {
    withConfig({
      accounts: {
        claude: [
          { id: "main", label: "Main", configDir: "/tmp/claude-same", enabled: true },
          { id: "work", label: "Work", configDir: "/tmp/claude-same", enabled: true },
        ],
      },
    }, (path) => expect(() => loadConfig(path)).toThrow("use the same profile directory"));
  });

  test("rejects aliases that could collide with alert key separators", () => {
    withConfig({
      accounts: {
        codex: [{ id: "bad:id", label: "Bad", codexHome: "/tmp/bad", enabled: true }],
      },
    }, (path) => expect(() => loadConfig(path)).toThrow("must match"));
  });
});

describe("the local API stays local", () => {
  test("a non-loopback dashboard host is rejected instead of silently exposing the API", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ dashboard: { host: "0.0.0.0", port: 47831 } }));
    expect(() => loadConfig(path)).toThrow(/loopback/);
    writeFileSync(path, JSON.stringify({ dashboard: { host: "192.168.1.20", port: 47831 } }));
    expect(() => loadConfig(path)).toThrow(/loopback/);
  });

  test("loopback hosts and valid ports still load", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-config-"));
    const path = join(dir, "config.json");
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      writeFileSync(path, JSON.stringify({ dashboard: { host, port: 47831 } }));
      expect(loadConfig(path).dashboard.host).toBe(host);
    }
    writeFileSync(path, JSON.stringify({ dashboard: { host: "127.0.0.1", port: 0 } }));
    expect(() => loadConfig(path)).toThrow(/port/);
  });
});

describe("forecast inputs are validated at load", () => {
  function write(patch: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "tq-validate-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(patch));
    return path;
  }

  test("a weight above one is rejected instead of inverting the personal term", () => {
    expect(() => loadConfig(write({ profile: { recentWeight: 5 } }))).toThrow(/recentWeight/);
    expect(() => loadConfig(write({ profile: { recentWeight: -0.1 } }))).toThrow(/recentWeight/);
  });

  test("an unknown time zone fails at load rather than deep inside analytics", () => {
    expect(() => loadConfig(write({ profile: { timeZone: "Mars/Olympus" } }))).toThrow(/time zone/);
  });

  test("a zero poll interval is rejected", () => {
    expect(() => loadConfig(write({ collection: { pollSeconds: 0 } }))).toThrow(/pollSeconds/);
    expect(() => loadConfig(write({ collection: { staleAfterSeconds: -1 } }))).toThrow(/staleAfterSeconds/);
  });

  test("a reserve outside 0..100 is rejected", () => {
    expect(() => loadConfig(write({ reservePercent: { codex: { weekly: 150 } } }))).toThrow(/reservePercent/);
  });

  test("a malformed work schedule range is rejected", () => {
    expect(() => loadConfig(write({ profile: { workSchedule: { weekday: [{ start: "9시", end: "02:00" }] } } })))
      .toThrow(/workSchedule/);
    expect(() => loadConfig(write({ profile: { workSchedule: { weekday: [{ start: "25:00", end: "02:00" }] } } })))
      .toThrow(/workSchedule/);
  });

  test("the shipped defaults pass their own validation", () => {
    expect(loadConfig(write({})).profile.recentWeight).toBe(0.7);
  });
});
