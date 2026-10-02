import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSavingsModelSupport } from "../src/savings-model-support";

const catalog = (effort: string) => JSON.stringify({ models: [{ slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort }] }] });

test("unchanged model catalogs parse once and content edits invalidate even with preserved mtime and size", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-model-capability-")), path = join(root, "models_cache.json");
  let reads = 0;
  const support = createSavingsModelSupport(path, path => { reads++; return readFileSync(path, "utf8"); });
  try {
    writeFileSync(path, catalog("low"));
    const before = statSync(path);
    for (let i = 0; i < 100; i++) expect(support()).toBe(true);
    expect(reads).toBe(1);
    writeFileSync(path, catalog("max"));
    utimesSync(path, before.atime, before.mtime);
    expect(statSync(path).size).toBe(before.size);
    expect(support()).toBe(false);
    expect(reads).toBe(2);
    writeFileSync(path + ".replacement", catalog("low"));
    utimesSync(path + ".replacement", before.atime, before.mtime);
    renameSync(path + ".replacement", path);
    expect(support()).toBe(true);
    expect(reads).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing or malformed model catalogs invalidate support and later valid contents recover", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-model-invalid-")), path = join(root, "models_cache.json");
  let reads = 0;
  const support = createSavingsModelSupport(path, path => { reads++; return readFileSync(path, "utf8"); });
  try {
    expect(support()).toBe(false);
    writeFileSync(path, catalog("low")); expect(support()).toBe(true);
    unlinkSync(path); expect(support()).toBe(false);
    writeFileSync(path, "{");
    expect(support()).toBe(false); expect(support()).toBe(false);
    expect(reads).toBe(2);
    writeFileSync(path, '{"models":[null,{"slug":"gpt-5.6-luna","supported_reasoning_levels":{}}]}');
    expect(support()).toBe(false);
    writeFileSync(path, catalog("low")); expect(support()).toBe(true);
    expect(reads).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
