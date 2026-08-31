import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { CodexThreadListPage, CodexThreadListParams } from "./providers/codex-appserver";
import type { Provider } from "./types";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeSessionId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SESSION_UUID.test(normalized)) {
    throw new Error("session must be a UUID in 8-4-4-4-12 form");
  }
  return normalized;
}

export function resumeTaskKey(provider: Provider, account: string, nativeId: string): string {
  return createHash("sha256")
    .update(provider)
    .update("\0")
    .update(account)
    .update("\0")
    .update(normalizeSessionId(nativeId))
    .digest("hex");
}

export interface SessionResumeTarget {
  nativeId: string;
  cwd: string;
  name: string | null;
}

export interface CodexThreadLister {
  listThreads(params?: CodexThreadListParams): Promise<CodexThreadListPage>;
}

export async function findCodexResumeTarget(
  client: CodexThreadLister,
  account: string,
  taskKey: string,
): Promise<SessionResumeTarget | null> {
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await client.listThreads({
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived,
        // Do not let discovery invoke Codex's JSONL scan-and-repair path. The
        // provider-owned state DB is sufficient and keeps QuotaPie read-only.
        useStateDbOnly: true,
      });
      for (const thread of page.data) {
        let key: string;
        try {
          key = resumeTaskKey("codex", account, thread.id);
        } catch {
          continue;
        }
        if (key === taskKey) {
          return {
            nativeId: normalizeSessionId(thread.id),
            cwd: thread.cwd,
            name: thread.name,
          };
        }
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) {
        throw new Error("Codex App Server repeated a thread/list cursor");
      }
      if (cursor) seen.add(cursor);
    } while (cursor != null);
  }
  return null;
}

interface StringToken {
  raw: string;
  end: number;
}

function stringTokenAt(input: string, start: number): StringToken | null {
  if (input[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return { raw: input.slice(start, index + 1), end: index + 1 };
  }
  return null;
}

function whitespaceEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index]!)) index += 1;
  return index;
}

// Extracts allow-listed top-level strings without JSON.parse-ing message or
// prompt values. Claude JSONL entries can be very large; content remains an
// opaque span that this scanner only skips over.
export function claudeMetadataFromLine(line: string): {
  sessionId?: string;
  cwd?: string;
  customTitle?: string;
} {
  const result: { sessionId?: string; cwd?: string; customTitle?: string } = {};
  const allowed = new Set(["sessionId", "cwd", "customTitle"]);
  let index = whitespaceEnd(line, 0);
  if (line[index] !== "{") return result;
  index += 1;
  while (index < line.length) {
    index = whitespaceEnd(line, index);
    if (line[index] === "}") break;
    const keyToken = stringTokenAt(line, index);
    if (!keyToken) break;
    let key: string;
    try {
      key = JSON.parse(keyToken.raw) as string;
    } catch {
      break;
    }
    index = whitespaceEnd(line, keyToken.end);
    if (line[index] !== ":") break;
    index = whitespaceEnd(line, index + 1);
    const valueStart = index;
    if (line[index] === '"') {
      const valueToken = stringTokenAt(line, index);
      if (!valueToken) break;
      if (allowed.has(key)) {
        try {
          const value = JSON.parse(valueToken.raw) as string;
          if (key === "sessionId") result.sessionId = value;
          else if (key === "cwd") result.cwd = value;
          else result.customTitle = value;
        } catch {
          // Ignore malformed metadata without ever falling back to parsing the
          // complete record.
        }
      }
      index = valueToken.end;
    } else {
      let depth = 0;
      let inString = false;
      let escaped = false;
      while (index < line.length) {
        const character = line[index]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
        } else if (character === '"') {
          inString = true;
        } else if (character === "{" || character === "[") {
          depth += 1;
        } else if (character === "}" || character === "]") {
          if (depth === 0) break;
          depth -= 1;
        } else if (character === "," && depth === 0) {
          break;
        }
        index += 1;
      }
      if (index === valueStart) break;
    }
    index = whitespaceEnd(line, index);
    if (line[index] === ",") index += 1;
    else if (line[index] === "}") break;
  }
  return result;
}

async function metadataForClaudeFile(
  path: string,
  expectedSessionId: string,
): Promise<{ cwd: string | null; name: string | null }> {
  let cwd: string | null = null;
  let name: string | null = null;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const metadata = claudeMetadataFromLine(line);
      if (metadata.sessionId != null) {
        try {
          if (normalizeSessionId(metadata.sessionId) !== expectedSessionId) continue;
        } catch {
          continue;
        }
      }
      if (typeof metadata.cwd === "string" && isAbsolute(metadata.cwd)) cwd = metadata.cwd;
      if (typeof metadata.customTitle === "string" && metadata.customTitle.trim()) {
        name = metadata.customTitle.trim();
      }
    }
  } finally {
    lines.close();
  }
  return { cwd, name };
}

export async function findClaudeResumeTarget(
  configDir: string,
  account: string,
  taskKey: string,
): Promise<SessionResumeTarget | null> {
  const projectsDir = resolve(configDir, "projects");
  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const project of projects.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!project.isDirectory()) continue;
    const projectDir = resolve(projectsDir, project.name);
    let files;
    try {
      files = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const candidateId = file.name.slice(0, -".jsonl".length);
      let normalized: string;
      try {
        normalized = normalizeSessionId(candidateId);
      } catch {
        continue;
      }
      if (resumeTaskKey("claude", account, normalized) !== taskKey) continue;
      const metadata = await metadataForClaudeFile(resolve(projectDir, file.name), normalized);
      if (!metadata.cwd) return null;
      return { nativeId: normalized, cwd: metadata.cwd, name: metadata.name };
    }
  }
  return null;
}

export async function resumeWorkingDirectoryAvailable(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
