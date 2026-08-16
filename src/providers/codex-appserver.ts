import type { QuotaObservation } from "../types";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function epochToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1_000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function labelFor(limitName: string | null, durationMinutes: number | null, lane: string): string {
  const base = limitName && limitName !== "codex" ? limitName : "Codex";
  if (durationMinutes === 300) return `${base} 5h`;
  if (durationMinutes === 10_080) return `${base} weekly`;
  if (durationMinutes != null) return `${base} ${durationMinutes}m`;
  return `${base} ${lane}`;
}

export function parseCodexRateLimits(
  payload: unknown,
  observedAtMs = Date.now(),
  account = "default",
): QuotaObservation[] {
  if (!payload || typeof payload !== "object") return [];
  const result = payload as Record<string, unknown>;
  const multi = result.rateLimitsByLimitId;
  const entries: Array<[string, Record<string, unknown>]> = [];

  if (multi && typeof multi === "object") {
    for (const [key, value] of Object.entries(multi as Record<string, unknown>)) {
      if (value && typeof value === "object") entries.push([key, value as Record<string, unknown>]);
    }
  } else if (result.rateLimits && typeof result.rateLimits === "object") {
    const single = result.rateLimits as Record<string, unknown>;
    entries.push([String(single.limitId ?? "codex"), single]);
  }

  const resetCreditBlock = result.rateLimitResetCredits;
  const resetCreditsAvailable = resetCreditBlock && typeof resetCreditBlock === "object"
    ? numberOrNull((resetCreditBlock as Record<string, unknown>).availableCount)
    : null;
  const topLevelCreditBlock = result.credits;
  const topLevelCreditBalance = topLevelCreditBlock && typeof topLevelCreditBlock === "object"
    ? numberOrNull(
        (topLevelCreditBlock as Record<string, unknown>).balance ??
          (topLevelCreditBlock as Record<string, unknown>).remaining,
      )
    : null;

  const observations: QuotaObservation[] = [];
  for (const [fallbackLimitId, value] of entries) {
    const entryStart = observations.length;
    const limitId = String(value.limitId ?? fallbackLimitId);
    const limitName = typeof value.limitName === "string" ? value.limitName : null;
    for (const lane of ["primary", "secondary"] as const) {
      const rawWindow = value[lane];
      if (!rawWindow || typeof rawWindow !== "object") continue;
      const window = rawWindow as Record<string, unknown>;
      const durationMinutes = numberOrNull(window.windowDurationMins);
      const usedPercent = numberOrNull(window.usedPercent);
      const resetsAtMs = epochToMs(window.resetsAt);
      observations.push({
        provider: "codex",
        account,
        bucket: `${limitId}:${lane}:${durationMinutes ?? "unknown"}`,
        label: labelFor(limitName, durationMinutes, lane),
        windowSeconds: durationMinutes == null ? null : durationMinutes * 60,
        usedPercent,
        resetsAtMs,
        observedAtMs,
        source: "codex-app-server",
        quality: "authoritative",
        metadata: {
          limitId,
          lane,
          rateLimitReachedType:
            typeof value.rateLimitReachedType === "string" ? value.rateLimitReachedType : null,
        },
      });
    }
    const entryCreditBlock = value.credits;
    const entryCreditBalance = entryCreditBlock && typeof entryCreditBlock === "object"
      ? numberOrNull(
          (entryCreditBlock as Record<string, unknown>).balance ??
            (entryCreditBlock as Record<string, unknown>).remaining,
        )
      : null;
    if (entryCreditBalance != null) {
      const target = observations
        .slice(entryStart)
        .find((observation) => observation.metadata?.lane === "primary") ?? observations[entryStart];
      if (target) target.creditBalance = entryCreditBalance;
    }
  }

  const canonical = observations.find(
    (observation) => observation.metadata?.limitId === "codex" && observation.metadata?.lane === "primary",
  ) ?? observations[0];
  if (canonical) {
    if (canonical.creditBalance == null) canonical.creditBalance = topLevelCreditBalance;
    canonical.resetCreditsAvailable = resetCreditsAvailable;
  }
  return observations;
}

export class CodexAppServerClient {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();
  private pumpTask: Promise<void> | null = null;
  private notificationHandler: ((observations: QuotaObservation[]) => void | Promise<void>) | null = null;
  private notificationRefreshScheduled = false;
  private notificationRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(
    private readonly command = "codex",
    private readonly account = "default",
    private readonly timeoutMs = 12_000,
    private readonly codexHome: string | null = null,
  ) {}

  onUpdate(handler: (observations: QuotaObservation[]) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.closing) throw new Error("Codex App Server client is closing");
    if (this.process) return;
    this.process = Bun.spawn(
      [this.command, "-s", "read-only", "-a", "untrusted", "app-server", "--stdio"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
        },
      },
    );
    this.pumpTask = this.pump();
    await this.request("initialize", {
      clientInfo: { name: "timequota", title: "TimeQuota", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "thread/started",
          "item/agentMessage/delta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.write({ method: "initialized", params: {} });
  }

  async readRateLimits(): Promise<QuotaObservation[]> {
    await this.connect();
    const result = await this.request("account/rateLimits/read");
    return parseCodexRateLimits(result, Date.now(), this.account);
  }

  private write(message: RpcMessage): void {
    const stdin = this.process?.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("Codex App Server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ method, id, ...(params === undefined ? {} : { params }) });
    });
  }

  private async pump(): Promise<void> {
    const process = this.process;
    const stdout = process?.stdout;
    if (!stdout || typeof stdout === "number") throw new Error("Codex App Server stdout is unavailable");
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) await this.handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      if (this.process === process) this.process = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Codex App Server stopped"));
      }
      this.pending.clear();
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex App Server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "account/rateLimits/updated" && this.notificationHandler) {
      this.scheduleNotificationRefresh();
    }
  }

  private scheduleNotificationRefresh(): void {
    if (this.notificationRefreshScheduled || this.closing) return;
    this.notificationRefreshScheduled = true;
    this.notificationRefreshTimer = setTimeout(() => {
      this.notificationRefreshTimer = null;
      this.notificationRefreshScheduled = false;
      if (this.closing) return;
      void this.readRateLimits()
        .then((observations) => this.notificationHandler?.(observations))
        .catch((error) => console.error(`[timequota] Codex update refresh failed: ${String(error)}`));
    }, 100);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.notificationRefreshTimer) clearTimeout(this.notificationRefreshTimer);
    this.notificationRefreshTimer = null;
    this.notificationRefreshScheduled = false;
    const process = this.process;
    this.process = null;
    if (!process) return;
    try {
      const stdin = process.stdin;
      if (stdin && typeof stdin !== "number") stdin.end();
      process.kill();
      await Promise.race([process.exited, Bun.sleep(1_000)]);
    } finally {
      await this.pumpTask?.catch(() => undefined);
      this.pumpTask = null;
    }
  }
}
