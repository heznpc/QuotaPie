import { Database } from "bun:sqlite";
import { constants, readdirSync, realpathSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createZstdDecompress, constants as zstd } from "node:zlib";
import { isAbsolute, join, relative, sep } from "node:path";

export type CodexForkParentResult =
  | { status: "known"; parentId: string | null }
  | { status: "missing" }
  | { status: "unknown" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;

async function firstRecord(file: FileHandle, compressed: boolean): Promise<string | null> {
  const source = file.createReadStream({ autoClose: false, highWaterMark: 8192,
    start: 0, end: (compressed ? MAX_COMPRESSED_BYTES : MAX_METADATA_BYTES) - 1 });
  const decoder = compressed ? createZstdDecompress({ chunkSize: 8192,
    params: { [zstd.ZSTD_d_windowLogMax]: 23 } }) : null;
  const stream = decoder ?? source;
  source.on("error", error => decoder?.destroy(error));
  const timer = setTimeout(() => stream.destroy(new Error("Metadata read timed out")), 2000);
  if (decoder) source.pipe(decoder);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const data of stream) {
      const chunk = Buffer.from(data);
      const newline = chunk.indexOf(10);
      const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      total += part.length;
      if (total >= MAX_METADATA_BYTES) return null;
      chunks.push(part);
      // Stop decoding here: later records are conversation content, not ancestry.
      if (newline >= 0) return Buffer.concat(chunks).toString("utf8");
    }
    return null;
  } finally {
    clearTimeout(timer);
    source.destroy();
    decoder?.destroy();
  }
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

// Reads only the first, bounded session_meta record. Never scan conversation
// entries, and do not cache absence: a new thread may still be flushing its DB
// row or rollout metadata when its first request reaches the relay.
export async function readCodexForkParent(codexHome: string, threadId: string): Promise<CodexForkParentResult> {
  if (!UUID.test(threadId)) return { status: "unknown" };
  let db: Database | undefined;
  let file: FileHandle | undefined;
  try {
    const root = realpathSync(codexHome);
    const name = readdirSync(root).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0];
    if (!name) return { status: "unknown" };
    const databasePath = realpathSync(join(root, name));
    if (!within(root, databasePath)) return { status: "unknown" };
    db = new Database(databasePath, { readonly: true, strict: true });
    const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id=?")
      .get(threadId.toLowerCase());
    if (!row) return { status: "missing" };
    if (typeof row.rollout_path !== "string" || !isAbsolute(row.rollout_path)) return { status: "unknown" };
    let candidate = row.rollout_path;
    let path: string;
    try { path = realpathSync(candidate); }
    catch (error: any) {
      // Codex can retain the original JSONL path after compressing its rollout.
      // Only absence permits fallback; a present partial/invalid file must fail closed.
      if (error?.code !== "ENOENT" || !candidate.endsWith(".jsonl")) throw error;
      candidate += ".zst";
      path = realpathSync(candidate);
    }
    if (!within(root, path)) return { status: "unknown" };
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return { status: "unknown" };
    const line = await firstRecord(file, candidate.endsWith(".zst"));
    if (line === null) return { status: "unknown" };
    const record = JSON.parse(line);
    const meta = record?.payload;
    if (record?.type !== "session_meta" || typeof meta?.id !== "string" ||
        meta.id.toLowerCase() !== threadId.toLowerCase()) return { status: "unknown" };
    const parent = meta.forked_from_id;
    if (parent == null) {
      // history_base can point at a pagination shard without any fork, while
      // parent_thread_id alone can describe a context-free agent.
      return { status: "known", parentId: null };
    }
    if (typeof parent !== "string" || !UUID.test(parent) || parent.toLowerCase() === threadId.toLowerCase())
      return { status: "unknown" };
    // history_base identifies a pagination shard, which can differ from the
    // logical parent thread. Only forked_from_id defines account ancestry.
    return { status: "known", parentId: parent.toLowerCase() };
  } catch {
    return { status: "unknown" };
  } finally {
    await file?.close();
    db?.close();
  }
}
