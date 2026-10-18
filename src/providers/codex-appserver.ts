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

export class CodexGoalUnsupportedError extends Error {}
export class CodexTurnUnsupportedError extends Error {}
export class CodexQueueUnsupportedError extends Error {}

export interface CodexQueuedSubmission { id: string; clientUserMessageId: string }
export interface CodexThreadQueuePage { data: CodexQueuedSubmission[]; nextCursor: string | null }
export interface CodexThreadQueueListParams { cursor?: string | null; limit?: number }

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const queueInvalid = () => new Error("Codex App Server queue returned an invalid response");
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw queueInvalid();
  return value as Record<string, any>;
}
function queueIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function queueEnvelope(value: unknown, threadId: string): Record<string, any> {
  const result = record(value);
  if (result.threadId !== undefined && result.threadId !== threadId) throw queueInvalid();
  return result;
}
function queueSubmission(value: unknown): CodexQueuedSubmission {
  const entry = record(value);
  if (!queueIdentifier(entry.id) || !queueIdentifier(entry.clientUserMessageId) || !Array.isArray(entry.input)) throw queueInvalid();
  // The queue may contain other users' messages. Never expose their bodies.
  for (const input of entry.input) {
    const item = record(input);
    if (typeof item.type !== "string" || !["text", "image", "localImage", "audio", "localAudio", "skill", "mention"].includes(item.type)) throw queueInvalid();
    if (item.type === "text" && typeof item.text !== "string") throw queueInvalid();
    if (item.type === "image" && typeof item.url !== "string" && typeof item.fileId !== "string") throw queueInvalid();
    if (item.type === "audio" && typeof item.url !== "string") throw queueInvalid();
    if (["localImage", "localAudio", "skill", "mention"].includes(item.type) && typeof item.path !== "string") throw queueInvalid();
    if (["skill", "mention"].includes(item.type) && typeof item.name !== "string") throw queueInvalid();
  }
  return { id: entry.id, clientUserMessageId: entry.clientUserMessageId };
}
function queueCursor(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !value.length || value.length > 4096) throw queueInvalid();
  return value;
}

export interface CodexThreadTurnSummary {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  errorCode: string | null;
  completedAtMs: number | null;
}

function parseLatestTurn(result: unknown, threadId: string, allowInterruptedError = false): CodexThreadTurnSummary | null {
  const invalid = () => new Error("Codex App Server thread/turns/list returned an invalid response");
  if (!result || typeof result !== "object" || Array.isArray(result)) throw invalid();
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length > 1) throw invalid();
  if (!data.length) return null;
  const turn = data[0];
  if (!turn || typeof turn !== "object" || Array.isArray(turn) ||
      typeof turn.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(turn.id) ||
      !["completed", "interrupted", "failed", "inProgress"].includes(turn.status) ||
      !Array.isArray(turn.items) || turn.items.length !== 0 || turn.itemsView !== "notLoaded") throw invalid();
  if (turn.completedAt != null && (!Number.isSafeInteger(turn.completedAt) || turn.completedAt < 0 ||
      !Number.isSafeInteger(turn.completedAt * 1000))) throw invalid();
  let errorCode: string | null = null;
  if (turn.error != null) {
    if ((turn.status !== "failed" && !(allowInterruptedError && turn.status === "interrupted")) || typeof turn.error !== "object" || Array.isArray(turn.error)) throw invalid();
    const code = turn.error.codexErrorInfo;
    if (typeof code === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,80}$/.test(code)) errorCode = code;
    else if (code != null && (typeof code !== "object" || Array.isArray(code))) throw invalid();
  }
  return { threadId, turnId: turn.id, status: turn.status, errorCode,
    completedAtMs: turn.completedAt == null ? null : turn.completedAt * 1000 };
}

const CODEX_GOAL_STATUSES = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const;

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: typeof CODEX_GOAL_STATUSES[number];
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
}

