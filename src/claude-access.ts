import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./config";

export interface ClaudeAccessSummary { organizationName?: string; role?: string; email?: string }
export interface ClaudeAccessCheck {
  id: "profile" | "quota" | "resets" | "conversations" | "projects" | "organizationProjects" | "sharedProjects" | "projectKnowledge" | "sessions" | "codeConnections" | "connectors" | "administration" | "billing";
  result: "available" | "empty" | "not-exposed";
  source: "api" | "app";
  observedAtMs: number;
  count?: number;
  detail?: string;
}
export interface ClaudeAccessReport extends ClaudeAccessSummary {
  identity: string; observedAtMs: number; checks: ClaudeAccessCheck[];
}
export function accessSummary(value: unknown): ClaudeAccessSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ClaudeAccessSummary = {};
  for (const key of ["organizationName", "role", "email"] as const) {
    const v = (value as any)[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v)) result[key] = v;
  }
  return result;
}
const ids = new Set(["profile", "quota", "resets", "conversations", "projects", "organizationProjects", "sharedProjects", "projectKnowledge", "sessions", "codeConnections", "connectors", "administration", "billing"]);
function validChecks(value: unknown): value is ClaudeAccessCheck[] {
  return Array.isArray(value) && value.length <= ids.size && new Set(value.map(v => v?.id)).size === value.length && value.every(v =>
    v && ids.has(v.id) && ["available", "empty", "not-exposed"].includes(v.result) && ["api", "app"].includes(v.source) &&
    Number.isSafeInteger(v.observedAtMs) && v.observedAtMs > 0 && (v.count == null || Number.isSafeInteger(v.count) && v.count >= 0) &&
    (v.detail == null || typeof v.detail === "string" && v.detail.length <= 500 && !/[\x00-\x1f\x7f-\x9f]/.test(v.detail)));
}
const file = (identity: string, root: string) => {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("invalid_claude_access_identity");
  return join(root, "claude-access", identity + ".json");
};
export function readClaudeAccess(identity: string, root = dataDirectory()): ClaudeAccessReport | undefined {
  try {
    const path = file(identity, root); if (!existsSync(path)) return;
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (v.schemaVersion !== 1 || v.identity !== identity || !Number.isSafeInteger(v.observedAtMs) || v.observedAtMs <= 0 || !validChecks(v.checks)) return;
    return { ...accessSummary(v), identity, observedAtMs: v.observedAtMs, checks: v.checks.map(({id,result,source,observedAtMs,count,detail}: ClaudeAccessCheck) =>
      ({id,result,source,observedAtMs,...(count == null ? {} : {count}),...(detail == null ? {} : {detail})})) };
  } catch { return; }
}
export function saveClaudeAccess(report: ClaudeAccessReport, root = dataDirectory()) {
  if (!validChecks(report.checks) || !Number.isSafeInteger(report.observedAtMs) || report.observedAtMs <= 0) throw new Error("invalid_claude_access_report");
  const path = file(report.identity, root), folder = join(root, "claude-access");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, "." + randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify({schemaVersion: 1, ...accessSummary(report), identity: report.identity,
    observedAtMs: report.observedAtMs, checks: report.checks}) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
