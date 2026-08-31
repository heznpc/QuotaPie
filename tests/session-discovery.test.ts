import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  claudeMetadataFromLine,
  findClaudeResumeTarget,
  findCodexResumeTarget,
  resumeTaskKey,
} from "../src/session-discovery";

const SESSION = "33333333-3333-4333-8333-333333333333";

describe("provider session discovery", () => {
  test("extracts only top-level Claude metadata", () => {
    const line = JSON.stringify({
      message: { cwd: "/message/must-not-win", customTitle: "prompt title" },
      prompt: `ignore \\"cwd\\":\"/also-not-this\"`,
      sessionId: SESSION,
      cwd: "/real/project",
      customTitle: "Real title",
    });
    expect(claudeMetadataFromLine(line)).toEqual({
      sessionId: SESSION,
      cwd: "/real/project",
      customTitle: "Real title",
    });
  });

  test("finds only top-level project JSONL and returns metadata without content", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-claude-discovery-"));
    const project = resolve(directory, "projects", "-private-tmp-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(resolve(project, `${SESSION}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId: SESSION,
        cwd: "/private/tmp/project",
        message: { content: "do not export this prompt" },
      }),
      JSON.stringify({ type: "custom-title", sessionId: SESSION, customTitle: "Quota recovery" }),
    ].join("\n"));
    const target = await findClaudeResumeTarget(
      directory,
      "default",
      resumeTaskKey("claude", "default", SESSION),
    );
    expect(target).toEqual({
      nativeId: SESSION,
      cwd: "/private/tmp/project",
      name: "Quota recovery",
    });
    expect(JSON.stringify(target)).not.toContain("do not export");
    rmSync(directory, { recursive: true, force: true });
  });

  test("pages Codex thread/list and checks archived threads too", async () => {
    const calls: Array<{
      cursor?: string | null;
      archived?: boolean | null;
      useStateDbOnly?: boolean;
    }> = [];
    const target = await findCodexResumeTarget({
      async listThreads(params = {}) {
        calls.push(params);
        if (!params.archived && params.cursor == null) {
          return {
            data: [{ id: "44444444-4444-4444-8444-444444444444", cwd: "/other", name: null }],
            nextCursor: "next",
          };
        }
        if (!params.archived) return { data: [], nextCursor: null };
        return {
          data: [{ id: SESSION, cwd: "/private/tmp/project", name: "Found" }],
          nextCursor: null,
        };
      },
    }, "default", resumeTaskKey("codex", "default", SESSION));
    expect(target).toEqual({ nativeId: SESSION, cwd: "/private/tmp/project", name: "Found" });
    expect(calls.map((call) => [call.archived, call.cursor ?? null])).toEqual([
      [false, null],
      [false, "next"],
      [true, null],
    ]);
    expect(calls.every((call) => call.useStateDbOnly === true)).toBeTrue();
  });
});
