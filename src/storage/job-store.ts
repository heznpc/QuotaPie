import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Job, JobClaim, JobFinish, JobSpec, JobState, JobStep, JobStepState, JobSummary } from "../jobs/types";
import type { QuotaStorage } from "./database";

export const JOB_LEASE_MS = 120_000;
const MAX_TEXT_BYTES = 1_048_576;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REASON = /^[a-z][a-z0-9-]{0,79}$/;

export type JobStoreErrorKind = "invalid-spec" | "key-conflict" | "not-found" | "state-conflict" | "claim-conflict";
export class JobStoreError extends Error {
  constructor(readonly kind: JobStoreErrorKind, message: string) {
    super(message);
    this.name = "JobStoreError";
  }
}

function invalid(message: string): never { throw new JobStoreError("invalid-spec", message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains unsupported fields`);
}
function text(value: unknown, label: string, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || value.includes("\0")) invalid(`invalid ${label}`);
  if (!multiline && /[\x00-\x1f\x7f]/.test(value)) invalid(`invalid ${label}`);
  return value;
}
function key(value: unknown, label: string): string {
  if (typeof value !== "string" || !KEY.test(value)) invalid(`invalid ${label}`);
  return value;
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid("invalid timestamp");
}
function reasonCode(value: string | null): void {
  if (value !== null && !REASON.test(value)) invalid("reason must be a short code");
}

/** Validate and canonicalize field order, so identical keys cannot silently replace a plan. */
export function validateJobSpec(input: unknown): JobSpec {
  const spec = record(input, "job");
  fields(spec, ["version", "key", "label", "provider", "account", "cwd", "buckets", "model", "profileKey", "steps", "policy"], "job");
  if (spec.version !== 1) invalid("unsupported job version");
  if (spec.provider !== "codex" && spec.provider !== "claude") invalid("unsupported provider");
  if (spec.profileKey !== undefined && (typeof spec.profileKey !== "string" || !/^[a-f0-9]{64}$/.test(spec.profileKey))) invalid("invalid profile key");
  const cwd = text(spec.cwd, "cwd", 4096);
  if (!isAbsolute(cwd)) invalid("cwd must be absolute");
  if (!Array.isArray(spec.buckets) || spec.buckets.length < 1 || spec.buckets.length > 20) invalid("buckets must contain 1 to 20 quota windows");
  const buckets = spec.buckets.map((bucket) => text(bucket, "bucket", 160));
  if (new Set(buckets).size !== buckets.length) invalid("duplicate quota windows");
  if (!Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 500) invalid("steps must contain 1 to 500 entries");
  const steps = spec.steps.map((input) => {
    const step = record(input, "step");
    fields(step, ["key", "prompt", "retrySafe"], "step");
    if (step.retrySafe !== undefined && typeof step.retrySafe !== "boolean") invalid("invalid retrySafe");
    return {
      // Legacy checkpoints identify combinations such as "task1::method1".
      // Step identities stay private and are bound through SQL parameters.
      key: text(step.key, "step key", 160),
      prompt: text(step.prompt, "prompt", 131_072, true),
      ...(step.retrySafe === undefined ? {} : { retrySafe: step.retrySafe as boolean }),
    };
  });
  if (new Set(steps.map((step) => step.key)).size !== steps.length) invalid("duplicate step keys");
  const policy = record(spec.policy, "policy");
  fields(policy, ["mode", "expiresAtMs", "maxAttempts"], "policy");
  if (policy.mode !== "manual" && policy.mode !== "auto") invalid("invalid approval mode");
  if (typeof policy.expiresAtMs !== "number" || !Number.isSafeInteger(policy.expiresAtMs) || policy.expiresAtMs <= 0) invalid("invalid expiry");
  if (typeof policy.maxAttempts !== "number" || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10_000) invalid("invalid maxAttempts");
  const result: JobSpec = {
    version: 1,
    key: key(spec.key, "job key"),
    label: text(spec.label, "label", 160),
    provider: spec.provider,
    account: text(spec.account, "account", 128),
    cwd,
    buckets: buckets.sort(),
    ...(spec.model === undefined ? {} : { model: text(spec.model, "model", 120) }),
    ...(spec.profileKey === undefined ? {} : { profileKey: spec.profileKey as string }),
    steps,
    policy: { mode: policy.mode, expiresAtMs: policy.expiresAtMs, maxAttempts: policy.maxAttempts },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_TEXT_BYTES) invalid("job specification exceeds 1 MiB");
  return result;
}

interface JobRow {
  id: string;
  spec_json: string;
  state: JobState;
  created_at_ms: number;
  updated_at_ms: number;
  blocked_at_ms: number | null;
  not_before_ms: number | null;
  reason: string | null;
  attempt_count: number;
  approved_at_ms: number | null;
  imported_at_ms: number | null;
  claim_token: string | null;
  lease_at_ms: number | null;
  active_step_index: number | null;
}
interface StepRow {
  step_key: string;
  step_index: number;
  state: JobStepState;
  result: string | null;
  native_session_id: string | null;
  attempt_count: number;
}

export class JobStore {
  constructor(private readonly storage: QuotaStorage) {}

  submit(input: JobSpec, now = Date.now()): Job {
    timestamp(now);
    const spec = validateJobSpec(input);
    const serialized = JSON.stringify(spec);
    return this.storage.transaction(() => {
      const existing = this.storage.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE job_key = ?").get(spec.key);
      if (existing) {
        if (existing.spec_json !== serialized) throw new JobStoreError("key-conflict", "job key already belongs to a different specification");
        return this.fromRow(existing, now);
      }
      const id = randomUUID();
      this.storage.db.query(`INSERT INTO jobs(id, job_key, spec_json, provider, account, state, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`).run(id, spec.key, serialized, spec.provider, spec.account, now, now);
      for (const [index, step] of spec.steps.entries()) {
        this.storage.db.query("INSERT INTO job_steps(job_id, step_index, step_key, state) VALUES (?, ?, ?, 'pending')").run(id, index, step.key);
      }
      this.storage.secureFiles();
      return this.required(id, now);
    });
  }

  get(id: string, now = Date.now()): Job | null {
    const row = this.storage.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? this.fromRow(row, now) : null;
  }

  list(limit = 100): Job[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 100;
    return this.storage.db.query<JobRow, [number]>("SELECT * FROM jobs ORDER BY created_at_ms DESC, id DESC LIMIT ?").all(safeLimit).map((row) => this.fromRow(row));
  }

  summaries(limit = 100): JobSummary[] {
    return this.list(limit).map((job) => ({
      id: job.id, key: job.spec.key, label: job.spec.label, provider: job.spec.provider,
      account: job.spec.account, state: job.state,
      completedSteps: job.steps.filter((step) => step.state === "succeeded").length,
      totalSteps: job.steps.length, attemptCount: job.attemptCount, reason: job.reason,
      updatedAtMs: job.updatedAtMs, policy: { mode: job.spec.policy.mode },
    }));
  }

  /** Delivery must include older eligible jobs, independently of UI pagination. */
  notificationSummaries(): JobSummary[] {
    type Row = Omit<JobSummary, "policy"> & { mode: JobSpec["policy"]["mode"] };
    return this.storage.db.query<Row, []>(`
      SELECT jobs.id, json_extract(spec_json, '$.key') AS key,
        json_extract(spec_json, '$.label') AS label, provider, account, jobs.state,
        SUM(CASE WHEN job_steps.state = 'succeeded' THEN 1 ELSE 0 END) AS completedSteps,
        COUNT(job_steps.step_index) AS totalSteps, jobs.attempt_count AS attemptCount,
        reason, updated_at_ms AS updatedAtMs, json_extract(spec_json, '$.policy.mode') AS mode
      FROM jobs LEFT JOIN job_steps ON job_steps.job_id = jobs.id
      WHERE jobs.state IN ('ready', 'review', 'succeeded', 'failed')
      GROUP BY jobs.id ORDER BY updated_at_ms, jobs.id
    `).all().map(({ mode, ...row }) => ({ ...row, policy: { mode } }));
  }

  active(): Job[] {
    return this.storage.db.query<JobRow, []>("SELECT * FROM jobs WHERE state IN ('waiting', 'ready', 'running', 'review') ORDER BY created_at_ms, id").all().map((row) => this.fromRow(row));
  }

  setReadiness(id: string, ready: boolean, reason: string | null, now = Date.now()): Job {
    timestamp(now);
    reasonCode(reason);
    return this.storage.transaction(() => {
      const job = this.required(id, now);
      this.expect(job, ["waiting", "ready"]);
      const next = ready ? "ready" : "waiting";
      const nextReason = ready ? null : (reason ?? "quota-unavailable");
      // A repeated collector observation is not a state change and must not
      // invalidate an approval or make the public history look newly updated.
      if (job.state === next && job.reason === nextReason) return job;
      this.storage.db.query(`UPDATE jobs SET state = ?, reason = ?, updated_at_ms = ?,
        approved_at_ms = CASE WHEN ? = 1 THEN approved_at_ms ELSE NULL END,
        blocked_at_ms = ? WHERE id = ?`).run(next, nextReason, now, ready ? 1 : 0,
          ready ? job.blockedAtMs : (job.state === "ready" ? now : job.blockedAtMs ?? now), id);
      return this.required(id, now);
    });
  }

  approve(id: string, now = Date.now()): Job {
    timestamp(now);
    return this.storage.transaction(() => {
      const job = this.required(id, now);
      this.expect(job, ["ready"]);
      if (job.spec.policy.expiresAtMs <= now || job.attemptCount >= job.spec.policy.maxAttempts) {
        throw new JobStoreError("state-conflict", "job execution policy is exhausted");
      }
      this.storage.db.query("UPDATE jobs SET approved_at_ms = ?, updated_at_ms = ? WHERE id = ?").run(now, now, id);
      return this.required(id, now);
    });
  }

  /** Atomically reserves the next unfinished step and the entire account. */
  claim(id: string, now = Date.now()): JobClaim | null {
    timestamp(now);
    return this.storage.transaction(() => {
      this.recoverStale(now);
      const job = this.required(id, now);
      if (!["waiting", "ready"].includes(job.state)) return null;
      const policyReason = job.spec.policy.expiresAtMs <= now ? "policy-expired"
        : job.attemptCount >= job.spec.policy.maxAttempts ? "attempts-exhausted" : null;
      if (policyReason) {
        this.storage.db.query("UPDATE jobs SET state = 'failed', reason = ?, approved_at_ms = NULL, updated_at_ms = ? WHERE id = ?").run(policyReason, now, id);
        return null;
      }
      if (job.state !== "ready" || !job.approvalValid || (job.notBeforeMs !== null && job.notBeforeMs > now)) return null;
      // An expired worker may still exist. Review must resolve that uncertainty
      // before any new job can use this account, even after its lease is cleared.
      const occupied = this.storage.db.query<{ id: string }, [string, string]>(`
        SELECT id FROM jobs WHERE provider = ? AND account = ? AND (
          state = 'running' OR (state = 'review' AND EXISTS (
            SELECT 1 FROM job_steps WHERE job_id = jobs.id AND state = 'uncertain'
          ))) LIMIT 1`).get(job.spec.provider, job.spec.account);
      if (occupied) return null;
      const step = job.steps.find((candidate) => candidate.state !== "succeeded");
      if (!step || !["pending", "blocked"].includes(step.state)) return null;
      const token = randomUUID();
      this.storage.db.query(`UPDATE jobs SET state = 'running', claim_token = ?, lease_at_ms = ?,
        active_step_index = ?, attempt_count = attempt_count + 1, updated_at_ms = ?, reason = NULL,
        blocked_at_ms = NULL, not_before_ms = NULL WHERE id = ? AND state = 'ready'`).run(token, now, step.index, now, id);
      this.storage.db.query("UPDATE job_steps SET state = 'running', attempt_count = attempt_count + 1 WHERE job_id = ? AND step_index = ?").run(id, step.index);
      const claimed = this.required(id, now);
      return { token, job: claimed, step: claimed.steps[step.index]! };
    });
  }

  heartbeat(token: string, now = Date.now()): boolean {
    timestamp(now);
    return this.storage.db.query(`UPDATE jobs SET lease_at_ms = ? WHERE state = 'running'
      AND claim_token = ? AND lease_at_ms > ?`).run(now, token, now - JOB_LEASE_MS).changes === 1;
  }

  /** Release a live reservation only when the provider has not started executing. */
  defer(token: string, reason: string, now = Date.now()): Job {
    timestamp(now);
    reasonCode(reason);
    return this.storage.transaction(() => {
      const row = this.storage.db.query<JobRow, [string, number]>(
        "SELECT * FROM jobs WHERE claim_token = ? AND state = 'running' AND lease_at_ms > ?",
      ).get(token, now - JOB_LEASE_MS);
      if (!row || row.active_step_index === null) throw new JobStoreError("claim-conflict", "execution claim is absent or expired");
      const step = this.storage.db.query(`UPDATE job_steps SET state = 'pending', attempt_count = attempt_count - 1
        WHERE job_id = ? AND step_index = ? AND state = 'running' AND attempt_count > 0`)
        .run(row.id, row.active_step_index);
      if (step.changes !== 1) throw new JobStoreError("claim-conflict", "execution step no longer belongs to this claim");
      const job = this.storage.db.query(`UPDATE jobs SET state = 'waiting', reason = ?, updated_at_ms = ?,
        blocked_at_ms = ?, not_before_ms = NULL, attempt_count = attempt_count - 1,
        approved_at_ms = NULL, claim_token = NULL, lease_at_ms = NULL, active_step_index = NULL
        WHERE id = ? AND claim_token = ? AND state = 'running' AND attempt_count > 0 AND lease_at_ms > ?`)
        .run(reason, now, now, row.id, token, now - JOB_LEASE_MS);
      if (job.changes !== 1) throw new JobStoreError("claim-conflict", "execution claim is absent or expired");
      return this.required(row.id, now);
    });
  }

  finish(token: string, outcome: JobFinish, now = Date.now()): Job {
    timestamp(now);
    if (!["succeeded", "quota", "failed", "uncertain"].includes(outcome.outcome)) invalid("invalid execution outcome");
    reasonCode(outcome.reason ?? null);
    if (outcome.output !== undefined && (typeof outcome.output !== "string" || Buffer.byteLength(outcome.output) > MAX_TEXT_BYTES)) invalid("result exceeds 1 MiB");
    if (outcome.sessionId !== undefined) text(outcome.sessionId, "session ID", 200);
    if (outcome.retryAtMs !== undefined) timestamp(outcome.retryAtMs);
    return this.storage.transaction(() => {
      const row = this.storage.db.query<JobRow, [string, number]>("SELECT * FROM jobs WHERE claim_token = ? AND state = 'running' AND lease_at_ms > ?").get(token, now - JOB_LEASE_MS);
      if (!row || row.active_step_index === null) throw new JobStoreError("claim-conflict", "execution claim is absent or expired");
      const succeeded = outcome.outcome === "succeeded";
      const spec = JSON.parse(row.spec_json) as JobSpec;
      const retrySafe = spec.steps[row.active_step_index]?.retrySafe === true;
      const uncertain = outcome.outcome === "uncertain" || (outcome.outcome === "quota" && !retrySafe);
      const stepState: JobStepState = succeeded ? "succeeded" : uncertain ? "uncertain" : outcome.outcome === "quota" ? "blocked" : "failed";
      this.storage.db.query(`UPDATE job_steps SET state = ?, result = ?, native_session_id = COALESCE(?, native_session_id)
        WHERE job_id = ? AND step_index = ?`).run(stepState, outcome.output ?? null, outcome.sessionId ?? null, row.id, row.active_step_index);
      const remaining = this.storage.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM job_steps WHERE job_id = ? AND state != 'succeeded'").get(row.id)!.count;
      const state: JobState = succeeded ? (remaining === 0 ? "succeeded" : "ready")
        : uncertain ? "review" : outcome.outcome === "quota" ? "waiting" : "failed";
      const reason = succeeded ? null : (outcome.outcome === "quota" && !retrySafe ? "quota-retry-review" :
        outcome.reason ?? (outcome.outcome === "quota" ? "quota-exhausted" : outcome.outcome === "uncertain" ? "execution-uncertain" : "execution-failed"));
      this.storage.db.query(`UPDATE jobs SET state = ?, reason = ?, updated_at_ms = ?,
        blocked_at_ms = ?, not_before_ms = ?, approved_at_ms = CASE WHEN ? = 1 THEN approved_at_ms ELSE NULL END,
        claim_token = NULL, lease_at_ms = NULL, active_step_index = NULL
        WHERE id = ? AND claim_token = ?`).run(state, reason, now, outcome.outcome === "quota" ? now : null,
          outcome.outcome === "quota" ? (outcome.retryAtMs ?? null) : null, succeeded && remaining > 0 ? 1 : 0, row.id, token);
      return this.required(row.id, now);
    });
  }

  recoverStale(now = Date.now()): number {
    timestamp(now);
    return this.storage.transaction(() => {
      const rows = this.storage.db.query<JobRow, [number]>("SELECT * FROM jobs WHERE state = 'running' AND lease_at_ms <= ?").all(now - JOB_LEASE_MS);
      for (const row of rows) {
        this.storage.db.query("UPDATE job_steps SET state = 'uncertain' WHERE job_id = ? AND step_index = ? AND state = 'running'").run(row.id, row.active_step_index);
        this.storage.db.query(`UPDATE jobs SET state = 'review', reason = 'lease-expired', updated_at_ms = ?,
          approved_at_ms = NULL, claim_token = NULL, lease_at_ms = NULL, active_step_index = NULL WHERE id = ?`).run(now, row.id);
      }
      return rows.length;
    });
  }

  cancel(id: string, now = Date.now()): Job {
    timestamp(now);
    return this.storage.transaction(() => {
      const job = this.required(id, now);
      this.expect(job, ["waiting", "ready", "review", "failed"]);
      this.storage.db.query("UPDATE jobs SET state = 'cancelled', reason = 'user-cancelled', approved_at_ms = NULL, updated_at_ms = ? WHERE id = ?").run(now, id);
      return this.required(id, now);
    });
  }

  /** Caller must obtain explicit review of possible duplicate side effects. */
  resolveReview(id: string, now = Date.now()): Job {
    timestamp(now);
    return this.storage.transaction(() => {
      const job = this.required(id, now);
      this.expect(job, ["review"]);
      this.storage.db.query("UPDATE job_steps SET state = 'pending' WHERE job_id = ? AND state = 'uncertain'").run(id);
      this.storage.db.query(`UPDATE jobs SET state = 'waiting', reason = 'review-retry-requested', updated_at_ms = ?,
        approved_at_ms = NULL, not_before_ms = NULL WHERE id = ?`).run(now, id);
      return this.required(id, now);
    });
  }

  /** Explicit, one-time import; legacy failures are never counted as completed. */
  importCompleted(id: string, completed: Record<string, unknown>, runKey: string, now = Date.now()): Job {
    timestamp(now);
    const entries = Object.entries(record(completed, "legacy completed"));
    return this.storage.transaction(() => {
      const row = this.storage.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
      if (!row) throw new JobStoreError("not-found", "job not found");
      const job = this.fromRow(row, now);
      if (job.spec.key !== runKey) throw new JobStoreError("key-conflict", "legacy run ID does not match job key");
      if (row.attempt_count !== 0 || row.approved_at_ms !== null || row.imported_at_ms !== null || row.state !== "waiting") {
        throw new JobStoreError("state-conflict", "legacy import requires a new, unapproved job");
      }
      let failed = false;
      for (const [stepKey, value] of entries) {
        const step = job.steps.find((item) => item.key === stepKey);
        if (!step) invalid("legacy checkpoint contains an unknown step key");
        const result = JSON.stringify(value);
        if (result === undefined || Buffer.byteLength(result) > MAX_TEXT_BYTES) invalid("invalid legacy result");
        const isError = value !== null && typeof value === "object" && Object.hasOwn(value, "error");
        failed ||= isError;
        this.storage.db.query("UPDATE job_steps SET state = ?, result = ? WHERE job_id = ? AND step_index = ?")
          .run(isError ? "failed" : "succeeded", result, id, step.index);
      }
      const state = failed ? "failed" : entries.length === job.steps.length ? "succeeded" : "waiting";
      this.storage.db.query("UPDATE jobs SET state = ?, reason = ?, imported_at_ms = ?, updated_at_ms = ? WHERE id = ?")
        .run(state, failed ? "legacy-step-failed" : null, now, now, id);
      return this.required(id, now);
    });
  }

  private required(id: string, now = Date.now()): Job {
    const job = this.get(id, now);
    if (!job) throw new JobStoreError("not-found", "job not found");
    return job;
  }
  private expect(job: Job, states: JobState[]): void {
    if (!states.includes(job.state)) throw new JobStoreError("state-conflict", `job is ${job.state}; expected ${states.join(" or ")}`);
  }
  private fromRow(row: JobRow, now = Date.now()): Job {
    const spec = JSON.parse(row.spec_json) as JobSpec;
    const steps: JobStep[] = this.storage.db.query<StepRow, [string]>("SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_index").all(row.id).map((step) => ({
      key: step.step_key, index: step.step_index, state: step.state, result: step.result,
      nativeSessionId: step.native_session_id, attemptCount: step.attempt_count,
    }));
    return {
      id: row.id, spec, state: row.state, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms,
      blockedAtMs: row.blocked_at_ms, notBeforeMs: row.not_before_ms, reason: row.reason,
      attemptCount: row.attempt_count,
      approvalValid: ["ready", "running"].includes(row.state) && spec.policy.expiresAtMs > now
        && (spec.policy.mode === "auto" || row.approved_at_ms !== null),
      steps,
    };
  }
}
