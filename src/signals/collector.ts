import type { AppConfig } from "../config";
import { ResetSignalStore, type SourceHealth } from "../storage/reset-signal-store";
import { classifyPost, type ResetSignal } from "./classify";
import { fetchXPosts, readXToken, WATCHED_ACCOUNTS } from "./x-source";
import { fetchPublicFeed } from "./public-feed";
import { fetchCodexReset } from "./codexreset-source";

export class ResetSignalCollector {
  private inFlight: Promise<void> | null = null;
  constructor(readonly store: ResetSignalStore, private config: AppConfig["resetSignals"], private fetcher: typeof fetch = fetch) {}
  status(nowMs = Date.now()) {
    const health = this.store.health();
    const sources = this.sourceDefinitions().map(def => {
      const saved = health.sources?.find(s => s.id === def.id);
      const { fingerprints: _, ...safe } = saved ?? {};
      return { ...safe, id: def.id, coverage: saved?.coverage ?? def.coverage,
        state: !this.config.enabled ? "off" : saved?.error ? "error" : !saved?.lastSuccessMs ? "waiting"
          : nowMs - saved.lastSuccessMs > this.config.pollSeconds * 2000 ? "stale" : "ready" };
    });
    const ready = sources.filter(s => s.state === "ready").length;
    const { sources: _, ...legacy } = health;
    return { ...legacy, enabled: this.config.enabled, source: "multiple", watchedAccounts: WATCHED_ACCOUNTS,
      coverage: this.config.tokenFile ? "direct-and-relays" : "partial-relays", sources,
      state: !this.config.enabled ? "off" : ready === sources.length ? "ready" : ready ? "partial"
        : sources.every(s => s.state === "waiting") ? "waiting" : "error",
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
  private sourceDefinitions() {
    return [
      { id: "public-feed", coverage: "reset-beacon-selection" },
      { id: "codexreset", coverage: "codexreset-quoted-posts" },
      ...(this.config.tokenFile ? [{ id: "x-api", coverage: "five-accounts" }] : []),
    ];
  }
  private async collect(nowMs: number) {
    const health = this.store.health();
    this.store.setHealth({ ...health, lastAttemptMs: nowMs });
    const results = await Promise.all(this.sourceDefinitions().map(async def => {
      const previous = health.sources?.find(s => s.id === def.id);
      const saved: SourceHealth = previous ?? { ...def, lastAttemptMs: null, lastSuccessMs: null,
        error: null, cursorMs: null, latestPublishedAtMs: null, lastEvidenceMs: null, newEvidenceCount: 0, fingerprints: [] };
      try {
        let signals: ResetSignal[];
        let coverage = def.coverage;
        let examinedPosts: number | undefined, latestPostAtMs: number | null | undefined;
        if (def.id === "x-api") {
          const batch = await fetchXPosts(readXToken(this.config.tokenFile!),
            Math.max(nowMs - 6 * 86400_000, saved.cursorMs ?? nowMs - 24 * 3600_000) - 60_000, this.fetcher);
          const context = new Map(batch.context.map(p => [p.id, p]));
          signals = batch.posts.flatMap(p => { const s = classifyPost(p, context); return s ? [s] : []; });
          examinedPosts = batch.posts.length;
          latestPostAtMs = batch.posts.length ? Math.max(...batch.posts.map(p => p.createdAtMs)) : null;
        } else if (def.id === "codexreset") {
          ({ signals, coverage, examinedPosts, latestPostAtMs } = await fetchCodexReset(nowMs, this.fetcher));
        } else signals = await fetchPublicFeed(nowMs, this.fetcher);
        const fresh = signals.filter(s => !saved.fingerprints.includes(s.fingerprint));
        const next: SourceHealth = { ...saved, coverage, examinedPosts, latestPostAtMs,
          lastAttemptMs: nowMs, lastSuccessMs: nowMs, error: null, cursorMs: nowMs,
          latestPublishedAtMs: signals.length ? Math.max(...signals.map(s => s.publishedAtMs)) : saved.latestPublishedAtMs,
          lastEvidenceMs: fresh.length ? nowMs : saved.lastEvidenceMs, newEvidenceCount: fresh.length,
          fingerprints: [...new Set([...saved.fingerprints, ...signals.map(s => s.fingerprint)])].slice(-2000) };
        return { health: next, signals };
      } catch (error) {
        const message = error instanceof Error ? error.message : "collection-failed";
        const code = /^(x-|feed-|monitor-|token-file-permissions|invalid-token-file)[a-z0-9-]*$/.test(message) ? message : "collection-failed";
        return { health: { ...saved, lastAttemptMs: nowMs, newEvidenceCount: 0, error: code }, signals: [] as ResetSignal[] };
      }
    }));
    // Deterministic selection avoids racing two relays into different revisions.
    const priority = { "public-feed": 1, "codexreset": 2, "x-api": 3 };
    const chosen = new Map<string, ResetSignal>();
    for (const signal of results.flatMap(r => r.signals).sort((a, b) => priority[a.observedVia] - priority[b.observedVia])) {
      chosen.set(signal.id, signal);
    }
    this.store.save([...chosen.values()], nowMs);
    const sources = results.map(r => r.health);
    const success = sources.some(s => s.error === null);
    this.store.setHealth({ lastAttemptMs: nowMs, lastSuccessMs: success ? nowMs : health.lastSuccessMs,
      error: sources.every(s => s.error) ? sources[0]!.error : null,
      cursorMs: success ? nowMs : health.cursorMs, source: "multiple", sources });
  }
}
