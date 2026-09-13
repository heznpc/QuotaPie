import { notificationAllowed } from "./notification-preferences";
import type { AppConfig } from "./config";
import { humanGap, resolveLocale, t } from "./i18n";
import type { MessageKey, MessageParams } from "./i18n";
import type {
  QuotaEvent,
  TriggerDecision,
  WindowAnalysis,
} from "./types";
import { isAlertableEventKind, MACOS_NOTIFICATION_CHANNEL } from "./types";

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
  const locale = resolveLocale(config.profile.locale);
  const present = (
    titleKey: MessageKey,
    titleParams: MessageParams,
    messageKey: MessageKey,
    messageParams: MessageParams,
  ): Pick<TriggerDecision, "title" | "message" | "presentation"> => ({
    title: t(titleKey, titleParams, locale),
    message: t(messageKey, messageParams, locale),
    presentation: {
      title: { key: titleKey, params: titleParams },
      message: { key: messageKey, params: messageParams },
    },
  });

  for (const window of windows) {
    const windowKey = alertScope(window.provider, window.account, window.bucket);
    const who = { provider: window.provider, account: window.account, label: window.label };
    const staleNeedsAlert = config.alerts.staleProviders.includes(window.provider) && (
      window.freshness === "stale" ||
      window.freshness === "unknown" ||
      (window.freshness === "reset_due" &&
        window.resetsAtMs != null &&
        nowMs - window.resetsAtMs > config.collection.staleAfterSeconds * 1_000)
    );
    if (staleNeedsAlert) {
      const wording = present("alert.stale.title", who, "alert.stale.message", who);
      decisions.push({
        key: `${windowKey}:stale`,
        ...wording,
        severity: "warning",
      });
      continue;
    }
    if (window.freshness !== "fresh") continue;

    if ((window.rapidDropPercent ?? 0) >= config.alerts.rapidDropPercent && window.remainingPercent != null) {
      decisions.push({
        key: `${windowKey}:rapid`,
        ...present("alert.rapid.title", who, "alert.rapid.message", {
          ...who, percent: Number(window.remainingPercent.toFixed(1)),
          drop: Number(window.rapidDropPercent!.toFixed(1)),
          minutes: Math.max(1, Math.ceil(window.rapidIntervalMinutes ?? 0)),
        }),
        severity: window.remainingPercent <= 5 ? "critical" : "warning",
      });
    }

    if (window.remainingPercent != null) {
      const crossed = [...config.alerts.remainingThresholds]
        .sort((a, b) => a - b)
        .find((threshold) => window.remainingPercent! <= threshold);
      if (crossed != null) {
        const messageParams = {
          ...who,
          percent: Number(window.remainingPercent.toFixed(1)),
          threshold: crossed,
        };
        const wording = present(
          "alert.remaining.title",
          who,
          "alert.remaining.message",
          messageParams,
        );
        decisions.push({
          key: `${windowKey}:remaining:${crossed}`,
          ...wording,
          severity: crossed <= 5 ? "critical" : "warning",
          rearmWhenRemainingAbove: crossed + 5,
        });
      }
    }

    if (
      config.alerts.paceForecasts &&
      (window.rapidDropPercent ?? 0) < config.alerts.rapidDropPercent &&
      window.minutesBeforeReset != null &&
      window.minutesBeforeReset >= config.alerts.predictedEarlyMinutes &&
      window.paceRatio != null &&
      window.paceRatio > 1 &&
      // Floor on measured burn: with no recent real usage, a habit-based
      // projection alone is not grounds for a warning.
      window.recentBurnPerHour != null &&
      window.recentBurnPerHour > 0
    ) {
      // Present-tense warnings are reserved for a measured burn rate above the
      // safe pace. When only the blended figure (weighted by habit) exceeds it,
      // the wording turns forward-looking, so "running hot now" and "on this
      // pattern" never get conflated.
      const measuredOverPace = window.safePacePerActiveHour != null &&
        window.recentBurnPerHour > window.safePacePerActiveHour;
      const titleKey = measuredOverPace ? "alert.pace.title.measured" : "alert.pace.title.projected";
      const messageKey = measuredOverPace ? "alert.pace.message.measured" : "alert.pace.message.projected";
      const messageParams = {
        ...who,
        // `minutes` is the semantic value used by native clients. `detail` is
        // the daemon-locale compatibility rendering for older consumers.
        minutes: window.minutesBeforeReset,
        detail: humanGap(window.minutesBeforeReset, locale),
      };
      decisions.push({
        key: `${windowKey}:pace`,
        ...present(titleKey, who, messageKey, messageParams),
        severity: window.paceRatio >= 1.5 && measuredOverPace ? "critical" : "warning",
      });
    }
  }

  const plannedEventKeys = new Set<string>();
  for (const event of recentEvents.filter((item) => item.occurredAtMs >= sinceMs)) {
    if (!isAlertableEventKind(event.kind)) continue;
    const key = `event:${alertScope(event.provider, event.account, event.bucket)}:${event.kind}`;
    if (plannedEventKeys.has(key)) continue;
    plannedEventKeys.add(key);
    const titleKey = event.kind === "paid_usage" || event.kind === "credit_topup"
      ? "alert.event.title.payment"
      : event.kind === "account_changed" ? "alert.event.title.account"
      : event.kind === "plan_changed" ? "alert.event.title.plan"
      : event.kind === "window_changed"
        ? "alert.event.title.window"
        : "alert.event.title.resync";
    const identifiesAccount = ["account_changed", "plan_changed", "window_changed"].includes(event.kind);
    const accountLabel = config.accounts[event.provider].find(profile => profile.id === event.account)?.label?.trim() || event.account;
    const titleParams = { provider: event.provider, account: identifiesAccount ? accountLabel : event.account };
    const messageKey = `event.${event.kind}` as MessageKey;
    const messageParams = {
      provider: event.provider,
      account: event.account,
      ...event.details,
    };
    const wording = present(titleKey, titleParams, messageKey, messageParams);
    decisions.push({
      key,
      eventId: event.id,
      ...wording,
      // Keep the stored rendering for shell/command compatibility, including
      // old rows whose details predate the semantic contract. Native clients
      // use `presentation.message` and localise from kind + details instead.
      message: event.displayText,
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
  suppressed?: boolean;
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

export interface TriggerDeliveryOptions {
  alreadyDelivered?: readonly string[];
  deliveryKey?: string;
  onChannelSuccess?: (channel: string) => void | Promise<void>;
  queueMacOSNotification?: (
    decision: TriggerDecision,
    deliveryKey: string,
  ) => unknown | Promise<unknown>;
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

function waitForWork(
  channel: string,
  work: () => unknown | Promise<unknown>,
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
      finish({ channel, ok: false, detail: `timed out after ${Math.round(timeoutMs / 1_000)}s` });
    }, timeoutMs);
    void Promise.resolve()
      .then(work)
      .then(
        () => finish({ channel, ok: true, detail: "queued" }),
        (error) => finish({ channel, ok: false, detail: String(error) }),
      );
  });
}

