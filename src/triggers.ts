import type { AppConfig } from "./config";
import { humanGap, resolveLocale, t } from "./i18n";
import type {
  QuotaEvent,
  TriggerDecision,
  WindowAnalysis,
} from "./types";
import { isAlertableEventKind } from "./types";

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
  const say = (key: string, params: Parameters<typeof t>[1] = {}) => t(key, params, locale);

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
      decisions.push({
        key: `${windowKey}:stale`,
        title: say("alert.stale.title", who),
        message: say("alert.stale.message", who),
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
          title: say("alert.remaining.title", who),
          message: say("alert.remaining.message", {
            ...who,
            percent: Number(window.remainingPercent.toFixed(1)),
            threshold: crossed,
          }),
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
      decisions.push({
        key: `${windowKey}:pace`,
        title: say(measuredOverPace ? "alert.pace.title.measured" : "alert.pace.title.projected", who),
        message: say(measuredOverPace ? "alert.pace.message.measured" : "alert.pace.message.projected", {
          ...who,
          detail: humanGap(window.minutesBeforeReset, locale),
        }),
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
    decisions.push({
      key,
      eventId: event.id,
      title: t(
        event.kind === "paid_usage" || event.kind === "credit_topup"
          ? "alert.event.title.payment"
          : event.kind === "window_changed"
            ? "alert.event.title.window"
            : "alert.event.title.resync",
        { provider: event.provider, account: event.account },
        locale,
      ),
      // The stored summary was rendered in this process's locale when the event
      // was recorded, so it needs no re-rendering here. A consumer that wants a
      // different language has the kind and details to render from instead.
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
