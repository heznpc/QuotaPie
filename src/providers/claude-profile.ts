import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Setting even the default directory changes Claude's macOS Keychain namespace. */
export function claudeProfileEnvironment(root: string): Record<string, string> {
  return canonical(root) === canonical(resolve(homedir(), ".claude"))
    ? {} : { CLAUDE_CONFIG_DIR: root };
}
