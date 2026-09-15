import type { QuotaObservation } from "../types";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

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

class CodexTransportError extends Error {}

class RpcRequestError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

// Keep the resident client's last trusted context while this reading is retried.
export class CodexSnapshotUnavailableError extends Error {}

export interface CodexThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | null;
  sortDirection?: "asc" | "desc" | null;
  archived?: boolean | null;
  useStateDbOnly?: boolean;
}

export interface CodexThreadSummary {
  id: string;
  cwd: string;
  name: string | null;
}

export interface CodexThreadListPage {
  data: CodexThreadSummary[];
  nextCursor: string | null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function planType(value: unknown): string | null {
  return typeof value === "string" && ["free", "go", "plus", "pro", "prolite", "team", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu"].includes(value)
    ? value : null;
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
  if (durationMinutes === 43_200) return `${base} monthly`;
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
          planType: planType(value.planType),
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
  private connectTask: Promise<void> | null = null;
  private rateLimitsTask: Promise<QuotaObservation[]> | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private requestId = 1;
  private pending = new Map<number, PendingRequest>();
  private pumpTask: Promise<void> | null = null;
  private notificationHandler: ((observations: QuotaObservation[]) => void | Promise<void>) | null = null;
  private notificationRefreshScheduled = false;
  private notificationRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private credentialStamp: string | undefined;
  private collectorEpoch = randomUUID();
  private remoteAccount: string | undefined;
  private remotePlan: string | null = null;
  private accountContext = randomUUID();
  private readonly contextSession = randomUUID();

  private currentCredentialStamp(): string {
    try {
      const stat = statSync(resolve(this.codexHome ?? process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "auth.json"));
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch { return "absent"; }
  }

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
    if (this.connectTask) return this.connectTask;
    if (this.process && this.initialized && this.credentialStamp === this.currentCredentialStamp()) return;
    const task = this.initializeConnection();
    this.connectTask = task;
    try {
      await task;
    } finally {
      if (this.connectTask === task) this.connectTask = null;
    }
  }

  private async initializeConnection(): Promise<void> {
    // A profile can be logged into another account while this collector lives.
    // Reload the provider process on credential-file changes; never read or log its contents.
    await this.disconnect();
    if (this.closing) throw new Error("Codex App Server client is closing");
    this.credentialStamp = this.currentCredentialStamp();
    this.collectorEpoch = randomUUID();
    this.initialized = false;
    this.process = Bun.spawn(
      // This client only reads account/session metadata. Keep its sandbox
      // read-only and disallow interactive escalation; newer CLIs removed untrusted.
      [this.command, "-s", "read-only", "-a", "never", "app-server", "--stdio"],
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
    try {
      await this.request("initialize", {
        clientInfo: { name: "quotapie", title: "QuotaPie", version: "0.1.0" },
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
      this.initialized = true;
    } catch (error) {
      const process = this.process;
      this.process = null;
      this.initialized = false;
      if (process) await this.terminateProcess(process);
      await this.pumpTask?.catch(() => undefined);
      this.pumpTask = null;
      throw error;
    }
  }

  async readRateLimits(): Promise<QuotaObservation[]> {
    // Polls and provider push refreshes share one coherent account/quota read.
    if (this.rateLimitsTask) return this.rateLimitsTask;
    const task = this.exclusive(async () => {
      // A read-only request may retry once after a stopped child. Keep trusted
      // account context on this client and never replay an inference or action.
      for (let attempt = 0; ; attempt++) {
        try { return await this.readStableRateLimits(); }
        catch (error) {
          if (this.closing || attempt || !(error instanceof CodexTransportError)) throw error;
          await this.disconnect();
        }
      }
    });
    this.rateLimitsTask = task;
    try { return await task; }
    finally { if (this.rateLimitsTask === task) this.rateLimitsTask = null; }
  }

  private async readStableRateLimits(): Promise<QuotaObservation[]> {
    await this.connect();
    const stamp = this.currentCredentialStamp();
    const before = await this.readAccountIdentity();
    if (before === undefined && this.remoteAccount !== undefined) {
      throw new CodexSnapshotUnavailableError("Codex identity unavailable; quota snapshot not accepted");
    }
    const result = await this.request("account/rateLimits/read");
    const after = await this.readAccountIdentity();
    if (stamp !== this.currentCredentialStamp() || before !== after) throw new CodexSnapshotUnavailableError("Codex login changed during quota lookup; retrying on next poll");
    const observations = parseCodexRateLimits(result, Date.now(), this.account);
    const plan = planType(observations.find(item => item.metadata?.limitId === "codex")?.metadata?.planType);
    // A known plan change also separates anonymous legacy-provider readings.
    // The first identified reading must not inherit an anonymous baseline.
    if (after !== this.remoteAccount || plan !== this.remotePlan) {
      this.collectorEpoch = randomUUID();
    }
    if (this.remoteAccount !== undefined && after !== this.remoteAccount) this.accountContext = randomUUID();
    this.remoteAccount = after;
    this.remotePlan = plan;
    return observations.map((item) => ({
      ...item, metadata: { ...item.metadata, collectorEpoch: this.collectorEpoch,
        // Random, session-scoped continuity markers carry no email or account ID.
        ...(after ? { accountContext: this.accountContext, contextSession: this.contextSession } : {}) },
    }));
  }

  private async readAccountIdentity(): Promise<string | undefined> {
    try {
      const result = await this.request("account/read", { refreshToken: false }) as any;
      const account = result?.account;
      return account?.type === "chatgpt" && typeof account.email === "string" && account.email.length <= 320 && account.email.includes("@")
        ? account.email.trim().toLowerCase() : undefined;
    } catch (error) {
      // Only an explicitly unsupported method permits legacy quota-only reads.
      // Transient lookup errors must leave the last trusted snapshot intact.
      if (error instanceof CodexTransportError) throw error;
      if (error instanceof RpcRequestError && error.code === -32601) return undefined;
      throw new CodexSnapshotUnavailableError("Codex account lookup failed; quota snapshot not accepted");
    }
  }

  async listThreads(params: CodexThreadListParams = {}): Promise<CodexThreadListPage> {
    return this.exclusive(() => this.readThreadPage(params));
  }

  private async readThreadPage(params: CodexThreadListParams): Promise<CodexThreadListPage> {
    await this.connect();
    const result = await this.request("thread/list", params);
    if (!result || typeof result !== "object") {
      throw new Error("Codex App Server thread/list returned an invalid response");
    }
    const object = result as Record<string, unknown>;
    const rawData = Array.isArray(object.data) ? object.data : [];
    // thread/list also returns `preview` and other transcript metadata. Drop
    // those fields at this boundary; resume discovery only needs identity,
    // cwd, and the optional user-visible name.
    const data: CodexThreadSummary[] = rawData.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const thread = raw as Record<string, unknown>;
      if (typeof thread.id !== "string" || typeof thread.cwd !== "string") return [];
      return [{
        id: thread.id,
        cwd: thread.cwd,
        name: typeof thread.name === "string" ? thread.name : null,
      }];
    });
    return {
      data,
      nextCursor: typeof object.nextCursor === "string" ? object.nextCursor : null,
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(() => {
      if (this.closing) throw new Error("Codex App Server client is closing");
      return operation();
    });
    this.operations = task.catch(() => {});
    return task;
  }

  private write(message: RpcMessage): void {
    const stdin = this.process?.stdin;
    if (!stdin || typeof stdin === "number") throw new CodexTransportError("Codex App Server stdin is unavailable");
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
      try {
        this.write({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        // A synchronous write failure would otherwise leave this entry pending
        // until the timeout fires, delaying the error the caller already has.
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
      if (this.process === process) {
        this.process = null;
        this.initialized = false;
      }
      // EOF does not prove process exit: the provider can close stdout while
      // background model refresh tasks are still alive. Reap the owned child.
      if (process) await this.terminateProcess(process);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new CodexTransportError("Codex App Server stopped"));
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
        pending.reject(new RpcRequestError(message.error.message ?? "Codex App Server request failed", message.error.code));
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
        .catch((error) => console.error(`[quotapie] Codex update refresh failed: ${String(error)}`));
    }, 100);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.notificationRefreshTimer) clearTimeout(this.notificationRefreshTimer);
    this.notificationRefreshTimer = null;
    this.notificationRefreshScheduled = false;
    await this.disconnect();
  }

  private async terminateProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
    await Promise.race([child.exited, Bun.sleep(500)]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      await child.exited;
    }
  }

  private async disconnect(): Promise<void> {
    const child = this.process;
    this.initialized = false;
    if (child) {
      try {
        const stdin = child.stdin;
        if (stdin && typeof stdin !== "number") stdin.end();
      } catch { /* Provider may have closed its pipe already. */ }
      await this.terminateProcess(child);
    }
    await this.pumpTask?.catch(() => undefined);
    this.pumpTask = null;
    if (this.process === child) this.process = null;
  }
}
