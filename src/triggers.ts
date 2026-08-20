import type { AppConfig } from "./config";
import type { QuotaEvent, TriggerDecision, WindowAnalysis } from "./types";

export function alertScope(provider: string, account: string, bucket: string): string {
  // Preserve the original single-account keys so an upgrade does not discard
  // existing cooldown/re-arm state and immediately repeat an alert.
  return account === "default"
    ? `${provider}:${bucket}`
    : `${provider}:${account}:${bucket}`;
}

export function planTriggers(
  windows: WindowAnalysis[],
  recentEvents: QuotaEvent[],
  config: AppConfig,
  sinceMs: number,
  nowMs = Date.now(),
): TriggerDecision[] {
  const decisions: TriggerDecision[] = [];

  for (const window of windows) {
    const windowKey = alertScope(window.provider, window.account, window.bucket);
    const accountTitle = `${window.provider}/${window.account}`;
    const staleNeedsAlert = config.alerts.staleProviders.includes(window.provider) && (
      window.freshness === "stale" ||
      window.freshness === "unknown" ||
      (window.freshness === "reset_due" &&
        window.resetsAtMs != null &&
        nowMs - window.resetsAtMs > config.collection.staleAfterSeconds * 1_000)
    );
    if (staleNeedsAlert) {
      decisions.push({
        key: `${windowKey}:stale`,
        title: `${accountTitle} 한도 데이터 확인 필요`,
        message: window.freshness === "reset_due"
          ? `${window.label} 리셋 예정 시각은 지났지만 공급자가 아직 갱신을 확인하지 않았습니다.`
          : `${window.label} 원본 데이터가 ${window.freshness === "stale" ? "오래됐습니다" : "없습니다"}.`,
        severity: "warning",
      });
      continue;
    }
    if (window.freshness !== "fresh") continue;

    if (window.remainingPercent != null) {
      const crossed = [...config.alerts.remainingThresholds]
        .sort((a, b) => a - b)
        .find((threshold) => window.remainingPercent! <= threshold);
      if (crossed != null) {
        decisions.push({
          key: `${windowKey}:remaining:${crossed}`,
          title: `${accountTitle} ${crossed}% 이하`,
          message: `${window.label} 잔여 ${window.remainingPercent.toFixed(1)}% · 안전 여유 ${window.reservePercent}%`,
          severity: crossed <= 5 ? "critical" : "warning",
          rearmWhenRemainingAbove: crossed + 5,
        });
      }
    }

    if (
      window.minutesBeforeReset != null &&
      window.minutesBeforeReset >= config.alerts.predictedEarlyMinutes &&
      window.paceRatio != null &&
      window.paceRatio > 1 &&
      // 실소진 하한: 최근 실사용이 0이면 습관 예측만으로 경고하지 않는다.
      window.recentBurnPerHour != null &&
      window.recentBurnPerHour > 0
    ) {
      // 현재형 경고는 실측 소진율이 안전 페이스를 넘을 때만. 혼합치(습관 가중)가
      // 넘는 경우는 전망형 문구로 구분해 "지금 과열"과 "패턴상 전망"을 섞지 않는다.
      const measuredOverPace = window.safePacePerActiveHour != null &&
        window.recentBurnPerHour > window.safePacePerActiveHour;
      decisions.push({
        key: `${windowKey}:pace`,
        title: measuredOverPace
          ? `${accountTitle} 사용 속도 과열`
          : `${accountTitle} 사용 패턴 전망`,
        message: measuredOverPace
          ? `${window.label} 안전 여유가 리셋보다 약 ${Math.round(window.minutesBeforeReset)}분 먼저 소진될 전망입니다.`
          : `${window.label} 이 패턴이면 안전 여유가 리셋보다 약 ${Math.round(window.minutesBeforeReset)}분 먼저 소진될 전망입니다.`,
        severity: window.paceRatio >= 1.5 && measuredOverPace ? "critical" : "warning",
      });
    }
  }

  const plannedEventKeys = new Set<string>();
  for (const event of recentEvents.filter((item) => item.occurredAtMs >= sinceMs)) {
    if (!["external_relief", "allowance_relief", "schedule_rebased", "paid_usage", "credit_topup"].includes(event.kind)) {
      continue;
    }
    const key = `event:${alertScope(event.provider, event.account, event.bucket)}:${event.kind}`;
    if (plannedEventKeys.has(key)) continue;
    plannedEventKeys.add(key);
    decisions.push({
      key,
      eventId: event.id,
      title: event.kind === "paid_usage" || event.kind === "credit_topup"
        ? `${event.provider}/${event.account} 결제성 사용 변화`
        : `${event.provider}/${event.account} 타이머 재동기화`,
      message: event.summary,
      severity: event.severity,
    });
  }

  return decisions;
}

