import { randomUUID } from "node:crypto";
import type { QuotaStorage } from "./storage/database";
import type { ResumeTaskState } from "./types";

export type HostGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export type HostGoalReadState = "loading" | "ready" | "no_goal" | "unsupported" | "error" | "stale" | "account_changed";

export interface HostGoalSnapshot {
  readState: HostGoalReadState;
  objective: string | null;
  hostStatus: HostGoalStatus | null;
  observedAtMs: number | null;
  expiresAtMs: number | null;
  objectiveChanged?: boolean;
}

export function projectHostGoal(link: HostGoalLink, accountMatches: boolean, nowMs: number, maxAgeMs: number): HostGoalSnapshot {
  const expiresAtMs = link.observed_at_ms == null ? null : link.observed_at_ms + maxAgeMs;
  const stale = expiresAtMs != null && (nowMs >= expiresAtMs || link.observed_at_ms! > nowMs);
  return {
    readState: !accountMatches ? "account_changed" : stale && ["ready", "no_goal"].includes(link.read_state) ? "stale" : link.read_state,
    objective: accountMatches ? link.objective : null,
    hostStatus: accountMatches ? link.host_status : null,
    observedAtMs: accountMatches ? link.observed_at_ms : null,
    expiresAtMs: accountMatches ? expiresAtMs : null,
  };
}

export interface HostGoalLinkSummary {
  id: string;
  taskId: string;
  provider: "codex";
  account: string;
  accountLabel: string;
  projectLabel: string;
  readState: HostGoalReadState;
  objective: string | null;
  hostStatus: HostGoalStatus | null;
  observedAtMs: number | null;
  expiresAtMs: number | null;
  resumeState: ResumeTaskState | "unknown";
}

/** Private session locator. Never serialize a stored link into the status API. */
export interface HostGoalLink {
  task_id: string;
  thread_id: string;
  revision: string;
  read_state: HostGoalReadState;
  objective: string | null;
  host_status: HostGoalStatus | null;
  observed_at_ms: number | null;
  attempted_at_ms: number | null;
}

export class HostGoalLinkError extends Error {}

export class HostGoalLinkStore {
  constructor(private readonly storage: QuotaStorage) {}

  list(): HostGoalLink[] {
    return this.storage.db.query<HostGoalLink, []>("SELECT * FROM host_goal_links ORDER BY task_id").all();
  }

  get(taskId: string): HostGoalLink | null {
    return this.storage.db.query<HostGoalLink, [string]>("SELECT * FROM host_goal_links WHERE task_id=?").get(taskId);
  }

  link(taskId: string, threadId: string): HostGoalLink {
    if (!this.get(taskId) && this.list().length >= 50) throw new HostGoalLinkError("host_goal_link_limit");
    this.storage.db.query(`INSERT INTO host_goal_links(task_id,thread_id,revision,read_state)
      VALUES (?,?,?,'loading') ON CONFLICT(task_id) DO UPDATE SET
      thread_id=excluded.thread_id, revision=excluded.revision, read_state='loading',
      objective=NULL, host_status=NULL, observed_at_ms=NULL, attempted_at_ms=NULL`)
      .run(taskId, threadId, randomUUID());
    return this.get(taskId)!;
  }

  record(link: HostGoalLink, state: HostGoalReadState, nowMs: number,
    goal?: { objective: string; status: HostGoalStatus } | null): void {
    // Failed reads retain a visibly cached observation. Account changes discard
    // it entirely. A late response must not resurrect an unlinked/relinked row.
    const replace = state === "ready" || state === "no_goal" || state === "account_changed";
    this.storage.db.query(`UPDATE host_goal_links SET read_state=?, attempted_at_ms=?,
      objective=CASE WHEN ? THEN ? ELSE objective END,
      host_status=CASE WHEN ? THEN ? ELSE host_status END,
      observed_at_ms=CASE WHEN ? THEN ? ELSE observed_at_ms END
      WHERE task_id=? AND revision=?`)
      .run(state, nowMs, replace ? 1 : 0, goal?.objective ?? null,
        replace ? 1 : 0, goal?.status ?? null, replace ? 1 : 0,
        state === "account_changed" ? null : nowMs, link.task_id, link.revision);
  }

  unlink(taskId: string): void {
    this.storage.db.query("DELETE FROM host_goal_links WHERE task_id=?").run(taskId);
  }

  prune(): void {
    this.storage.db.run("DELETE FROM host_goal_links WHERE task_id NOT IN (SELECT id FROM resume_tasks)");
  }
}

export interface WorkHostGoalLink extends HostGoalLink {
  binding_key: string;
  linked_objective: string | null;
}

/** A work link is separate from a paused-session registration. Binding and
 * revision fences prevent late reads from attaching to an edited/relinked task. */
export class WorkHostGoalLinkStore {
  constructor(private readonly storage: QuotaStorage) {}
  list(): WorkHostGoalLink[] {
    return this.storage.db.query<WorkHostGoalLink, []>("SELECT * FROM work_host_goal_links ORDER BY task_id").all();
  }
  get(id: string): WorkHostGoalLink | null {
    return this.storage.db.query<WorkHostGoalLink, [string]>("SELECT * FROM work_host_goal_links WHERE task_id=?").get(id);
  }
  link(id: string, threadId: string, bindingKey: string, reviewedObjective: string): WorkHostGoalLink {
    if (!this.get(id) && this.list().length >= 50) throw new HostGoalLinkError("work-host-goal-link-limit");
    this.storage.db.query(`INSERT INTO work_host_goal_links(task_id,thread_id,revision,binding_key,linked_objective,read_state)
      VALUES (?,?,?,?,?,'loading') ON CONFLICT(task_id) DO UPDATE SET
      thread_id=excluded.thread_id, revision=excluded.revision, binding_key=excluded.binding_key,
      read_state='loading', objective=NULL, host_status=NULL, linked_objective=excluded.linked_objective,
      observed_at_ms=NULL, attempted_at_ms=NULL`).run(id, threadId, randomUUID(), bindingKey, reviewedObjective);
    return this.get(id)!;
  }
  record(link: WorkHostGoalLink, state: HostGoalReadState, nowMs: number,
    goal?: { objective: string; status: HostGoalStatus } | null): void {
    const replace = state === "ready" || state === "no_goal" || state === "account_changed";
    this.storage.db.query(`UPDATE work_host_goal_links SET read_state=?, attempted_at_ms=?,
      objective=CASE WHEN ? THEN ? ELSE objective END,
      host_status=CASE WHEN ? THEN ? ELSE host_status END,
      observed_at_ms=CASE WHEN ? THEN ? ELSE observed_at_ms END
      WHERE task_id=? AND revision=? AND binding_key=?`)
      .run(state, nowMs, replace ? 1 : 0, goal?.objective ?? null, replace ? 1 : 0, goal?.status ?? null,
        replace ? 1 : 0, state === "account_changed" ? null : nowMs,
        link.task_id, link.revision, link.binding_key);
  }
  unlink(id: string): void { this.storage.db.query("DELETE FROM work_host_goal_links WHERE task_id=?").run(id); }
}
