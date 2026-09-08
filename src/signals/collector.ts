import type { AppConfig } from "../config";
import { ResetSignalStore } from "../storage/reset-signal-store";
import { classifyPost } from "./classify";
import { fetchXPosts, readXToken, WATCHED_ACCOUNTS } from "./x-source";
import { fetchPublicFeed } from "./public-feed";

export class ResetSignalCollector {
  private inFlight: Promise<void> | null = null;
  constructor(readonly store: ResetSignalStore, private config: AppConfig["resetSignals"], private fetcher: typeof fetch = fetch) {}
  status(nowMs = Date.now()) {
    const health = this.store.health();
    const source = this.config.tokenFile ? "x-api" : "public-feed";
    return { ...health, enabled: this.config.enabled, source, watchedAccounts: WATCHED_ACCOUNTS,
      coverage: source === "x-api" ? "five-accounts" : "partial-relay",
      state: !this.config.enabled ? "off" : health.error ? "error" : !health.lastSuccessMs ? "waiting"
        : nowMs - health.lastSuccessMs > this.config.pollSeconds * 2000 ? "stale" : "ready",
      signals: this.store.list() };
  }
  poll(force = false, nowMs = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const health = this.store.health();
    if (!this.config.enabled || !force && health.lastAttemptMs != null && nowMs - health.lastAttemptMs < this.config.pollSeconds * 1000) return Promise.resolve();
    this.inFlight = this.collect(nowMs).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  settle() { return this.inFlight ?? Promise.resolve(); }
  private async collect(nowMs: number) {
    const health = this.store.health();
    const source = this.config.tokenFile ? "x-api" : "public-feed";
    this.store.setHealth({ ...health, lastAttemptMs: nowMs, source });
    try {
      const batch = this.config.tokenFile
        ? await fetchXPosts(readXToken(this.config.tokenFile), Math.max(nowMs - 6 * 86400_000,
            (health.source === source ? health.cursorMs : null) ?? nowMs - 24 * 3600_000) - 60_000, this.fetcher) : null;
      const context = new Map(batch?.context.map(p => [p.id, p]) ?? []);
      const signals = batch ? batch.posts.flatMap(p => { const s = classifyPost(p, context); return s ? [s] : []; })
        : await fetchPublicFeed(nowMs, this.fetcher);
      this.store.save(signals, nowMs);
      this.store.setHealth({ lastAttemptMs: nowMs, lastSuccessMs: nowMs, error: null, cursorMs: nowMs, source });
    } catch (error) {
      const message = error instanceof Error ? error.message : "collection-failed";
      const code = /^(x-|feed-|token-file-permissions|invalid-token-file)[a-z0-9-]*$/.test(message) ? message : "collection-failed";
      this.store.setHealth({ ...health, lastAttemptMs: nowMs, error: code, source });
    }
  }
}
