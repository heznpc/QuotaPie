import { createHash, randomUUID } from "node:crypto";
import { realpathSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { codexProfileRoot, dataDirectory, resolveUserPath, type AppConfig } from "./config";
import type { AccountState, ResumeTask } from "./types";

// Read-only integration, separate from the stable quota.json v2 overview.
// References identify observations; no capability, path, command or credential
// is exported. Consumers open QuotaPie to revalidate and approve any action.
export function profileReference(root: string): string | null {
  try { return createHash("sha256").update(realpathSync(root)).digest("hex"); }
  catch { return null; }
}

export function buildWorkBoundary(accounts: AccountState[], tasks: ResumeTask[], config: AppConfig, nowMs: number) {
  const visible = accounts.filter(a => a.enabled);
  return {
    schemaVersion: 1,
    generatedAtMs: nowMs,
    expiresAtMs: nowMs + 600_000,
    accounts: visible.map(account => {
      const profile = account.provider === "codex"
        ? config.accounts.codex.find(p => p.id === account.account)
        : config.accounts.claude.find(p => p.id === account.account);
      const root = profile && (account.provider === "codex"
        ? codexProfileRoot(profile as AppConfig["accounts"]["codex"][number])
        : resolveUserPath((profile as AppConfig["accounts"]["claude"][number]).configDir));
      return {
        provider: account.provider, account: account.account, label: account.accountLabel,
        profileKey: root ? profileReference(root) : null,
        collectionState: account.collection.health,
        windows: account.windows.map(window => ({
          bucket: window.bucket, label: window.label,
          remainingPercent: window.remainingPercent, resetsAtMs: window.resetsAtMs,
          observedAtMs: window.observedAtMs, freshness: window.freshness,
          validUntilMs: window.observedAtMs + config.collection.staleAfterSeconds * 1_000,
        })),
      };
    }),
    tasks: tasks.filter(task => ["waiting", "ready", "approved"].includes(task.state) && visible.some(a => a.provider === task.provider && a.account === task.account)).map(task => ({
      id: task.id, provider: task.provider, account: task.account, sessionKey: task.taskKey,
      bucket: task.bucket, label: task.projectLabel, state: task.state,
      registeredAtMs: task.registeredAtMs, readyAtMs: task.readyAtMs,
    })),
  };
}

export function defaultWorkBoundaryPath(): string {
  // An isolated CLI/data store must not replace the installed app's state.
  return dataDirectory() !== join(homedir(), ".local", "share", "quotapie")
    ? join(dataDirectory(), "work-state.json")
    : join(homedir(), "Library", "Application Support", "QuotaPie", "work-state.json");
}

export function writeWorkBoundary(document: ReturnType<typeof buildWorkBoundary>, path = defaultWorkBoundaryPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(document) + "\n");
    renameSync(temporary, path);
  } finally {
    closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}
