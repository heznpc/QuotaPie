import { analyzeWindow, analysisHistoryStart, groupStatuses } from "./analytics";
import type { AppConfig, CodexAccountConfig } from "./config";
import { codexUsesFileCredentials, resolveUserPath } from "./config";
import { QuotaDatabase } from "./db";
import { CodexAppServerClient } from "./providers/codex-appserver";
import { nextWakeDelayMs } from "./scheduler";
import { alertScope, deliverTrigger, planTriggers } from "./triggers";
import type { Provider, ProviderStatus, QuotaEvent, QuotaObservation, TriggerDecision, WindowAnalysis } from "./types";

export class TimeQuotaService {
  readonly db: QuotaDatabase;
  private codexClients = new Map<string, CodexAppServerClient>();
  private stopped = false;
  private closing = false;
  private codexPollState = new Map<string, { count: number; error: string | null }>();

  constructor(
    readonly config: AppConfig,
    database?: QuotaDatabase,
  ) {
    this.db = database ?? new QuotaDatabase();
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
      const result = this.db.ingestFullSnapshot(
        "codex",
        account,
        accountObservations,
        this.config,
      );
      emitted.push(...result.events);
      if (!result.accepted) continue;
      for (const previous of result.retired) {
        const value: QuotaEvent = {
          provider: previous.provider,
          account: previous.account,
          bucket: previous.bucket,
          kind: "bucket_retired",
          severity: "info",
          occurredAtMs: observedAtMs,
          confidence: "high",
          summary: `${previous.label} 항목이 공급자 전체 응답에서 사라져 추적을 종료했습니다.`,
          details: { lastObservedAtMs: previous.observedAtMs, fullReadsMissed: 2 },
        };
        if (this.db.insertEvent(value)) emitted.push(value);
      }
    }
    return emitted;
  }

  ingestClaudeSessions(observations: QuotaObservation[]): QuotaEvent[] {
    const consensus = this.db.upsertClaudeSessions(
      observations,
      this.config.collection.claudeSessionTtlSeconds * 1_000,
    );
    return this.ingest(consensus);
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
        console.error(`[timequota] Codex account ${profile.id} skipped: ${message}`);
        return { ok: false as const, events: [] as QuotaEvent[], message };
      }
      let client = this.codexClients.get(profile.id);
      if (!client) {
        client = this.createCodexClient(profile);
        this.codexClients.set(profile.id, client);
      }
      try {
        const observations = await client.readRateLimits();
        this.codexPollState.set(profile.id, { count: observations.length, error: null });
        return {
          ok: true as const,
          events: this.closing ? [] : this.ingestCodexSnapshot(observations),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.codexPollState.set(profile.id, { count: 0, error: message });
        await client.close().catch(() => undefined);
        this.codexClients.delete(profile.id);
        console.error(`[timequota] Codex account ${profile.id} refresh failed: ${message}`);
        return { ok: false as const, events: [] as QuotaEvent[], message };
      }
    }));
    if (!outcomes.some((outcome) => outcome.ok)) {
      throw new Error(`all configured Codex accounts failed (${profiles.map((profile) => profile.id).join(", ")})`);
    }
    return outcomes.flatMap((outcome) => outcome.events);
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
        const staleState = this.db.alertState(staleKey);
        if (staleState) {
          this.db.setAlertState(staleKey, staleState.lastFiredAtMs, true);
        }
      }
      if (window.remainingPercent != null) {
        for (const threshold of this.config.alerts.remainingThresholds) {
          const key = `${alertScope(window.provider, window.account, window.bucket)}:remaining:${threshold}`;
          const state = this.db.alertState(key);
          if (state && window.remainingPercent > threshold + 5) {
            this.db.setAlertState(key, state.lastFiredAtMs, true);
          }
        }
      }
      const paceKey = `${alertScope(window.provider, window.account, window.bucket)}:pace`;
      const paceState = this.db.alertState(paceKey);
      if (paceState && (window.paceRatio == null || window.paceRatio < 0.9)) {
        this.db.setAlertState(paceKey, paceState.lastFiredAtMs, true);
      }
    }
  }

  async evaluateTriggers(nowMs = Date.now()): Promise<TriggerDecision[]> {
    if (!this.config.alerts.enabled) return [];
    const windows = this.analyses(nowMs);
    this.rearmRecovered(windows);
    const decisions = planTriggers(
      windows,
      this.db.pendingAlertEvents().filter((event) => this.isEnabledAccount(event.provider, event.account)),
      this.config,
      0,
      nowMs,
    );
    const delivered: TriggerDecision[] = [];
    const cooldownMs = this.config.alerts.cooldownMinutes * 60_000;
    for (const decision of decisions) {
      const claimAtMs = Date.now();
      const eventClaimToken = decision.eventId != null
        ? this.db.claimEventAlert(decision.eventId, decision.key, claimAtMs, cooldownMs)
        : null;
      const thresholdClaim = decision.eventId == null
        ? this.db.claimAlert(decision.key, claimAtMs, cooldownMs)
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
          this.db.deliveredChannels(deliveryKey),
          deliveryKey,
          (channel) => this.db.markChannelDelivered(deliveryKey, channel, Date.now()),
        );
        deliveryComplete = result.complete;
      } catch (error) {
        console.error(`[timequota] Trigger delivery error: ${String(error)}`);
      }
      if (deliveryComplete) {
        const completedAtMs = Date.now();
        const completed = decision.eventId != null
          ? this.db.completeEventAlert(decision.eventId, decision.key, claimToken, completedAtMs)
          : this.db.completeAlertClaim(decision.key, claimToken, completedAtMs);
        if (completed) delivered.push(decision);
        else console.error(`[timequota] Trigger claim expired before completion: ${decision.key}`);
      } else {
        if (decision.eventId != null) {
          this.db.releaseEventAlert(decision.eventId, decision.key, claimToken);
        } else {
          this.db.releaseAlertClaim(decision.key, claimToken);
        }
        console.error(`[timequota] Trigger delivery failed: ${decision.key}`);
      }
    }
    return delivered;
  }

  async tick(nowMs = Date.now()): Promise<{ events: QuotaEvent[]; triggers: TriggerDecision[] }> {
    let events: QuotaEvent[] = [];
    try {
      events = await this.pollCodex();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[timequota] Codex refresh failed: ${message}`);
    }
    this.db.maybePrune(nowMs, this.config.profile.historyDays);
    const triggers = await this.evaluateTriggers(nowMs);
    return { events, triggers };
  }

  async watch(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      await this.tick();
      if (this.stopped) break;
      const delay = nextWakeDelayMs(this.analyses(), this.config);
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
