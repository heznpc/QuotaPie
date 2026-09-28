import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("relay lifecycle updates every live generation and never stops an unverified listener", async () => {
  const process = Bun.spawn(["python3", "-B", "tests/compaction_lifecycle.py"], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  expect(stderr).toBe("");
  if (exitCode !== 0) throw new Error(stdout);
  expect(exitCode).toBe(0);
});
