import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = mkdtempSync(resolve(tmpdir(), "quotapie-cli-i18n-"));
  temporaryDirectories.push(directory);
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      QUOTAPIE_CONFIG: resolve(directory, "missing-config.json"),
      QUOTAPIE_HOME: resolve(directory, "data"),
      QUOTAPIE_LOCALE: "ko",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("localized CLI edges", () => {
  test("help follows the resolved locale", async () => {
    const result = await runCli(["help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("사용법:");
    expect(result.stdout).toContain("로컬 데이터 소스 점검");
    expect(result.stderr).toBe("");
  });

  test("argument errors follow the same locale", async () => {
    const result = await runCli(["status", "--account"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[quotapie] 오류: --account 옵션에 값이 필요합니다");
  });
});
