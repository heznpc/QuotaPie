import { analyzeWindow, analysisHistoryStart, buildHeadline, groupStatuses } from "./analytics";
import { buildQuotaBoundary, cachedLeaderboard, collectionHealth, writeQuotaBoundary } from "./boundary";
import type { AppConfig, CodexAccountConfig } from "./config";
import { codexUsesFileCredentials, resolveUserPath } from "./config";
import { QuotaDatabase } from "./db";
import { selectClaudeConsensus } from "./domain/claude-consensus";
import { AlertStore } from "./storage/alert-store";
import { ClaudeSessionStore } from "./storage/claude-session-store";
import { CollectionStore } from "./storage/collection-store";
import type { QuotaStorage } from "./storage/database";
import { CodexAppServerClient } from "./providers/codex-appserver";
import { ClaudeUsageError, fetchClaudeUsage, mapClaudeUsage, readClaudeCredentials } from "./providers/claude-oauth";
import { resolveLocale, t } from "./i18n";
import type { Locale } from "./i18n";
import { nextWakeDelayMs } from "./scheduler";
import { alertScope, deliverTrigger, planTriggers } from "./triggers";
import type {
  AccountState,
  CollectionHealth,
  CollectionSourceState,
  Headline,
  Provider,
  ProviderStatus,
  QuotaEvent,
  QuotaObservation,
  TriggerDecision,
  WindowAnalysis,
} from "./types";

export const CLAUDE_OAUTH_SOURCE = "claude-oauth";
export const CLAUDE_STATUSLINE_SOURCE = "claude-statusline";
export const CODEX_SOURCE = "codex-appserver";

const HEALTH_RANK: Record<CollectionHealth, number> = {
  "recent-success": 3,
  "stale-success": 2,
  "attempted-then-failed": 1,
  "never-attempted": 0,
};

// When both sources succeeded recently, which one is shown as active is not
// a matter of taste: it has to match the authority applied to the history.
// If the order values are accepted in differs from the order they are
// displayed in, the UI reports the wrong collection path.
const SOURCE_AUTHORITY: Record<string, number> = {
  [CLAUDE_OAUTH_SOURCE]: 2,
  [CODEX_SOURCE]: 2,
  [CLAUDE_STATUSLINE_SOURCE]: 1,
};

export class QuotaPieService {
  readonly db: QuotaDatabase;
  readonly storage: QuotaStorage;
  readonly alerts: AlertStore;
  readonly collection: CollectionStore;
  readonly claudeSessions: ClaudeSessionStore;
  private codexClients = new Map<string, CodexAppServerClient>();
  private stopped = false;
  private closing = false;
  private codexPollState = new Map<string, { count: number; error: string | null }>();
  private claudeOAuthLastPollMs = new Map<string, number>();
  // The official usage endpoint is rate limited on the provider side, so this
  // polls more loosely than Codex does.
  static readonly CLAUDE_OAUTH_MIN_INTERVAL_MS = 5 * 60_000;

  readonly locale: Locale;

  constructor(
    readonly config: AppConfig,
    database?: QuotaDatabase,
  ) {
    this.db = database ?? new QuotaDatabase();
    // One connection, several collaborators. The service depends on each of
    // them directly rather than reaching through the database for everything.
    this.storage = this.db.storage;
    this.alerts = new AlertStore(this.storage);
    this.collection = new CollectionStore(this.storage);
    this.claudeSessions = new ClaudeSessionStore(this.storage);
    this.locale = resolveLocale(config.profile.locale);
  }

  ingest(observations: QuotaObservation[]): QuotaEvent[] {
    const emitted: QuotaEvent[] = [];
    for (const observation of observations) {
      emitted.push(...this.db.ingestObservation(observation, this.config));
    }
    return emitted;
  }