export async function deliverTrigger(
  decision: TriggerDecision,
  config: AppConfig,
  options: TriggerDeliveryOptions = {},
): Promise<TriggerDeliveryResult> {
  if (!notificationAllowed(decision, config.alerts)) {
    return { complete: true, suppressed: true, configuredChannels: [], succeededChannels: [], failedChannels: [] };
  }
  const configuredChannels: string[] = [];
  const completed = new Set(options.alreadyDelivered ?? []);
  const jobs: Promise<ChannelResult>[] = [];
  const deliveryKey = options.deliveryKey ?? decision.key;
  const timeoutMs = Math.max(1_000, config.alerts.deliveryTimeoutSeconds * 1_000);
  if (config.alerts.macOSNotifications && process.platform === "darwin") {
    const channel = MACOS_NOTIFICATION_CHANNEL;
    configuredChannels.push(channel);
    if (!completed.has(channel)) {
      if (options.queueMacOSNotification) {
        jobs.push(
          waitForWork(
            channel,
            () => options.queueMacOSNotification!(decision, deliveryKey),
            timeoutMs,
          ),
        );
      } else {
        // Compatibility for daemon-only installations. Once a native app has
        // claimed the durable outbox, service code supplies the queue hook and
        // osascript is no longer the notification sender.
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
    if (!result.ok) return result;
    try {
      await options.onChannelSuccess?.(result.channel);
      return result;
    } catch (error) {
      return { ...result, ok: false, detail: `failed to record success: ${String(error)}` };
    }
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
