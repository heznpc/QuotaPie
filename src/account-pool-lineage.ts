import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export type CodexForkParentResult =
  | { status: "known"; parentId: string | null }
  | { status: "unknown" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_METADATA_BYTES = 1024 * 1024;

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

// Reads only the first, bounded session_meta record. Never scan conversation
// entries, and do not cache absence: a new thread may still be flushing its DB
// row or rollout metadata when its first request reaches the relay.
export function readCodexForkParent(codexHome: string, threadId: string): CodexForkParentResult {
  if (!UUID.test(threadId)) return { status: "unknown" };
  let db: Database | undefined;
  let fd: number | undefined;
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
    if (!row || typeof row.rollout_path !== "string" || !isAbsolute(row.rollout_path)) return { status: "unknown" };
    const path = realpathSync(row.rollout_path);
    if (!within(root, path)) return { status: "unknown" };
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { status: "unknown" };
    const chunks: Buffer[] = [];
    let total = 0, complete = false;
    while (total < MAX_METADATA_BYTES) {
      const chunk = Buffer.alloc(Math.min(8192, MAX_METADATA_BYTES - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const newline = chunk.subarray(0, count).indexOf(10);
      chunks.push(chunk.subarray(0, newline >= 0 ? newline : count));
      total += count;
      if (newline >= 0) { complete = true; break; }
    }
    // A newline is the writer's evidence that the record was fully flushed.
    if (!complete) return { status: "unknown" };
    const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
    const base = meta.history_base?.thread_id;
    if (base != null && (typeof base !== "string" || base.toLowerCase() !== parent.toLowerCase()))
      return { status: "unknown" };
    return { status: "known", parentId: parent.toLowerCase() };
  } catch {
    return { status: "unknown" };
  } finally {
    if (fd !== undefined) closeSync(fd);
    db?.close();
  }
}