  ingestCodexSnapshot(observations: QuotaObservation[]): QuotaEvent[] {
    if (!observations.length) return [];
    const emitted: QuotaEvent[] = [];
    const grouped = new Map<string, QuotaObservation[]>();
    for (const observation of observations) {
      const list = grouped.get(observation.account) ?? [];
      list.push(observation);
      grouped.set(observation.account, list);
    }
    for (const [account, accountObservations] of grouped) {
      const observedAtMs = Math.max(...accountObservations.map((item) => item.observedAtMs));
      // Codex can switch the period of the same limit lane between 7 and 30
      // days. The period is part of the bucket identity, so normally this
      // only surfaces as the old bucket retiring on the second miss after
      // the new one appears. Catch it as a lane switch on the first full
      // response instead.
      const previousLaneWindows = this.db.latestAll().filter((item) =>
        item.provider === "codex" && item.account === account
      );
      const result = this.db.ingestFullSnapshot(
        "codex",
        account,
        accountObservations,
        this.config,
      );
      emitted.push(...result.events);
      if (!result.accepted) continue;
      const currentBuckets = new Set(accountObservations.map((item) => item.bucket));
      for (const next of accountObservations) {
        const limitId = next.metadata?.limitId;
        const lane = next.metadata?.lane;
        if (typeof limitId !== "string" || typeof lane !== "string") continue;
        const previous = previousLaneWindows
          .filter((item) =>
            item.bucket !== next.bucket &&
            !currentBuckets.has(item.bucket) &&
            item.metadata?.limitId === limitId &&
            item.metadata?.lane === lane
          )
          .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];
        if (!previous) continue;
        const value: QuotaEvent = {
          provider: next.provider,
          account: next.account,
          bucket: next.bucket,
          kind: "window_changed",
          severity: "info",
          occurredAtMs: next.observedAtMs,
          confidence: "high",
          displayText: t("event.window_changed", {
            limitId,
            lane,
            fromLabel: previous.label,
            toLabel: next.label,
          }, this.locale),
          details: {
            limitId,
            lane,
            fromLabel: previous.label,
            toLabel: next.label,
            previousBucket: previous.bucket,
            nextBucket: next.bucket,
            previousWindowSeconds: previous.windowSeconds,
            nextWindowSeconds: next.windowSeconds,
          },
        };
        if (this.db.insertEvent(value)) emitted.push(value);
      }
      for (const previous of result.retired) {
        const value: QuotaEvent = {
          provider: previous.provider,
          account: previous.account,
          bucket: previous.bucket,
          kind: "bucket_retired",
          severity: "info",
          occurredAtMs: observedAtMs,
          confidence: "high",
          displayText: t("event.bucket_retired", { label: previous.label }, this.locale),
          details: { label: previous.label, lastObservedAtMs: previous.observedAtMs, fullReadsMissed: 2 },
        };
        if (this.db.insertEvent(value)) emitted.push(value);
      }
    }
    return emitted;
  }

  ingestClaudeSessions(observations: QuotaObservation[], nowMs = Date.now()): QuotaEvent[] {
    const consensus = this.reconcileClaudeSessions(observations);
    const accepted: QuotaObservation[] = [];
    for (const observation of consensus) {
      this.collection.recordAttempt(
        "claude",
        observation.account,
        CLAUDE_STATUSLINE_SOURCE,
        observation.observedAtMs,
        null,
        null,
      );
      // The status line is a fallback. For accounts where OAuth recently
      // succeeded its values stay out of the history, which stops the two
      // sources from alternating and manufacturing source-change and
      // meter-correction noise.
      if (!this.oauthIsAuthoritative(observation.account, nowMs)) accepted.push(observation);
    }
    return this.ingest(accepted);
  }

  /// Persistence and decision, kept apart: the store writes and reads rows, and
  /// selectClaudeConsensus decides which of them wins.
  private reconcileClaudeSessions(observations: QuotaObservation[]): QuotaObservation[] {
    const valid = observations.filter((observation) =>
      observation.provider === "claude" && typeof observation.metadata?.sessionHash === "string"
    );
    if (!valid.length) return [];
    const ttlMs = this.config.collection.claudeSessionTtlSeconds * 1_000;
    const referenceMs = Math.max(...valid.map((observation) => observation.observedAtMs));
    const affected = [
      ...new Map(
        valid.map((observation) => [
          `${observation.account}\u0000${observation.bucket}`,
          { account: observation.account, bucket: observation.bucket },
        ]),
      ).values(),
    ];
    return this.storage.transaction(() => {
      this.claudeSessions.upsertSessionRows(valid);
      const rows = this.claudeSessions.activeSessionRowsSince(referenceMs - ttlMs);
      return selectClaudeConsensus(rows, affected, ttlMs, referenceMs);
    });
  }

  private oauthIsAuthoritative(account: string, nowMs: number): boolean {
    const state = this.collection
      .sourceStates()
      .find((row) =>
        row.provider === "claude" && row.account === account && row.source === CLAUDE_OAUTH_SOURCE
      );
    if (state?.lastSuccessMs == null) return false;
    return nowMs - state.lastSuccessMs <= this.config.collection.staleAfterSeconds * 1_000;
  }

  async pollCodex(): Promise<QuotaEvent[]> {
    if (!this.config.collection.codexEnabled) return [];
    const profiles = this.config.accounts.codex.filter((profile) => profile.enabled);
    if (!profiles.length) return [];
    const requireFileCredentials = profiles.length > 1;
    const outcomes = await Promise.all(profiles.map(async (profile) => {
      if (requireFileCredentials && !codexUsesFileCredentials(profile)) {
        const message = "multi-account Codex requires cli_auth_credentials_store = \"file\" in this profile's config.toml";
        this.codexPollState.set(profile.id, { count: 0, error: message });
        this.collection.recordAttempt(
          "codex", profile.id, CODEX_SOURCE, Date.now(), message, "isolation-unsafe",
        );
        console.error(`[quotapie] Codex account ${profile.id} skipped: ${message}`);
        return { ok: false as const, events: [] as QuotaEvent[], message };
      }
      let client = this.codexClients.get(profile.id);
      if (!client) {
        client = this.createCodexClient(profile);
        this.codexClients.set(profile.id, client);
      }
      try {
        const observations = await client.readRateLimits();
        // A response that arrives with no windows is not a success. Recording
        // it as one lets /health pass it as recent-success while doctor fails
        // it on window count, putting the two surfaces back at odds.
        if (!observations.length) {
          const message = "rate limit response contained no windows";
          this.codexPollState.set(profile.id, { count: 0, error: message });
          this.collection.recordAttempt("codex", profile.id, CODEX_SOURCE, Date.now(), message, "no-windows");
          return { ok: false as const, events: [] as QuotaEvent[], message };
        }
        this.codexPollState.set(profile.id, { count: observations.length, error: null });
        this.collection.recordAttempt("codex", profile.id, CODEX_SOURCE, Date.now(), null, null);
        return {
          ok: true as const,
          events: this.closing ? [] : this.ingestCodexSnapshot(observations),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.codexPollState.set(profile.id, { count: 0, error: message });
        this.collection.recordAttempt("codex", profile.id, CODEX_SOURCE, Date.now(), message, "provider-error");
        await client.close().catch(() => undefined);
        this.codexClients.delete(profile.id);
        console.error(`[quotapie] Codex account ${profile.id} refresh failed: ${message}`);
        return { ok: false as const, events: [] as QuotaEvent[], message };
      }
    }));
    if (!outcomes.some((outcome) => outcome.ok)) {
      throw new Error(`all configured Codex accounts failed (${profiles.map((profile) => profile.id).join(", ")})`);
    }
    return outcomes.flatMap((outcome) => outcome.events);
  }

  // force exists for doctor: a diagnostic has to see the state now rather
  // than wait for the next polling interval. fetchImpl is the seam tests use
  // to reproduce provider failures.
  async pollClaudeOAuth(
    nowMs = Date.now(),
    force = false,
    fetchImpl: typeof fetch = fetch,
  ): Promise<QuotaEvent[]> {
    // force skips the polling interval, not the configuration gate. A
    // diagnostic must never quietly read credentials the user has opted out
    // of sharing.
    if (!this.config.collection.claudeOAuthEnabled) return [];
    const emitted: QuotaEvent[] = [];
    for (const profile of this.config.accounts.claude.filter((item) => item.enabled)) {
      const lastPollMs = this.claudeOAuthLastPollMs.get(profile.id) ?? 0;
      if (!force && nowMs - lastPollMs < QuotaPieService.CLAUDE_OAUTH_MIN_INTERVAL_MS) continue;
      this.claudeOAuthLastPollMs.set(profile.id, nowMs);
      const credentials = readClaudeCredentials(profile.configDir ?? "~/.claude", profile.keychainService);
      if (!credentials.accessToken) {
        this.collection.recordAttempt(
          "claude",
          profile.id,
          CLAUDE_OAUTH_SOURCE,
          Date.now(),
          credentials.error,
          credentials.errorCategory,
        );
        continue;
      }
      try {
        const payload = await fetchClaudeUsage(credentials.accessToken, fetchImpl);
        const observations = mapClaudeUsage(payload, profile.id, Date.now());
        if (!observations.length) {
          throw new ClaudeUsageError("usage response contained no rate windows", "no-windows");
        }
        this.collection.recordAttempt("claude", profile.id, CLAUDE_OAUTH_SOURCE, Date.now(), null, null);
        if (this.closing) continue;
        const result = this.db.ingestFullSnapshot("claude", profile.id, observations, this.config);
        emitted.push(...result.events);
        if (result.accepted) {
          const observedAtMs = Math.max(...observations.map((item) => item.observedAtMs));
          for (const previous of result.retired) {
            const value: QuotaEvent = {
              provider: previous.provider,
              account: previous.account,
              bucket: previous.bucket,
              kind: "bucket_retired",
              severity: "info",
              occurredAtMs: observedAtMs,
              confidence: "high",
              displayText: t("event.bucket_retired", { label: previous.label }, this.locale),
              details: { label: previous.label, lastObservedAtMs: previous.observedAtMs, fullReadsMissed: 2 },
            };
            if (this.db.insertEvent(value)) emitted.push(value);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = error instanceof ClaudeUsageError ? error.category : "provider-error";
        this.collection.recordAttempt(
          "claude",
          profile.id,
          CLAUDE_OAUTH_SOURCE,
          Date.now(),
          message,
          category,
        );
        console.error(`[quotapie] Claude OAuth poll failed (${profile.id}): ${message}`);
      }
    }
    return emitted;
  }

  private createCodexClient(profile: CodexAccountConfig): CodexAppServerClient {
    const client = new CodexAppServerClient(
      this.config.collection.codexCommand,
      profile.id,
      12_000,
      profile.codexHome ? resolveUserPath(profile.codexHome) : null,
    );
    client.onUpdate((observations) => {
      if (this.closing) return;
      this.codexPollState.set(profile.id, { count: observations.length, error: null });
      this.ingestCodexSnapshot(observations);
    });
    return client;
  }

  codexPollResults(): Array<{ account: string; count: number; error: string | null }> {
    return this.config.accounts.codex
      .filter((profile) => profile.enabled)
      .map((profile) => ({ account: profile.id, ...(this.codexPollState.get(profile.id) ?? { count: 0, error: null }) }));
  }

  analyses(nowMs = Date.now(), provider?: Provider): WindowAnalysis[] {
    const sinceMs = analysisHistoryStart(this.config, nowMs);
    const recentRawSinceMs = nowMs - this.config.profile.recentLookbackMinutes * 60_000;
    return this.db.latestAll().filter((latest) => (
      (provider == null || latest.provider === provider) &&
      this.isEnabledAccount(latest.provider, latest.account)
    )).map((latest) => {
      const history = this.db.analysisHistory(
        latest.provider,
        latest.account,
        latest.bucket,
        sinceMs,
        recentRawSinceMs,
      );
      return analyzeWindow(latest, history, this.config, nowMs);
    });
  }

  statuses(nowMs = Date.now()): ProviderStatus[] {
    return groupStatuses(
      this.analyses(nowMs),
      (provider, account) => this.accountLabel(provider, account),
    ).sort((left, right) => {
      const providerDifference = (left.provider === "codex" ? 0 : 1) - (right.provider === "codex" ? 0 : 1);
      if (providerDifference !== 0) return providerDifference;
      return this.accountOrder(left.provider, left.account) - this.accountOrder(right.provider, right.account);
    });
  }

  // Returns every enabled configured account whether or not it has
  // snapshots. Rather than a Claude account vanishing from the list, why it
  // is empty should be visible as state.
  accountStates(nowMs = Date.now(), analysed?: WindowAnalysis[]): AccountState[] {
    const windows = analysed ?? this.analyses(nowMs);
    const sourceStates = this.collection.sourceStates();
    const staleAfterMs = this.config.collection.staleAfterSeconds * 1_000;
    const profiles: Array<{ provider: Provider; id: string; label: string; enabled: boolean }> = [
      ...this.config.accounts.codex.map((profile) => ({
        provider: "codex" as const,
        id: profile.id,
        label: profile.label,
        enabled: profile.enabled,
      })),
      ...this.config.accounts.claude.map((profile) => ({
        provider: "claude" as const,
        id: profile.id,
        label: profile.label,
        enabled: profile.enabled,
      })),
    ];
    return profiles.filter((profile) => profile.enabled).map((profile) => {
      const accountWindows = windows
        .filter((window) => window.provider === profile.provider && window.account === profile.id)
        .sort((left, right) => (left.windowSeconds ?? 0) - (right.windowSeconds ?? 0));
      const rows = sourceStates.filter((row) =>
        row.provider === profile.provider && row.account === profile.id
      );
      const sources: CollectionSourceState[] = rows.map((row) => ({
        source: row.source,
        health: collectionHealth(row, nowMs, staleAfterMs),
        lastAttemptAtMs: row.lastAttemptMs,
        lastSuccessAtMs: row.lastSuccessMs,
        errorCategory: row.lastErrorCategory,
        errorDetail: row.lastError,
      })).sort((left, right) => {
        const health = HEALTH_RANK[right.health] - HEALTH_RANK[left.health];
        if (health !== 0) return health;
        const authority = (SOURCE_AUTHORITY[right.source] ?? 0) - (SOURCE_AUTHORITY[left.source] ?? 0);
        if (authority !== 0) return authority;
        return (right.lastSuccessAtMs ?? 0) - (left.lastSuccessAtMs ?? 0);
      });
      // Account health follows the best of its sources. The point of the rule
      // is that an OAuth failure cannot overwrite a status-line collection
      // that just succeeded.
      const best = sources[0] ?? null;
      const failing = sources.find((source) => source.errorCategory != null) ?? null;
      // OAuth off with no fallback samples is not broken, it is unconfigured.
      // The user has to be pointed at one of the two routes, so it gets its
      // own category.
      const optedOut = profile.provider === "claude" &&
        !this.config.collection.claudeOAuthEnabled &&
        best == null;
      const bottleneck = [...accountWindows].sort((left, right) =>
        right.bottleneckScore - left.bottleneckScore
      )[0];
      return {
        provider: profile.provider,
        account: profile.id,
        accountLabel: profile.label,
        enabled: profile.enabled,
        collection: {
          health: best?.health ?? "never-attempted",
          activeSource: best && best.lastSuccessAtMs != null ? best.source : null,
          lastSuccessAtMs: best?.lastSuccessAtMs ?? null,
          // For a healthy account, a past error on the fallback source is not
          // worth surfacing.
          errorCategory: best?.health === "recent-success"
            ? null
            : optedOut
              ? "not-configured"
              : failing?.errorCategory ?? null,
          errorDetail: best?.health === "recent-success"
            ? null
            : optedOut
              ? "set collection.claudeOAuthEnabled = true, or configure the Claude status line"
              : failing?.errorDetail ?? null,
          sources,
        },
        windows: accountWindows,
        bottleneckBucket: bottleneck?.bucket ?? null,
        updatedAtMs: accountWindows.length
          ? Math.max(...accountWindows.map((window) => window.observedAtMs))
          : null,
      };
    });
  }

  headline(nowMs = Date.now()): Headline {
    return buildHeadline(this.accountStates(nowMs), nowMs, this.locale);
  }

  private accountLabel(provider: Provider, account: string): string {
    const profiles = provider === "codex" ? this.config.accounts.codex : this.config.accounts.claude;
    return profiles.find((profile) => profile.id === account)?.label ?? account;
  }

  private accountOrder(provider: Provider, account: string): number {
    const profiles = provider === "codex" ? this.config.accounts.codex : this.config.accounts.claude;
    const index = profiles.findIndex((profile) => profile.id === account);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }

  private isEnabledAccount(provider: Provider, account: string): boolean {
    const profiles = provider === "codex" ? this.config.accounts.codex : this.config.accounts.claude;
    return profiles.some((profile) => profile.id === account && profile.enabled);
  }

  recentEvents(limit = 50): QuotaEvent[] {
    return this.db.recentEvents(limit);
  }

  private rearmRecovered(windows: WindowAnalysis[]): void {
    for (const window of windows) {
      if (window.freshness === "fresh") {
        const staleKey = `${alertScope(window.provider, window.account, window.bucket)}:stale`;
        const staleState = this.alerts.state(staleKey);
        if (staleState) {
          this.alerts.setState(staleKey, staleState.lastFiredAtMs, true);
        }
      }
      if (window.remainingPercent != null) {
        for (const threshold of this.config.alerts.remainingThresholds) {
          const key = `${alertScope(window.provider, window.account, window.bucket)}:remaining:${threshold}`;
          const state = this.alerts.state(key);
          if (state && window.remainingPercent > threshold + 5) {
            this.alerts.setState(key, state.lastFiredAtMs, true);
          }
        }
      }
      const paceKey = `${alertScope(window.provider, window.account, window.bucket)}:pace`;
      const paceState = this.alerts.state(paceKey);
      if (paceState && (window.paceRatio == null || window.paceRatio < 0.9)) {
        this.alerts.setState(paceKey, paceState.lastFiredAtMs, true);
      }
    }
  }

  async evaluateTriggers(nowMs = Date.now(), analysed?: WindowAnalysis[]): Promise<TriggerDecision[]> {
    if (!this.config.alerts.enabled) return [];
    const windows = analysed ?? this.analyses(nowMs);
    this.rearmRecovered(windows);
    const decisions = planTriggers(
      windows,
      this.alerts.pendingEvents().filter((event) => this.isEnabledAccount(event.provider, event.account)),
      this.config,
      0,
      nowMs,
    );
    const delivered: TriggerDecision[] = [];
    const cooldownMs = this.config.alerts.cooldownMinutes * 60_000;
    for (const decision of decisions) {
      const claimAtMs = Date.now();
      const eventClaimToken = decision.eventId != null
        ? this.alerts.claimEvent(decision.eventId, decision.key, claimAtMs, cooldownMs)
        : null;
      const thresholdClaim = decision.eventId == null
        ? this.alerts.claim(decision.key, claimAtMs, cooldownMs)
        : null;
      const claimToken = eventClaimToken ?? thresholdClaim?.token ?? null;
      if (claimToken == null) continue;
      const deliveryKey = decision.eventId != null
        ? `event:${decision.eventId}`
        : `threshold:${decision.key}:${thresholdClaim!.generation}`;
      let deliveryComplete = false;
      try {
        const result = await deliverTrigger(
          decision,
          this.config,
          this.alerts.deliveredChannels(deliveryKey),
          deliveryKey,
          (channel) => this.alerts.markChannelDelivered(deliveryKey, channel, Date.now()),
        );
        deliveryComplete = result.complete;
      } catch (error) {
        console.error(`[quotapie] Trigger delivery error: ${String(error)}`);
      }
      if (deliveryComplete) {
        const completedAtMs = Date.now();
        const completed = decision.eventId != null
          ? this.alerts.completeEvent(decision.eventId, decision.key, claimToken, completedAtMs)
          : this.alerts.completeClaim(decision.key, claimToken, completedAtMs);
        if (completed) delivered.push(decision);
        else console.error(`[quotapie] Trigger claim expired before completion: ${decision.key}`);
      } else {
        if (decision.eventId != null) {
          this.alerts.releaseEvent(decision.eventId, decision.key, claimToken);
        } else {
          this.alerts.releaseClaim(decision.key, claimToken);
        }
        console.error(`[quotapie] Trigger delivery failed: ${decision.key}`);
      }
    }
    return delivered;
  }

  async tick(nowMs = Date.now()): Promise<{
    events: QuotaEvent[];
    triggers: TriggerDecision[];
    windows: WindowAnalysis[];
    collected: boolean;
  }> {
    let events: QuotaEvent[] = [];
    try {
      events = await this.pollCodex();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[quotapie] Codex refresh failed: ${message}`);
    }
    events = events.concat(await this.pollClaudeOAuth(nowMs));
    const collected = this.anyProviderCollectedRecently(nowMs);
    this.db.maybePrune(nowMs, this.config.profile.historyDays);
    // One analysis pass per tick. It feeds the triggers, the boundary file, and
    // the wake schedule, all of which used to recompute it independently.
    const windows = this.analyses(nowMs);
    const triggers = await this.evaluateTriggers(nowMs, windows);
    await this.publishBoundary(nowMs, windows);
    return { events, triggers, windows, collected };
  }

  /// Whether any source produced a sample recently enough for this tick to
  /// count as having reached a provider. Judged from the same heartbeat every
  /// other surface reads, rather than from whether a poll call happened to
  /// return without throwing.
  private anyProviderCollectedRecently(nowMs: number): boolean {
    const staleAfterMs = this.config.collection.staleAfterSeconds * 1_000;
    return this.collection.sourceStates().some((row) =>
      row.lastSuccessMs != null && nowMs - row.lastSuccessMs <= staleAfterMs
    );
  }

  async publishBoundary(nowMs = Date.now(), analysed?: WindowAnalysis[]): Promise<void> {
    try {
      const accounts = this.accountStates(nowMs, analysed);
      const document = buildQuotaBoundary(
        accounts,
        buildHeadline(accounts, nowMs, this.locale),
        nowMs,
        await cachedLeaderboard(nowMs),
      );
      writeQuotaBoundary(document);
    } catch (error) {
      // A failed boundary write must not kill the collection and alert tick
      // that is this loop's actual job.
      console.error(`[quotapie] quota.json publish failed: ${String(error)}`);
    }
  }

  /// A failing provider must not turn this into a busy loop.
  ///
  /// The wake schedule is computed from the windows this tick already analysed
  /// rather than by analysing everything a second time, and a tick that reached
  /// no provider at all backs off instead of retrying a second later. Without
  /// the backoff, an account whose credentials have gone stale spins this loop
  /// once a second, and each pass rescans the whole snapshot history — enough
  /// to starve the HTTP server that the menu bar app depends on.
  static readonly FAILURE_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

  async watch(): Promise<void> {
    this.stopped = false;
    let consecutiveFailures = 0;
    while (!this.stopped) {
      const { collected, windows } = await this.tick();
      consecutiveFailures = collected ? 0 : consecutiveFailures + 1;
      if (this.stopped) break;
      const scheduled = nextWakeDelayMs(windows, this.config);
      const delay = consecutiveFailures > 0
        ? Math.max(
          scheduled,
          QuotaPieService.FAILURE_BACKOFF_MS[
            Math.min(consecutiveFailures - 1, QuotaPieService.FAILURE_BACKOFF_MS.length - 1)
          ]!,
        )
        : scheduled;
      await Bun.sleep(delay);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async close(): Promise<void> {
    this.stop();
    this.closing = true;
    await Promise.all([...this.codexClients.values()].map((client) => client.close().catch(() => undefined)));
    this.codexClients.clear();
    this.db.close();
  }
}
