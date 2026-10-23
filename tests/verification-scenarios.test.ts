import { expect, test } from "bun:test";
import { verificationScenarios } from "../script/verification-scenarios";

test("focused UI checks retain the rendered prerequisites for every click", () => {
  const names = ["request-account-picker", "request-account-selected", "request-account-apply",
    "request-account-choose-other", "request-account-switch-context", "account-action-list", "account-action-repeat", "unrelated"];
  const scenarios = names.map(name => ({ name }));
  expect(verificationScenarios(scenarios, "request-account-switch-context,account-action-repeat").map(s => s.name))
    .toEqual(names.slice(0, -1));
  expect(verificationScenarios(scenarios)).toBe(scenarios);
});

test("unknown UI scenarios fail instead of reporting a successful empty selection", () => {
  const scenarios = [{ name: "known" }];
  for (const selection of ["", "typo", "known,typo"])
    expect(() => verificationScenarios(scenarios, selection)).toThrow("Unknown verification scenario");
});
