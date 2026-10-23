import type { AppConfig } from "./config";
import type { WindowAnalysis } from "./types";

export function nextWakeDelayMs(
  windows: (Pick<WindowAnalysis, "resetsAtMs" | "observedAtMs"> &
    Partial<Pick<WindowAnalysis, "provider" | "quality" | "usedPercent" | "metadata">>)[],
  config: AppConfig,
  nowMs = Date.now(),
): number {
  const candidates = [config.collection.pollSeconds * 1_000];
  for (const window of windows) {
    // A reset pass can be used before we have seen its balance change. Keep
    // blocked Codex accounts observable without any menu or manual refresh.
    // This only schedules a read; capacity still requires provider evidence.
    if (window.provider === "codex" && window.quality === "authoritative" && window.observedAtMs <= nowMs &&
        ((window.usedPercent != null && window.usedPercent >= 100) ||
          window.metadata?.ordinaryUsageAllowed === false || window.metadata?.spendControlReached === true)) {
      candidates.push(5_000);
    }
    if (window.resetsAtMs != null && window.resetsAtMs > nowMs) {
      candidates.push(window.resetsAtMs - nowMs + 1_000);
    }
    const staleAt = window.observedAtMs + config.collection.staleAfterSeconds * 1_000;
    if (staleAt > nowMs) candidates.push(staleAt - nowMs + 1_000);
  }
  return Math.max(1_000, Math.min(...candidates.filter((value) => value > 0)));
}
