import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { nextWakeDelayMs } from "../src/scheduler";
import type { QuotaObservation } from "../src/types";

const now = 2_000_000_000_000;
const window: QuotaObservation = { provider: "codex", account: "a", bucket: "codex:primary:300",
  label: "5h", windowSeconds: 18_000, source: "codex-appserver", quality: "authoritative",
  observedAtMs: now, resetsAtMs: now + 3_600_000, usedPercent: 100 };

test("exhausted and explicitly blocked Codex accounts are checked before any reset-pass observation", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.pollSeconds = 60;
  expect(nextWakeDelayMs([window], config, now)).toBe(5_000);
  expect(nextWakeDelayMs([{ ...window, usedPercent: 20, metadata: { ordinaryUsageAllowed: false } }], config, now)).toBe(5_000);
  expect(nextWakeDelayMs([{ ...window, usedPercent: 20, metadata: { spendControlReached: true } }], config, now)).toBe(5_000);
  expect(nextWakeDelayMs([{ ...window, usedPercent: 0, metadata: { ordinaryUsageAllowed: true } }], config, now)).toBe(60_000);
  expect(nextWakeDelayMs([{ ...window, resetsAtMs: now + 1_000 }], config, now)).toBe(2_000);
  config.collection.pollSeconds = 2;
  expect(nextWakeDelayMs([window], config, now)).toBe(2_000);
});

test("unverified, future, and Claude observations do not activate Codex recovery polling", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.pollSeconds = 60;
  expect(nextWakeDelayMs([{ ...window, quality: "derived" }], config, now)).toBe(60_000);
  expect(nextWakeDelayMs([{ ...window, observedAtMs: now + 1 }], config, now)).toBe(60_000);
  expect(nextWakeDelayMs([{ ...window, provider: "claude" }], config, now)).toBe(60_000);
});
