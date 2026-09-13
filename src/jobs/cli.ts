import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import type { QuotaPieService } from "../service";
import { validateJobSpec } from "../storage/job-store";
import { jobProfile } from "./runner";

const MAX_MANIFEST_BYTES = 1024 * 1024;
export function readJobJSON(path: string): unknown {
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) throw new Error("job file must be a regular file of at most 1 MiB");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("job file exceeds 1 MiB");
    return JSON.parse(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}

const HELP = `quotapie jobs — persistent, quota-aware batch jobs

  jobs add MANIFEST.json [--allow-auto] [--checkpoint LEGACY.json]
  jobs list
  jobs show UUID [--include-content]
  jobs approve UUID
  jobs retry UUID --retry-reviewed
  jobs cancel UUID
  jobs export UUID --output FILE.json
  jobs work --once

Registration saves the manifest's prompts locally. Auto mode requires --allow-auto.
Review the manifest before approving. watch/serve dispatch authorized jobs after fresh quota checks.
Each step owns a new provider session; existing interactive sessions are never attached implicitly.
retry requires review of possible side effects. Completed steps are never replayed.
`;

function required(args: string[], at: number): string {
  const value = args[at];
  if (!value || value.startsWith("--")) throw new Error(HELP);
  return value;
}
function option(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index < 0 ? undefined : required(args, index + 1);
}

export async function runJobsCommand(args: string[], service: QuotaPieService): Promise<number> {
  const action = args[0] ?? "help";
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const summary = (id: string) => {
    const result = service.jobs.summaries(500).find(j => j.id === id);
    if (!result) throw new Error("job not found");
    return result;
  };
  switch (action) {
    case "help": console.log(HELP); return 0;
    case "add": {
      const spec = validateJobSpec(readJobJSON(required(args, 1)));
      if (spec.policy.mode === "auto" && !args.includes("--allow-auto")) {
        throw new Error("auto mode requires explicit --allow-auto after reviewing this manifest");
      }
      if (spec.policy.mode === "auto" && !spec.model) throw new Error("auto mode requires an explicit model in the manifest");
      spec.cwd = realpathSync(spec.cwd);
      spec.profileKey = jobProfile(service.config, spec).key;
      const checkpointPath = option(args, "--checkpoint");
      const job = service.storage.transaction(() => {
        const job = service.jobs.submit(spec);
        if (checkpointPath) {
          const input = readJobJSON(checkpointPath) as Record<string, unknown>;
          if (!input || input.run_id !== spec.key || !input.completed || typeof input.completed !== "object" ||
              Array.isArray(input.completed) || !Array.isArray(input.pending)) throw new Error("legacy checkpoint does not match this job");
          const known = new Set(spec.steps.map(s => s.key));
          const completed = input.completed as Record<string, unknown>;
          const pending = input.pending as unknown[];
          const all = [...Object.keys(completed), ...pending];
          if (all.some(key => typeof key !== "string" || !known.has(key)) || new Set(all).size !== all.length || all.length !== known.size) {
            throw new Error("legacy checkpoint step keys do not match this manifest");
          }
          const results: Record<string, unknown> = Object.create(null);
          for (const [key, entry] of Object.entries(completed)) {
            if (!entry || typeof entry !== "object" || !("result" in entry)) throw new Error("invalid legacy completed entry");
            results[key] = (entry as { result: unknown }).result;
          }
          service.jobs.importCompleted(job.id, results, spec.key);
        }
        return job;
      });
      print(summary(job.id));
      return 0;
    }
    case "list": print(service.jobs.summaries()); return 0;
    case "show": {
      const id = required(args, 1);
      if (args.includes("--include-content")) {
        const job = service.jobs.get(id);
        if (!job) throw new Error("job not found");
        print(job);
      } else print(summary(id));
      return 0;
    }
    case "approve": {
      const id = required(args, 1);
      service.jobRunner.evaluate(service.analyses());
      service.jobs.approve(id);
      print(summary(id));
      return 0;
    }
    case "retry": {
      if (!args.includes("--retry-reviewed")) throw new Error("review the previous attempt, then pass --retry-reviewed to permit replay");
      const id = required(args, 1);
      service.jobs.resolveReview(id);
      print(summary(id));
      return 0;
    }
    case "cancel": {
      const id = required(args, 1);
      service.jobs.cancel(id);
      print(summary(id));
      return 0;
    }
    case "export": {
      const job = service.jobs.get(required(args, 1));
      if (!job) throw new Error("job not found");
      const path = option(args, "--output");
      if (!path) throw new Error("export requires --output FILE.json (contains prompts and results)");
      const fd = openSync(resolve(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, job }, null, 2)); } finally { closeSync(fd); }
      chmodSync(resolve(path), 0o600);
      print({ exported: resolve(path) });
      return 0;
    }
    case "work": {
      if (!args.includes("--once")) throw new Error("use jobs work --once, or quotapie watch for continuous collection and execution");
      const { windows } = await service.tick();
      service.jobRunner.tick(windows);
      await service.jobRunner.settle();
      await service.deliverJobNotifications();
      print(service.jobs.summaries());
      return 0;
    }
    default: throw new Error(HELP);
  }
}
