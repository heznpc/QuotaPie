import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { codexUsesFileCredentials, resolveUserPath, type AppConfig } from "../config";
import { JobStore, JobStoreError } from "../storage/job-store";
import type { WindowAnalysis } from "../types";
import { executeJobStep } from "./executor";
import type { Job, JobSpec } from "./types";

export function jobProfile(config: AppConfig, spec: Pick<JobSpec, "provider" | "account">): {
  executable: string; root: string; key: string;
} {
  const profile = spec.provider === "codex"
    ? config.accounts.codex.find(p => p.enabled && p.id === spec.account)
    : config.accounts.claude.find(p => p.enabled && p.id === spec.account);
  if (!profile) throw new Error("account-unavailable");
  if ("keychainService" in profile && profile.keychainService) throw new Error("custom-credentials-unsupported");
  // Registration and the resident collector must agree even when a caller
  // happens to run inside another Codex profile.
  const configuredRoot = "codexHome" in profile
    ? resolveUserPath(profile.codexHome ?? "~/.codex") : resolveUserPath(profile.configDir);
  if (spec.provider === "codex" && "codexHome" in profile &&
      config.accounts.codex.filter(p => p.enabled).length > 1 && !codexUsesFileCredentials({ ...profile, codexHome: configuredRoot })) {
    throw new Error("account-isolation-required");
  }
  const root = realpathSync(configuredRoot);
  const executable = spec.provider === "codex" ? config.collection.codexCommand : "claude";
  if (basename(executable) !== spec.provider) throw new Error("executable-not-allowed");
  return { executable, root, key: createHash("sha256").update(root).digest("hex") };
}

/** Reset timestamps schedule observations; only measured available windows permit dispatch. */
export function jobCapacity(job: Job, windows: WindowAnalysis[], nowMs: number, maxAgeMs = Infinity): { ready: boolean; reason: string | null } {
  const account = windows.filter(w => w.provider === job.spec.provider && w.account === job.spec.account);
  const required = job.spec.buckets.map(bucket => account.find(w => w.bucket === bucket));
  // General account limits constrain every model, even when a manifest names a model lane.
  const all = [...required, ...account.filter(w => job.spec.provider === "codex"
    ? w.bucket.startsWith("codex:")
    : w.bucket === "five_hour" || w.bucket === "seven_day" ||
      (!job.spec.model || ["opus", "sonnet", "haiku"].some(name => job.spec.model!.toLowerCase().includes(name) && w.bucket.includes(name))))];
  if (all.some(w => !w || w.quality !== "authoritative" || w.freshness !== "fresh" ||
      (w.resetsAtMs != null && w.resetsAtMs <= nowMs) ||
      w.remainingPercent == null || w.observedAtMs > nowMs || nowMs - w.observedAtMs > maxAgeMs ||
      w.observedAtMs <= (job.blockedAtMs ?? job.createdAtMs))) {
    return { ready: false, reason: "quota-collection-wait" };
  }
  if (all.some(w => w!.remainingPercent! <= 0) || (job.notBeforeMs != null && nowMs < job.notBeforeMs)) {
    return { ready: false, reason: "quota-wait" };
  }
  return { ready: true, reason: null };
}

export interface JobRunnerDependencies {
  execute?: typeof executeJobStep;
  now?: () => number;
  changed?: () => void;
}

/** One runner per collector; SQLite claims arbitrate additional CLI/daemon processes. */
export class ManagedJobRunner {
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private windows: WindowAnalysis[] = [];
  private stopped = false;
  private readonly now: () => number;
  constructor(readonly store: JobStore, private readonly config: AppConfig, private readonly deps: JobRunnerDependencies = {}) {
    this.now = deps.now ?? Date.now;
  }

