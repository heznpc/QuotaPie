import { afterEach, expect } from "bun:test";
import { basename, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// An environment-only sandbox can be undone by a fixture or a child process.
// Refuse direct `bun test`: the runner verifies the OS barrier before setting
// this marker, and child tests inherit the same sandbox.
if (process.env.QUOTAPIE_TEST_ISOLATION !== "verified") {
  throw new Error("Run tests with `bun run test` (or `bun script/test-isolated.ts <test-file>`); verified OS isolation is required.");
}
const isolatedRoot = mkdtempSync(join(tmpdir(), "quotapie-test-process-"));
process.env.QUOTAPIE_HOME = join(isolatedRoot, "data");
process.env.QUOTAPIE_CONFIG = join(isolatedRoot, "config.json");
process.on("exit", () => rmSync(isolatedRoot, { recursive: true, force: true }));

// The OS sandbox allows only these freshly reserved fixture ports. Mapping
// port 0 here keeps individual tests independent of the chosen port numbers.
const fixturePorts = (process.env.QUOTAPIE_TEST_PORTS ?? "").split(",").map(Number);
if (!fixturePorts.length || fixturePorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
  throw new Error("The isolated runner must provide valid fixture ports");
}
const serve = Bun.serve.bind(Bun);
let nextFixturePort = 0;
Bun.serve = ((options: any) => {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("Test servers must bind to loopback");
  }
  if (options.port !== undefined && options.port !== 0) {
    if (!fixturePorts.includes(Number(options.port))) throw new Error("Test server port is outside the isolated fixture pool; use port 0");
    return serve({ ...options, hostname });
  }
  for (let attempt = 0; attempt < fixturePorts.length; attempt++) {
    const port = fixturePorts[nextFixturePort++ % fixturePorts.length]!;
    try { return serve({ ...options, hostname, port }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
  }
  throw new Error("All isolated fixture ports are in use");
}) as typeof Bun.serve;

// Tests may exercise native queue hooks, but must never send real AppleScript
// notifications to the developer's desktop. Fail even if delivery catches the error.
const spawn = Bun.spawn.bind(Bun);
const blocked: string[] = [];
Bun.spawn = ((...args: any[]) => {
  const command = Array.isArray(args[0]) ? args[0] : args[0]?.cmd;
  if (command?.[0] && basename(String(command[0])) === "osascript") {
    blocked.push(String(command[0]));
    throw new Error("Real osascript delivery is forbidden in tests; disable desktop alerts or inject a queue hook");
  }
  return (spawn as any)(...args);
}) as typeof Bun.spawn;

afterEach(() => {
  const attempts = blocked.splice(0);
  expect(attempts, "Tests must not launch real desktop notifications").toEqual([]);
});