function parseThreadGoal(result: unknown, threadId: string): CodexThreadGoal | null {
  const invalid = () => new Error("Codex App Server thread/goal/get returned an invalid response");
  if (!result || typeof result !== "object" || Array.isArray(result)) throw invalid();
  const raw = (result as Record<string, unknown>).goal;
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const goal = raw as Record<string, unknown>;
  if (goal.threadId !== threadId || typeof goal.objective !== "string" ||
      typeof goal.status !== "string" || !CODEX_GOAL_STATUSES.includes(goal.status as CodexThreadGoal["status"])) {
    throw invalid();
  }
  // Keep only goal metadata. Additional provider fields must not turn this
  // read-only boundary into a source of transcript, path or credential data.
  const parsed: CodexThreadGoal = { threadId, objective: goal.objective, status: goal.status as CodexThreadGoal["status"] };
  for (const key of ["tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt"] as const) {
    if (goal[key] === undefined) continue;
    if (typeof goal[key] !== "number" || !Number.isSafeInteger(goal[key]) || goal[key] < 0) throw invalid();
    parsed[key] = goal[key];
  }
  if (goal.tokenBudget !== undefined) {
    if (goal.tokenBudget !== null && (typeof goal.tokenBudget !== "number" ||
        !Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget < 0)) throw invalid();
    parsed.tokenBudget = goal.tokenBudget as number | null;
  }
  return parsed;
}

export interface CodexThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | null;
  sortDirection?: "asc" | "desc" | null;
  archived?: boolean | null;
  useStateDbOnly?: boolean;
  sourceKinds?: Array<"cli" | "vscode" | "exec" | "appServer">;
  modelProviders?: string[];
}

export interface CodexThreadSummary {
  id: string;
  cwd: string;
  name: string | null;
  updatedAtMs?: number;
}

export interface CodexThreadListPage {
  data: CodexThreadSummary[];
  nextCursor: string | null;
}