  evaluate(windows: WindowAnalysis[], nowMs = this.now()): void {
    this.windows = windows;
    this.store.recoverStale(nowMs);
    for (const job of this.store.active()) {
      if (job.state !== "waiting" && job.state !== "ready") continue;
      if (job.spec.policy.expiresAtMs <= nowMs || job.attemptCount >= job.spec.policy.maxAttempts) {
        this.store.claim(job.id, nowMs); // retires exhausted policies without dispatch
        continue;
      }
      let capacity = jobCapacity(job, windows, nowMs, this.config.collection.staleAfterSeconds * 1000);
      try {
        const profile = jobProfile(this.config, job.spec);
        if (!job.spec.profileKey || profile.key !== job.spec.profileKey) capacity = { ready: false, reason: "profile-changed" };
        if (!statSync(job.spec.cwd).isDirectory() || realpathSync(job.spec.cwd) !== job.spec.cwd) {
          capacity = { ready: false, reason: "workspace-unavailable" };
        }
      } catch {
        capacity = { ready: false, reason: "account-or-workspace-unavailable" };
      }
      try { this.store.setReadiness(job.id, capacity.ready, capacity.reason, nowMs); }
      catch (error) {
        if (!(error instanceof JobStoreError) || !["state-conflict", "not-found"].includes(error.kind)) throw error;
      }
    }
  }

  tick(windows: WindowAnalysis[], nowMs = this.now()): void {
    if (this.stopped) return;
    this.evaluate(windows, nowMs);
    if (this.running) return;
    for (const job of this.store.active()) {
      if (job.state !== "ready") continue;
      const claim = this.store.claim(job.id, nowMs);
      if (!claim) continue;
      this.controller = new AbortController();
      const controller = this.controller;
      this.running = (async () => {
        const heartbeat = setInterval(() => {
          try { if (!this.store.heartbeat(claim.token, this.now())) controller.abort(); }
          catch { controller.abort(); }
        }, 15_000);
        let executionStarted = false;
        try {
          const profile = jobProfile(this.config, claim.job.spec);
          if (profile.key !== claim.job.spec.profileKey ||
              !statSync(claim.job.spec.cwd).isDirectory() || realpathSync(claim.job.spec.cwd) !== claim.job.spec.cwd ||
              !jobCapacity(claim.job, this.windows, this.now(), this.config.collection.staleAfterSeconds * 1000).ready) {
            this.store.defer(claim.token, "dispatch-precondition-changed", this.now());
            return;
          }
          const step = claim.job.spec.steps[claim.step.index]!;
          executionStarted = true;
          const result = await (this.deps.execute ?? executeJobStep)({
            provider: claim.job.spec.provider, executable: profile.executable,
            profileRoot: profile.root, cwd: claim.job.spec.cwd, prompt: step.prompt,
            model: claim.job.spec.model, sessionId: claim.step.nativeSessionId, signal: controller.signal,
          });
          // An unscoped 429 with positive subscription windows does not establish
          // which allowance must recover. Do not spin on a still-positive reading.
          const mappedQuota = jobCapacity(claim.job, this.windows, this.now(),
            this.config.collection.staleAfterSeconds * 1000).reason === "quota-wait";
          const unknownQuota = result.kind === "quota" && result.retryAtMs == null && !mappedQuota;
          const outputTooLarge = result.output != null && Buffer.byteLength(result.output) > 1_048_576;
          const output = outputTooLarge
            ? Buffer.from(result.output!).subarray(0, 1_048_400).toString("utf8") + "\n[QuotaPie: output truncated; inspect the provider session for the complete result.]"
            : result.output;
          this.store.finish(claim.token, {
            outcome: unknownQuota || outputTooLarge ? "uncertain" : result.kind,
            output, sessionId: result.sessionId, retryAtMs: result.retryAtMs,
            reason: outputTooLarge ? "result-limit" : unknownQuota ? "quota-scope-unconfirmed" : result.reason,
          }, this.now());
        } catch {
          // A provider may already have performed work. An exception is not permission to replay it.
          try {
            if (executionStarted) this.store.finish(claim.token, { outcome: "uncertain", reason: "execution-uncertain" }, this.now());
            else this.store.defer(claim.token, "dispatch-precondition-changed", this.now());
          } catch { /* lost claim remains fenced */ }
        } finally {
          clearInterval(heartbeat);
          try { this.deps.changed?.(); } catch { /* notification delivery is retried by the collector */ }
        }
      })().finally(() => { this.running = null; this.controller = null; });
      break;
    }
  }

  async settle(): Promise<void> { await this.running; }
  async close(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.running;
  }
}
