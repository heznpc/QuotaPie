import { expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncrementalJsonlReader } from "../src/incremental-jsonl";

test("unchanged history is not reparsed; split UTF-8 append, truncation and rotation remain readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "incremental-jsonl-"));
  const path = join(root, "relay.log");
  let parsed = 0;
  const reader = new IncrementalJsonlReader<{id:string, text:string}>(value => {
    parsed++; return value as {id:string, text:string};
  }, value => value.id);
  try {
    await writeFile(path, '{"id":"a","text":"old"}\n');
    expect(await reader.read(path)).toHaveLength(1);
    for (let i = 0; i < 5; i++) await reader.read(path);
    expect(parsed).toBe(1);
    const bytes = Buffer.from('{"id":"b","text":"한글"}\n');
    const split = bytes.indexOf(Buffer.from("한")) + 1;
    await appendFile(path, bytes.subarray(0, split));
    expect(await reader.read(path)).toHaveLength(1);
    await appendFile(path, bytes.subarray(split));
    expect((await reader.read(path))[1]?.text).toBe("한글");
    expect(parsed).toBe(2);
    await writeFile(path, '{"id":"c","text":"new"}\n');
    expect((await reader.read(path)).map(x => x.id)).toEqual(["c"]);
    await rename(path, path + ".old");
    await writeFile(path, '{"id":"d","text":"rotated"}\n');
    expect((await reader.read(path)).map(x => x.id)).toEqual(["d"]);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test("bounds initial reads and retained metadata, skips an oversized line", async () => {
  const root = await mkdtemp(join(tmpdir(), "incremental-jsonl-bounded-"));
  const path = join(root, "relay.log");
  const reader = new IncrementalJsonlReader<{id:string}>(x => x as {id:string}, x => x.id, 128, 2);
  try {
    await writeFile(path, 'x'.repeat(300) + '\n{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    expect((await reader.read(path)).map(x => x.id)).toEqual(["b", "c"]);
    await appendFile(path, '{"id":"b"}\n');
    expect((await reader.read(path)).map(x => x.id)).toEqual(["c", "b"]);
  } finally { await rm(root, {recursive:true, force:true}); }
});
