import { expect, test } from "bun:test";
import { selectTaskModel, type SelectTaskModelInput, type TaskModelChoice } from "../packages/quota-core/src/index.js";
import { selectTaskModel as hostSelection } from "../src/task-model-selection";

const manual = { provider: "one", model: "manual", effort: "low" } as const;
const phaseChoice = { provider: "one", model: "phase", effort: "high" } as const;
const fallback = { provider: "two", model: "default" } as const;
const base: SelectTaskModelInput = {
  phase: "verification",
  manualSelection: manual,
  phasePreferences: { verification: phaseChoice },
  defaultSelection: fallback,
  capabilities: [
    { provider: "one", model: "manual", efforts: ["low"] },
    { provider: "one", model: "phase", efforts: ["high"] },
    { provider: "two", model: "default", efforts: [] },
  ],
};

test("QuotaPie uses the same public selector", () => {
  expect(hostSelection).toBe(selectTaskModel);
});

test("manual > exact phase > default, with explicit reasons", () => {
  expect(selectTaskModel(base)).toEqual({ status: "selected", phase: "verification",
    source: "manual", selection: manual, reason: "manual_selection" });
  expect(selectTaskModel({ ...base, manualSelection: null })).toEqual({ status: "selected",
    phase: "verification", source: "phase", selection: phaseChoice, reason: "phase_preference" });
  for (const phasePreferences of [undefined, {}, { verification: null }, { verification: undefined }, { research: phaseChoice }]) {
    expect(selectTaskModel({ ...base, manualSelection: undefined, phasePreferences })).toEqual({ status: "selected",
      phase: "verification", source: "default", selection: fallback, reason: "default_selection" });
  }
});

test.each([
  [{ provider: "missing", model: "manual" }, "unsupported_provider"],
  [{ provider: "one", model: "missing" }, "unsupported_model"],
  [{ ...manual, effort: "high" }, "unsupported_effort"],
  [{ ...manual, provider: " " }, "invalid_selection"],
  [{ ...manual, model: "" }, "invalid_selection"],
  [{ ...manual, effort: " " }, "invalid_selection"],
] as const)("unavailable choice %j never falls through (%s)", (choice, reason) => {
  const scenarios: Array<["manual" | "phase" | "default", SelectTaskModelInput]> = [
    ["manual", { ...base, manualSelection: choice }],
    ["phase", { ...base, manualSelection: null, phasePreferences: { verification: choice } }],
    ["default", { ...base, manualSelection: null, phasePreferences: {}, defaultSelection: choice }],
  ];
  for (const [source, input] of scenarios) {
    expect(selectTaskModel(input)).toEqual({ status: "unavailable", phase: "verification",
      source, selection: null, requested: choice, reason });
  }
});

test("no choice or no capability yields no invented selection", () => {
  expect(selectTaskModel({ phase: "구상", capabilities: base.capabilities })).toEqual({
    status: "unavailable", phase: "구상", source: null, selection: null, requested: null, reason: "no_selection",
  });
  expect(selectTaskModel({ ...base, capabilities: [] })).toMatchObject({
    status: "unavailable", source: "manual", requested: manual, reason: "unsupported_provider",
  });
  for (const phase of ["", " \n\t"]) expect(selectTaskModel({ ...base, phase })).toEqual({
    status: "unavailable", phase, source: null, selection: null, requested: null, reason: "invalid_phase",
  });
});

test("model and effort support cannot leak between providers or models", () => {
  const capabilities = [
    { provider: "one", model: "same", efforts: ["low"] },
    { provider: "two", model: "same", efforts: ["high"] },
    { provider: "one", model: "other", efforts: ["high"] },
  ];
  expect(selectTaskModel({ phase: "custom", manualSelection: { provider: "one", model: "same", effort: "high" }, capabilities }))
    .toMatchObject({ status: "unavailable", reason: "unsupported_effort" });
  expect(selectTaskModel({ phase: "custom", manualSelection: { provider: "two", model: "other" }, capabilities }))
    .toMatchObject({ status: "unavailable", reason: "unsupported_model" });
});

test("omitted effort stays omitted; explicit none needs support; duplicate rows union", () => {
  const input = { phase: "custom", defaultSelection: fallback, capabilities: base.capabilities };
  const selected = selectTaskModel(input);
  expect(selected.status).toBe("selected");
  expect(Object.hasOwn(selected.selection!, "effort")).toBe(false);
  const explicit = { ...input, defaultSelection: { ...fallback, effort: "none" } };
  expect(selectTaskModel(explicit)).toMatchObject({ status: "unavailable", reason: "unsupported_effort" });
  const capabilities = [...base.capabilities, { ...fallback, efforts: ["none"] }];
  for (const list of [capabilities, [...capabilities].reverse()]) {
    expect(selectTaskModel({ ...explicit, capabilities: list })).toMatchObject({ status: "selected",
      selection: { ...fallback, effort: "none" } });
  }
});

test("phase labels are opaque exact own keys, including prototype-like labels", () => {
  const inherited = Object.create({ verification: phaseChoice });
  expect(selectTaskModel({ ...base, manualSelection: null, phasePreferences: inherited }))
    .toMatchObject({ source: "default", selection: fallback });
  for (const phase of ["구상", "research", "verification", "__proto__", "constructor"]) {
    const phasePreferences = JSON.parse(JSON.stringify({ [phase]: phaseChoice }));
    expect(selectTaskModel({ ...base, phase, manualSelection: null, phasePreferences }))
      .toMatchObject({ status: "selected", source: "phase", selection: phaseChoice });
  }
  expect(selectTaskModel({ ...base, phase: "Verification", manualSelection: null }))
    .toMatchObject({ source: "default", selection: fallback });
  for (const choice of [{ ...manual, provider: "One" }, { ...manual, model: "manual " }, { ...manual, effort: "Low" }]) {
    expect(selectTaskModel({ ...base, manualSelection: choice }).status).toBe("unavailable");
  }
});

test("selection is deterministic, projects metadata, and never mutates or retains inputs", () => {
  const choice = Object.freeze({ ...manual, prompt: "private", token: "private" });
  const input = Object.freeze({ ...base, manualSelection: choice,
    phasePreferences: Object.freeze({ verification: Object.freeze(phaseChoice) }),
    capabilities: Object.freeze(base.capabilities.map(row => Object.freeze({ ...row, efforts: Object.freeze([...row.efforts]) }))),
  });
  const before = JSON.stringify(input);
  const first = selectTaskModel(input);
  expect(first).toEqual(selectTaskModel(input));
  expect(JSON.stringify(input)).toBe(before);
  expect(JSON.stringify(first)).not.toContain("private");
  expect(first.selection).not.toBe(choice);
  (first.selection as { model: string }).model = "changed-output";
  expect(selectTaskModel(input).selection).toEqual(manual);
  const rejected = selectTaskModel({ ...input, capabilities: [] });
  if (rejected.status !== "unavailable") throw new Error("Expected rejection");
  expect(rejected.requested).not.toBe(choice);
  expect(rejected.requested).toEqual(manual satisfies TaskModelChoice);
});