const APPLE_SCRIPT = `on run argv
  set notificationTitle to item 1 of argv
  set notificationBody to item 2 of argv
  display notification notificationBody with title notificationTitle
end run`;

export interface TriggerDeliveryResult {
  complete: boolean;
  configuredChannels: string[];
  succeededChannels: string[];
  failedChannels: string[];
}

interface ChannelResult {
  channel: string;
  ok: boolean;
  detail: string;
}

function waitForExit(
  channel: string,
  process: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<ChannelResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ChannelResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(9);
      } catch {
        // The process may have exited between the timeout and kill.
      }
      finish({ channel, ok: false, detail: `timed out after ${Math.round(timeoutMs / 1_000)}s` });
    }, timeoutMs);
    void process.exited.then(
      (code) => finish({ channel, ok: code === 0, detail: `exited with code ${code}` }),
      (error) => finish({ channel, ok: false, detail: String(error) }),
    );
  });
}

export async function deliverTrigger(
  decision: TriggerDecision,
  config: AppConfig,
  alreadyDelivered: readonly string[] = [],
  deliveryKey = decision.key,
  onChannelSuccess?: (channel: string) => void | Promise<void>,
): Promise<TriggerDeliveryResult> {
  const configuredChannels: string[] = [];
  const completed = new Set(alreadyDelivered);
  const jobs: Promise<ChannelResult>[] = [];
  const timeoutMs = Math.max(1_000, config.alerts.deliveryTimeoutSeconds * 1_000);
  if (config.alerts.macOSNotifications && process.platform === "darwin") {
    const channel = "macos-notification";
    configuredChannels.push(channel);
    if (!completed.has(channel)) {
      try {
        jobs.push(
          waitForExit(channel, Bun.spawn(["osascript", "-e", APPLE_SCRIPT, "--", decision.title, decision.message], {
            stdout: "ignore",
            stderr: "ignore",
          }), timeoutMs),
        );
      } catch (error) {
        jobs.push(Promise.resolve({ channel, ok: false, detail: `failed to start: ${String(error)}` }));
      }
    }
  }
  if (config.alerts.command?.length) {
    const channel = "command";
    configuredChannels.push(channel);
    if (!completed.has(channel)) {
      try {
        jobs.push(
          waitForExit(channel, Bun.spawn(config.alerts.command, {
            stdout: "ignore",
            stderr: "ignore",
            env: {
              ...process.env,
              QUOTAPIE_EVENT_JSON: JSON.stringify(decision),
              QUOTAPIE_IDEMPOTENCY_KEY: deliveryKey,
            },
          }), timeoutMs),
        );
      } catch (error) {
        jobs.push(Promise.resolve({ channel, ok: false, detail: `failed to start: ${String(error)}` }));
      }
    }
  }
  const results = await Promise.all(jobs.map(async (job) => {
    const result = await job;
    if (result.ok) await onChannelSuccess?.(result.channel);
    return result;
  }));
  const succeededChannels: string[] = [];
  const failedChannels: string[] = [];
  for (const result of results) {
    if (result.ok) {
      succeededChannels.push(result.channel);
    } else {
      failedChannels.push(result.channel);
      console.error(`[quotapie] ${result.channel} ${result.detail}`);
    }
  }
  const complete = configuredChannels.length > 0 &&
    failedChannels.length === 0 &&
    configuredChannels.every((channel) => completed.has(channel) || succeededChannels.includes(channel));
  return { complete, configuredChannels, succeededChannels, failedChannels };
}
