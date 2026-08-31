import type { Provider, ResumeTask, ResumeTaskState } from "../types";
import type { QuotaStorage } from "./database";

interface ResumeTaskRow {
  id: string;
  task_key: string;
  provider: Provider;
  account: string;
  project_label: string;
  bucket: string;
  registered_at_ms: number;
  registered_remaining_percent: number;
  expected_reset_at_ms: number | null;
  state: ResumeTaskState;
  ready_at_ms: number | null;
  approved_at_ms: number | null;
  resumed_at_ms: number | null;
  dismissed_at_ms: number | null;
  updated_at_ms: number;
  error_detail: string | null;
}

export type ResumeTaskStoreErrorKind = "not-found" | "state-conflict" | "duplicate";

export class ResumeTaskStoreError extends Error {
  constructor(
    readonly kind: ResumeTaskStoreErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ResumeTaskStoreError";
  }
}

function fromRow(row: ResumeTaskRow): ResumeTask {
  return {
    id: row.id,
    taskKey: row.task_key,
    provider: row.provider,
    account: row.account,
    projectLabel: row.project_label,
    bucket: row.bucket,
    registeredAtMs: row.registered_at_ms,
    registeredRemainingPercent: row.registered_remaining_percent,
    expectedResetAtMs: row.expected_reset_at_ms,
    state: row.state,
    readyAtMs: row.ready_at_ms,
    approvedAtMs: row.approved_at_ms,
    resumedAtMs: row.resumed_at_ms,
    dismissedAtMs: row.dismissed_at_ms,
    updatedAtMs: row.updated_at_ms,
    errorDetail: row.error_detail,
  };
}

export interface CreateResumeTask {
  id: string;
  taskKey: string;
  provider: Provider;
  account: string;
  projectLabel: string;
  bucket: string;
  registeredAtMs: number;
  registeredRemainingPercent: number;
  expectedResetAtMs: number | null;
}

const ACTIVE_STATES = ["waiting", "ready", "approved"] as const;

export class ResumeTaskStore {
  constructor(private readonly storage: QuotaStorage) {}

  create(input: CreateResumeTask): ResumeTask {
    return this.storage.transaction(() => {
      const existing = this.storage.db
        .query<{ id: string }, [string]>(`
          SELECT id FROM resume_tasks
          WHERE task_key = ? AND state IN ('waiting', 'ready', 'approved')
          LIMIT 1
        `)
        .get(input.taskKey);
      if (existing) {
        throw new ResumeTaskStoreError("duplicate", "this session already has an active resume task");
      }
      try {
        this.storage.db.query(`
          INSERT INTO resume_tasks(
            id, task_key, provider, account, project_label, bucket,
            registered_at_ms, registered_remaining_percent,
            expected_reset_at_ms, state, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)
        `).run(
          input.id,
          input.taskKey,
          input.provider,
          input.account,
          input.projectLabel,
          input.bucket,
          input.registeredAtMs,
          input.registeredRemainingPercent,
          input.expectedResetAtMs,
          input.registeredAtMs,
        );
      } catch (error) {
        if (String(error).includes("resume_tasks.task_key")) {
          throw new ResumeTaskStoreError("duplicate", "this session already has an active resume task");
        }
        throw error;
      }
      return this.getRequired(input.id);
    });
  }

  get(id: string): ResumeTask | null {
    const row = this.storage.db
      .query<ResumeTaskRow, [string]>("SELECT * FROM resume_tasks WHERE id = ?")
      .get(id);
    return row ? fromRow(row) : null;
  }

  list(limit = 100): ResumeTask[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.storage.db
      .query<ResumeTaskRow, [number]>(`
        SELECT * FROM resume_tasks
        ORDER BY registered_at_ms DESC, id DESC
        LIMIT ?
      `)
      .all(safeLimit)
      .map(fromRow);
  }

  active(limit = 100): ResumeTask[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.storage.db
      .query<ResumeTaskRow, [number]>(`
        SELECT * FROM resume_tasks
        WHERE state IN ('waiting', 'ready', 'approved')
        ORDER BY registered_at_ms DESC, id DESC
        LIMIT ?
      `)
      .all(safeLimit)
      .map(fromRow);
  }

