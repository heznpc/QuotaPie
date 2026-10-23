import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { testArguments } from "../script/test-arguments";

test("default test discovery stays inside tests when runner options are supplied", () => {
  const root = "/fixture/tests";
  expect(testArguments([], root)).toEqual([root]);
  expect(testArguments(["--timeout", "30000"], root)).toEqual([root, "--timeout", "30000"]);
  expect(testArguments(["-t", "account routing", "--bail=1"], root)).toEqual([root, "-t", "account routing", "--bail=1"]);
  expect(testArguments(["--coverage", "--timeout=30000"], root)).toEqual([root, "--coverage", "--timeout=30000"]);
});

test("explicit files and path filters remain scoped to the caller's selection", () => {
  expect(testArguments(["tests/test-arguments.test.ts", "--timeout", "30000"], "/fixture/tests"))
    .toEqual([resolve("tests/test-arguments.test.ts"), "--timeout", "30000"]);
  expect(testArguments(["--timeout", "30000", "account-routing"], "/fixture/tests"))
    .toEqual(["--timeout", "30000", "account-routing"]);
});
