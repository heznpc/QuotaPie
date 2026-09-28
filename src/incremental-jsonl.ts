import { open } from "node:fs/promises";

interface Cursor<T> {
  identity: string;
  offset: number;
  mtime: number;
  ctime: number;
  partial: Buffer;
  discardLine: boolean;
  records: Map<string, T>;
}

// Keep only projected metadata; never retain raw request bodies or whole logs.
export class IncrementalJsonlReader<T> {
  private cursors = new Map<string, Cursor<T>>();
  constructor(private parse: (value: unknown) => T | null,
    private key: (value: T) => string, private maxBytes = 2_000_000,
    private maxRecords = 2000) {}

  retain(paths: Set<string>): void {
    for (const path of this.cursors.keys()) if (!paths.has(path)) this.cursors.delete(path);
  }

  async read(path: string): Promise<T[]> {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      let cursor = this.cursors.get(path);
      const unchanged = cursor && cursor.identity === identity && cursor.offset === stat.size
        && cursor.mtime === stat.mtimeMs && cursor.ctime === stat.ctimeMs;
      if (cursor && unchanged) return [...cursor.records.values()];
      if (!cursor || cursor.identity !== identity || stat.size <= cursor.offset
          || stat.size - cursor.offset > this.maxBytes) {
        const offset = Math.max(0, stat.size - this.maxBytes);
        cursor = { identity, offset, mtime: 0, ctime: 0, partial: Buffer.alloc(0),
          discardLine: offset > 0, records: new Map() };
      }
      const buffer = Buffer.alloc(Math.min(this.maxBytes, stat.size - cursor.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
      const data = Buffer.concat([cursor.partial, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        if (cursor.discardLine) cursor.discardLine = false;
        else {
          try {
            const value = this.parse(JSON.parse(data.subarray(start, end).toString("utf8")));
            if (value) {
              const key = this.key(value);
              cursor.records.delete(key);
              cursor.records.set(key, value);
              while (cursor.records.size > this.maxRecords) cursor.records.delete(cursor.records.keys().next().value!);
            }
          } catch { /* Ignore malformed complete lines, retain split lines below. */ }
        }
        start = end + 1;
      }
      cursor.partial = Buffer.from(data.subarray(start));
      if (cursor.partial.length > this.maxBytes) {
        cursor.partial = Buffer.alloc(0);
        cursor.discardLine = true;
      }
      cursor.offset += bytesRead;
      cursor.mtime = stat.mtimeMs;
      cursor.ctime = stat.ctimeMs;
      this.cursors.set(path, cursor);
      return [...cursor.records.values()];
    } finally { await file.close(); }
  }
}