  waiting(): ResumeTask[] {
    return this.storage.db
      .query<ResumeTaskRow, []>(`
        SELECT * FROM resume_tasks
        WHERE state = 'waiting'
        ORDER BY registered_at_ms ASC, id ASC
      `)
      .all()
      .map(fromRow);
  }

  markReady(id: string, atMs: number): ResumeTask {
    return this.transition(id, ["waiting"], "ready", atMs, `
      ready_at_ms = ?, approved_at_ms = NULL, error_detail = NULL,
    `, [atMs]);
  }

  markWaiting(id: string, atMs: number): ResumeTask {
    return this.transition(id, ["ready"], "waiting", atMs, `
      ready_at_ms = NULL, approved_at_ms = NULL, error_detail = NULL,
    `, []);
  }

  approve(id: string, atMs: number): ResumeTask {
    return this.transition(id, ["ready"], "approved", atMs, `
      approved_at_ms = ?, error_detail = NULL,
    `, [atMs]);
  }

  markResumed(id: string, atMs: number): ResumeTask {
    return this.transition(id, ["approved"], "resumed", atMs, `
      resumed_at_ms = ?, error_detail = NULL,
    `, [atMs]);
  }

  retry(id: string, atMs: number): ResumeTask {
    return this.transition(id, ["approved"], "ready", atMs, `
      approved_at_ms = NULL, error_detail = NULL,
    `, []);
  }

  dismiss(id: string, atMs: number): ResumeTask {
    return this.transition(id, [...ACTIVE_STATES], "dismissed", atMs, `
      dismissed_at_ms = ?, error_detail = NULL,
    `, [atMs]);
  }

  setError(id: string, detail: string, atMs: number): ResumeTask {
    const result = this.storage.db
      .query(`
        UPDATE resume_tasks
        SET error_detail = ?, updated_at_ms = ?
        WHERE id = ?
      `)
      .run(detail, atMs, id);
    if (result.changes === 0) throw new ResumeTaskStoreError("not-found", "resume task not found");
    return this.getRequired(id);
  }

  updateExpectedReset(id: string, expectedResetAtMs: number | null, atMs: number): ResumeTask {
    const result = this.storage.db
      .query(`
        UPDATE resume_tasks
        SET expected_reset_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND state = 'waiting'
      `)
      .run(expectedResetAtMs, atMs, id);
    if (result.changes === 0) {
      const current = this.get(id);
      if (!current) throw new ResumeTaskStoreError("not-found", "resume task not found");
      throw new ResumeTaskStoreError("state-conflict", `resume task is ${current.state}; expected waiting`);
    }
    return this.getRequired(id);
  }

  pruneTerminal(cutoffMs: number): number {
    return this.storage.db
      .query(`
        DELETE FROM resume_tasks
        WHERE state IN ('resumed', 'dismissed') AND updated_at_ms < ?
      `)
      .run(cutoffMs).changes;
  }

  private transition(
    id: string,
    expected: ResumeTaskState[],
    next: ResumeTaskState,
    atMs: number,
    assignments: string,
    values: Array<string | number | null>,
  ): ResumeTask {
    return this.storage.transaction(() => {
      const placeholders = expected.map(() => "?").join(", ");
      const result = this.storage.db
        .query(`
          UPDATE resume_tasks
          SET ${assignments}
              state = ?, updated_at_ms = ?
          WHERE id = ? AND state IN (${placeholders})
        `)
        .run(...values, next, atMs, id, ...expected);
      if (result.changes === 0) {
        const current = this.get(id);
        if (!current) throw new ResumeTaskStoreError("not-found", "resume task not found");
        throw new ResumeTaskStoreError(
          "state-conflict",
          `resume task is ${current.state}; expected ${expected.join(" or ")}`,
        );
      }
      return this.getRequired(id);
    });
  }

  private getRequired(id: string): ResumeTask {
    const task = this.get(id);
    if (!task) throw new ResumeTaskStoreError("not-found", "resume task not found");
    return task;
  }
}
