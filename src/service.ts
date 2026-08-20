import { analyzeWindow, analysisHistoryStart, buildHeadline, groupStatuses } from "./analytics";
import { buildQuotaBoundary, collectionHealth, writeQuotaBoundary } from "./boundary";
import type { AppConfig, CodexAccountConfig } from "./config";
import { codexUsesFileCredentials, resolveUserPath } from "./config";
import { QuotaDatabase } from "./db";
import { CodexAppServerClient } from "./providers/codex-appserver";
import { ClaudeUsageError, fetchClaudeUsage, mapClaudeUsage, readClaudeCredentials } from "./providers/claude-oauth";
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

export class QuotaPieService {
  readonly db: QuotaDatabase;
  private codexClients = new Map<string, CodexAppServerClient>();
  private stopped = false;
  private closing = false;
  private codexPollState = new Map<string, { count: number; error: string | null }>();
  private claudeOAuthLastPollMs = new Map<string, number>();
  // 공식 usage 엔드포인트는 공급자 측 레이트리밋이 있어 Codex보다 느슨하게 돈다.
  static readonly CLAUDE_OAUTH_MIN_INTERVAL_MS = 5 * 60_000;

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

  ingestClaudeSessions(observations: QuotaObservation[], nowMs = Date.now()): QuotaEvent[] {
    const consensus = this.db.upsertClaudeSessions(
      observations,
      this.config.collection.claudeSessionTtlSeconds * 1_000,
    );
    const accepted: QuotaObservation[] = [];
    for (const observation of consensus) {
      this.db.recordCollectionAttempt(
        "claude",
        observation.account,
        CLAUDE_STATUSLINE_SOURCE,
        observation.observedAtMs,
        null,
        null,
      );
      // 상태줄은 폴백이다. OAuth가 최근에 성공한 계정에서는 값을 이력에 넣지 않아
      // 두 소스가 번갈아 들어오며 소스 변경·계량 보정 잡음을 만드는 일을 막는다.
      if (!this.oauthIsAuthoritative(observation.account, nowMs)) accepted.push(observation);
    }
    return this.ingest(accepted);
  }

  private oauthIsAuthoritative(account: string, nowMs: number): boolean {
    const state = this.db
      .collectionSourceStates()
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
        this.db.recordCollectionAttempt(
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
        this.codexPollState.set(profile.id, { count: observations.length, error: null });
        this.db.recordCollectionAttempt("codex", profile.id, CODEX_SOURCE, Date.now(), null, null);
        return {
          ok: true as const,
          events: this.closing ? [] : this.ingestCodexSnapshot(observations),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.codexPollState.set(profile.id, { count: 0, error: message });
        this.db.recordCollectionAttempt("codex", profile.id, CODEX_SOURCE, Date.now(), message, "provider-error");
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

  // force는 doctor 전용이다. 진단은 다음 폴링 주기를 기다리지 않고 지금 상태를 봐야 한다.
  // fetchImpl은 테스트에서 공급자 실패를 재현하기 위한 이음매다.
  async pollClaudeOAuth(
    nowMs = Date.now(),
    force = false,
    fetchImpl: typeof fetch = fetch,
  ): Promise<QuotaEvent[]> {
    const emitted: QuotaEvent[] = [];
    for (const profile of this.config.accounts.claude.filter((item) => item.enabled)) {
      const lastPollMs = this.claudeOAuthLastPollMs.get(profile.id) ?? 0;
      if (!force && nowMs - lastPollMs < QuotaPieService.CLAUDE_OAUTH_MIN_INTERVAL_MS) continue;
      this.claudeOAuthLastPollMs.set(profile.id, nowMs);
      const credentials = readClaudeCredentials(profile.configDir ?? "~/.claude", profile.keychainService);
      if (!credentials.accessToken) {
        this.db.recordCollectionAttempt(
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
        this.db.recordCollectionAttempt("claude", profile.id, CLAUDE_OAUTH_SOURCE, Date.now(), null, null);
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
              summary: `${previous.label} 항목이 공급자 전체 응답에서 사라져 추적을 종료했습니다.`,
              details: { lastObservedAtMs: previous.observedAtMs, fullReadsMissed: 2 },
            };
            if (this.db.insertEvent(value)) emitted.push(value);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = error instanceof ClaudeUsageError ? error.category : "provider-error";
        this.db.recordCollectionAttempt(
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

  // 스냅샷 유무와 무관하게 "설정된 활성 계정" 전체를 돌려준다. Claude 계정이
  // 목록에서 통째로 사라지는 대신, 왜 비어 있는지가 상태로 드러나야 한다.
  accountStates(nowMs = Date.now()): AccountState[] {
    const windows = this.analyses(nowMs);
    const sourceStates = this.db.collectionSourceStates();
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
      })).sort((left, right) => HEALTH_RANK[right.health] - HEALTH_RANK[left.health]);
      // 계정 건강도는 소스 중 가장 좋은 상태를 따른다. OAuth 실패가 최근 성공한
      // 상태줄 수집을 덮어쓰지 않도록 하는 것이 이 규칙의 목적이다.
      const best = sources[0] ?? null;
      const failing = sources.find((source) => source.errorCategory != null) ?? null;
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
          // 정상 동작 중인 계정에서는 폴백 소스의 과거 오류를 표면화하지 않는다.
          errorCategory: best?.health === "recent-success" ? null : failing?.errorCategory ?? null,
          errorDetail: best?.health === "recent-success" ? null : failing?.errorDetail ?? null,
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
    return buildHeadline(this.accountStates(nowMs), nowMs);
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
        console.error(`[quotapie] Trigger delivery error: ${String(error)}`);
      }
      if (deliveryComplete) {
        const completedAtMs = Date.now();
        const completed = decision.eventId != null
          ? this.db.completeEventAlert(decision.eventId, decision.key, claimToken, completedAtMs)
          : this.db.completeAlertClaim(decision.key, claimToken, completedAtMs);
        if (completed) delivered.push(decision);
        else console.error(`[quotapie] Trigger claim expired before completion: ${decision.key}`);
      } else {
        if (decision.eventId != null) {
          this.db.releaseEventAlert(decision.eventId, decision.key, claimToken);
        } else {
          this.db.releaseAlertClaim(decision.key, claimToken);
        }
        console.error(`[quotapie] Trigger delivery failed: ${decision.key}`);
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
      console.error(`[quotapie] Codex refresh failed: ${message}`);
    }
    events = events.concat(await this.pollClaudeOAuth(nowMs));
    this.db.maybePrune(nowMs, this.config.profile.historyDays);
    const triggers = await this.evaluateTriggers(nowMs);
    this.publishBoundary(nowMs);
    return { events, triggers };
  }

  publishBoundary(nowMs = Date.now()): void {
    try {
      const accounts = this.accountStates(nowMs);
      const document = buildQuotaBoundary(accounts, buildHeadline(accounts, nowMs), nowMs);
      writeQuotaBoundary(document);
    } catch (error) {
      // 경계면 쓰기 실패가 수집·알림 본연의 tick을 죽여서는 안 된다.
      console.error(`[quotapie] quota.json publish failed: ${String(error)}`);
    }
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
