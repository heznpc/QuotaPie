import { afterEach, expect } from "bun:test";
import { basename } from "node:path";

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
