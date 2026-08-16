import type { AppConfig } from "./config";
import type { WindowAnalysis } from "./types";

export function nextWakeDelayMs(
  windows: WindowAnalysis[],
  config: AppConfig,
  nowMs = Date.now(),
): number {
  const candidates = [config.collection.pollSeconds * 1_000];
  for (const window of windows) {
    if (window.resetsAtMs != null && window.resetsAtMs > nowMs) {
      candidates.push(window.resetsAtMs - nowMs + 1_000);
    }
    const staleAt = window.observedAtMs + config.collection.staleAfterSeconds * 1_000;
    if (staleAt > nowMs) candidates.push(staleAt - nowMs + 1_000);
  }
  return Math.max(1_000, Math.min(...candidates.filter((value) => value > 0)));
}
