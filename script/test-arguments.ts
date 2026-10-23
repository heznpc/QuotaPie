import { existsSync } from "node:fs";
import { resolve } from "node:path";

const valueFlags = new Set(["-t", "--test-name-pattern", "--timeout", "--rerun-each", "--retry",
  "--seed", "--max-concurrency", "--preload", "-r", "--config", "-c", "--cwd", "--env-file",
  "--reporter", "--reporter-outfile", "--coverage-dir", "--coverage-reporter", "--bail"]);

/** Flags alone must not expand discovery from tests/ into the whole checkout. */
export function testArguments(args: string[], defaultTarget: string): string[] {
  let optionValue = false, hasTarget = false;
  const result = args.map(arg => {
    if (optionValue) { optionValue = false; return arg; }
    if (arg.startsWith("-")) { optionValue = valueFlags.has(arg); return arg; }
    hasTarget = true;
    // Absolute paths avoid Bun's relative test-file/preload discovery ambiguity.
    return existsSync(arg) ? resolve(arg) : arg;
  });
  return hasTarget ? result : [defaultTarget, ...result];
}