import { normalizeCodexPlanType, parseCodexRateLimits } from "../../packages/quota-core/src/codex-usage.js";
export { parseCodexRateLimits } from "../../packages/quota-core/src/codex-usage.js";

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
  private executableStamp: string | null = null;
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

  private currentExecutableStamp(): string | null {
    try {
      const path = Bun.which(this.command) ?? this.command;
      const stat = statSync(path);
      return `${path}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch { return null; }
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
    // A stable command/symlink can point to a new executable after an update.
    // Restart only our protocol client child, never a user's inference process.
    // A temporarily missing file during replacement need not stop a healthy child.
    const executable = this.currentExecutableStamp();
    if (this.process && this.initialized && this.credentialStamp === this.currentCredentialStamp()
        && (executable == null || executable === this.executableStamp)) return;
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
    this.executableStamp = this.currentExecutableStamp();
    this.collectorEpoch = randomUUID();
    this.initialized = false;
    this.process = Bun.spawn(
      // This child reads metadata and submits explicit host-queue requests;
      // it never starts inference. Keep its own sandbox read-only with no escalation.
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
    const plan = normalizeCodexPlanType(observations.find(item => item.metadata?.limitId === "codex")?.metadata?.planType);
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

  /** Last quota-verified login, for local account presentation only. */
  get accountEmail(): string | undefined { return this.remoteAccount; }

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

  /** Metadata only: never request turn items, transcript text or inference. */
  async readLatestTurn(threadId: string): Promise<CodexThreadTurnSummary | null> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId))
      throw new Error("Codex turn lookup requires a thread UUID");
    return this.exclusive(async () => {
      await this.connect();
      const stamp = this.currentCredentialStamp();
      const before = await this.readAccountIdentity();
      if (before === undefined) throw new CodexSnapshotUnavailableError("Codex identity unavailable; turn snapshot not accepted");
      let result: unknown, unsupported = false;
      try {
        result = await this.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      } catch (error) {
        if (!(error instanceof RpcRequestError) || error.code !== -32601) throw error;
        unsupported = true;
      }
      const after = await this.readAccountIdentity();
      if (stamp !== this.currentCredentialStamp() || before !== after)
        throw new CodexSnapshotUnavailableError("Codex login changed during turn lookup; retrying on next poll");
      if (unsupported) throw new CodexTurnUnsupportedError("Codex App Server does not support thread/turns/list");
      return parseLatestTurn(result, threadId);
    });
  }

  /** Queue IDs correlate delivery; clientUserMessageId is NOT a deduplication key. */
  async listThreadQueue(threadId: string, params: CodexThreadQueueListParams = {}): Promise<CodexThreadQueuePage> {
    this.validateQueueThread(threadId);
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) throw new Error("Invalid queue page limit");
    if (params.cursor !== undefined && params.cursor !== null) queueCursor(params.cursor);
    return this.queueOperation(async () => {
      const result = queueEnvelope(await this.queueRequest("thread/queue/list", {
        threadId, ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      }), threadId);
      if (!Array.isArray(result.data) || result.data.length > (params.limit ?? 100)) throw queueInvalid();
      const data = result.data.map(queueSubmission);
      if (new Set(data.map(item => item.id)).size !== data.length) throw queueInvalid();
      return { data, nextCursor: queueCursor(result.nextCursor) };
    });
  }

  /** Exactly one transport attempt. Any ambiguous failure must be reconciled, never replayed. */
  async addThreadQueue(threadId: string, clientUserMessageId: string, text: string, beforeWrite?: () => void): Promise<CodexQueuedSubmission> {
    this.validateQueueThread(threadId);
    if (!queueIdentifier(clientUserMessageId) || typeof text !== "string" || !text.trim() || text.length > 32_768)
      throw new Error("Invalid queue submission");
    return this.queueOperation(async () => {
      // Account/connect awaits must not outlive the caller's consent or deadline.
      // No asynchronous work separates this veto from the single request write.
      beforeWrite?.();
      const result = queueEnvelope(await this.queueRequest("thread/queue/add", {
        threadId, clientUserMessageId, input: [{ type: "text", text }],
      }), threadId);
      const submission = queueSubmission(result.queuedSubmission);
      const input = result.queuedSubmission.input;
      if (submission.clientUserMessageId !== clientUserMessageId || input.length !== 1 ||
          input[0].type !== "text" || input[0].text !== text) throw queueInvalid();
      return submission;
    });
  }

  /** The owner can already hold a copy. Neither result proves execution cancellation. */
  async deleteThreadQueue(threadId: string, queuedSubmissionId: string): Promise<boolean> {
    this.validateQueueThread(threadId);
    if (!queueIdentifier(queuedSubmissionId)) throw new Error("Invalid queue submission ID");
    return this.queueOperation(async () => {
      const result = queueEnvelope(await this.queueRequest("thread/queue/delete", { threadId, queuedSubmissionId }), threadId);
      if (typeof result.deleted !== "boolean") throw queueInvalid();
      return result.deleted;
    });
  }

  /** Persisted user-message correlation only. A miss never authorizes a resend. */
  async readTurnForClientMessage(threadId: string, clientUserMessageId: string, afterTurnId?: string): Promise<CodexThreadTurnSummary | null> {
    this.validateQueueThread(threadId);
    if (!queueIdentifier(clientUserMessageId) || (afterTurnId !== undefined && !UUID.test(afterTurnId)))
      throw new Error("Invalid queue correlation identity");
    return this.queueOperation(async () => {
      let cursor: string | null = null, matchedTurn: string | null = null, complete = false;
      const cursors = new Set<string>(), itemIds = new Set<string>();
      for (let page = 0; page < 5; page++) {
        const result = queueEnvelope(await this.queueRequest("thread/items/list", {
          threadId, limit: 100, sortDirection: "desc", ...(cursor ? { cursor } : {}),
        }), threadId);
        if (!Array.isArray(result.data) || result.data.length > 100) throw queueInvalid();
        for (const raw of result.data) {
          const entry = record(raw), item = record(entry.item);
          if (!UUID.test(entry.turnId) || !queueIdentifier(item.id) || typeof item.type !== "string") throw queueInvalid();
          if (itemIds.has(item.id)) throw queueInvalid();
          itemIds.add(item.id);
          if (entry.turnId === afterTurnId) { complete = true; break; }
          if (item.type !== "userMessage") continue;
          if (!Array.isArray(item.content) || (item.clientId != null && !queueIdentifier(item.clientId))) throw queueInvalid();
          if (item.clientId === clientUserMessageId) {
            if (matchedTurn !== null) throw new Error("Codex queue correlation is ambiguous");
            matchedTurn = entry.turnId;
          }
        }
        cursor = queueCursor(result.nextCursor);
        if (complete || cursor === null) { complete = true; break; }
        if (cursors.has(cursor)) throw queueInvalid();
        cursors.add(cursor);
      }
      if (!complete) throw new CodexSnapshotUnavailableError("Codex queue correlation exceeded its history bound");
      if (!matchedTurn) return null;
      const turn = await this.readTurnMetadata(threadId, matchedTurn);
      if (!turn) throw new CodexSnapshotUnavailableError("Codex correlated turn metadata is unavailable");
      return turn;
    });
  }

  /** Poll an already-correlated immutable turn without re-reading growing items. */
  async readTurn(threadId: string, turnId: string): Promise<CodexThreadTurnSummary | null> {
    this.validateQueueThread(threadId);
    if (typeof turnId !== "string" || !UUID.test(turnId)) throw new Error("Codex turn lookup requires a turn UUID");
    return this.queueOperation(() => this.readTurnMetadata(threadId, turnId));
  }

  private async readTurnMetadata(threadId: string, turnId: string): Promise<CodexThreadTurnSummary | null> {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const result = queueEnvelope(await this.queueRequest("thread/turns/list", {
        threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}),
      }), threadId);
      if (!Array.isArray(result.data) || result.data.length > 100) throw queueInvalid();
      const matches = result.data.filter((raw: unknown) => record(raw).id === turnId);
      if (matches.length > 1) throw queueInvalid();
      if (matches.length === 1) return parseLatestTurn({ data: matches }, threadId, true);
      cursor = queueCursor(result.nextCursor);
      if (cursor === null) return null;
      if (cursors.has(cursor)) throw queueInvalid();
      cursors.add(cursor);
    }
    throw new CodexSnapshotUnavailableError("Codex correlated turn metadata exceeded its history bound");
  }

  private validateQueueThread(threadId: string): void {
    if (typeof threadId !== "string" || !UUID.test(threadId)) throw new Error("Codex queue requires a thread UUID");
  }

  private async queueRequest(method: string, params: unknown): Promise<unknown> {
    try { return await this.request(method, params); }
    catch (error) {
      if (error instanceof RpcRequestError && error.code === -32601)
        throw new CodexQueueUnsupportedError("host-queue-unsupported");
      // Server messages may include submitted text. Keep this boundary opaque.
      throw new Error("Codex queue request failed; delivery may be unknown");
    }
  }

  private queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.connect();
      const stamp = this.currentCredentialStamp();
      const before = await this.readAccountIdentity();
      if (before === undefined || (this.remoteAccount !== undefined && before !== this.remoteAccount) ||
          stamp !== this.currentCredentialStamp() || stamp !== this.credentialStamp)
        throw new CodexSnapshotUnavailableError("Codex identity unavailable or changed; queue operation withheld");
      // Deliberately no transport retry: add may have committed before a pipe error.
      const result = await operation();
      const after = await this.readAccountIdentity();
      if (before !== after || stamp !== this.currentCredentialStamp())
        throw new CodexSnapshotUnavailableError("Codex login changed during queue operation; delivery may be unknown");
      return result;
    });
  }

  async readThreadGoal(threadId: string): Promise<CodexThreadGoal | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
      throw new Error("Codex goal lookup requires a thread UUID");
    }
    return this.exclusive(async () => {
      await this.connect();
      const stamp = this.currentCredentialStamp();
      const before = await this.readAccountIdentity();
      // Unlike quota-only legacy reads, linked goal data requires a verified
      // login. Never accept an anonymous snapshot as belonging to this profile.
      if (before === undefined) throw new CodexSnapshotUnavailableError("Codex identity unavailable; goal snapshot not accepted");
      let result: unknown;
      let unsupported = false;
      try {
        result = await this.request("thread/goal/get", { threadId });
      } catch (error) {
        if (!(error instanceof RpcRequestError) || error.code !== -32601) throw error;
        unsupported = true;
      }
      const after = await this.readAccountIdentity();
      if (stamp !== this.currentCredentialStamp() || before !== after) {
        throw new CodexSnapshotUnavailableError("Codex login changed during goal lookup; retrying on next poll");
      }
      if (unsupported) throw new CodexGoalUnsupportedError("Codex App Server does not support thread/goal/get");
      return parseThreadGoal(result, threadId);
    });
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
        ...(typeof thread.updatedAt === "number" && Number.isSafeInteger(thread.updatedAt) && thread.updatedAt >= 0 &&
          Number.isSafeInteger(thread.updatedAt * 1000) ? { updatedAtMs: thread.updatedAt * 1000 } : {}),
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

  /** Explicit user preference only; the native writer preserves unrelated TOML. */
  async writeDockIcon(value: "app-default" | "codex-system" | "space-system"): Promise<void> {
    await this.connect();
    await this.request("config/value/write", {
      keyPath: "desktop.dock-icon-preference", value, mergeStrategy: "upsert", reloadUserConfig: true,
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        // A silent child is a transport failure, not an untrusted identity
        // response. Let the bounded read retry restart it while preserving
        // this client's last confirmed account and plan context.
        reject(new CodexTransportError(`Codex App Server ${method} timed out`));
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
