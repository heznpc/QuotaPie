import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
