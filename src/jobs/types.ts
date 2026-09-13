export type JobProvider = "codex" | "claude";
export type JobState = "waiting" | "ready" | "running" | "review" | "succeeded" | "failed" | "cancelled";
export type JobStepState = "pending" | "running" | "succeeded" | "blocked" | "failed" | "uncertain";

export interface JobSpec {
  version: 1;
  key: string;
  label: string;
  provider: JobProvider;
  account: string;
  cwd: string;
  buckets: string[];
  model?: string;
  /** SHA-256 of the configured profile root at registration; never a path. */
  profileKey?: string;
  steps: Array<{ key: string; prompt: string; retrySafe?: boolean }>;
  policy: { mode: "manual" | "auto"; expiresAtMs: number; maxAttempts: number };
}

export interface JobStep {
  key: string;
  index: number;
  state: JobStepState;
  result: string | null;
  nativeSessionId: string | null;
  attemptCount: number;
}

/** Private record. Never serialize this object into the public status API. */
export interface Job {
  id: string;
  spec: JobSpec;
  state: JobState;
  createdAtMs: number;
  updatedAtMs: number;
  blockedAtMs: number | null;
  notBeforeMs: number | null;
  reason: string | null;
  attemptCount: number;
  approvalValid: boolean;
  steps: JobStep[];
}

export interface JobSummary {
  id: string;
  key: string;
  label: string;
  provider: JobProvider;
  account: string;
  state: JobState;
  completedSteps: number;
  totalSteps: number;
  attemptCount: number;
  reason: string | null;
  updatedAtMs: number;
  policy: { mode: "manual" | "auto" };
}

export interface JobClaim {
  token: string;
  job: Job;
  step: JobStep;
}

export interface JobFinish {
  outcome: "succeeded" | "quota" | "failed" | "uncertain";
  output?: string;
  sessionId?: string;
  retryAtMs?: number;
  reason?: string;
}
