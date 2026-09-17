import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionPolicySettings } from "../src/compaction-policy-settings";
import { TaskSavingsSettings } from "../src/task-savings-settings";
import { DEFAULT_TASK_SAVINGS } from "../src/task-savings";

function relaySettings(port: number) {
  return { port, token: "ab".repeat(24),
    route: { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" },
    taskSavings: { ...DEFAULT_TASK_SAVINGS, enabled: true }, unrelated: "keep" };
}

function healthFetcher(paths: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const settings = JSON.parse(await readFile(paths[Number(new URL(String(url)).port) - 45000]!, "utf8"));
    // Keep overlapping reads in flight so uncoordinated writers see the same old value.
    await Bun.sleep(20);
    return Response.json({ service: "quotapie-compaction", schemaVersion: 3,
      savingsModelSupported: true, route: settings.route, taskSavings: settings.taskSavings });
  }) as typeof fetch;
}

test("concurrent compaction and savings changes preserve both updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-policy-race-"));
  try {
    const path = join(root, "settings.json");
    const original = relaySettings(45000);
    await writeFile(path, JSON.stringify(original));
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: path }));
    const fetcher = healthFetcher([path]);
    const [compaction, savings] = await Promise.all([
      new CompactionPolicySettings(root, fetcher).configure("gpt-5.6-terra"),
      new TaskSavingsSettings(root, fetcher).configure({ enabled: false }),
    ]);
    expect(compaction).toMatchObject({ model: "gpt-5.6-terra", applied: 1 });
    expect(savings).toMatchObject({ enabled: false, applied: 1 });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.route.to).toBe("gpt-5.6-terra");
    expect(saved.taskSavings.enabled).toBe(false);
    expect(saved.token).toBe(original.token);
    expect(saved.unrelated).toBe("keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configuration waits for the external manager and preserves its latest settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-manager-race-"));
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify(relaySettings(45000)));
  await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: path }));
  const manager = Bun.spawn(["python3", "-c", `import fcntl, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
with (root / "management.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    settings = json.loads((root / "settings.json").read_text())
    print("locked", flush=True)
    sys.stdin.buffer.read()
    settings["managerRevision"] = 2
    (root / "settings.json").write_text(json.dumps(settings))
`, root], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = manager.stdout.getReader();
  let update: Promise<unknown> | undefined;
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("locked\n");
    update = new CompactionPolicySettings(root, healthFetcher([path])).configure("gpt-5.6-terra");
    await Bun.sleep(80);
    manager.stdin.end();
    expect(await manager.exited).toBe(0);
    expect(await update).toMatchObject({ model: "gpt-5.6-terra", applied: 1 });
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.route.to).toBe("gpt-5.6-terra");
    expect(saved.managerRevision).toBe(2);
  } finally {
    manager.stdin.end();
    await manager.exited;
    await update?.catch(() => {});
    reader.releaseLock();
    await rm(root, { recursive: true, force: true });
  }
});

test("more than 32 generations remain readable and configurable despite stale retired files", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-many-generations-"));
  try {
    const paths: string[] = [];
    for (let i = 0; i < 33; i++) {
      const directory = join(root, "releases", String(i));
      await mkdir(directory, { recursive: true });
      const path = join(directory, "settings.json");
      await writeFile(path, JSON.stringify(relaySettings(45000 + i)));
      paths.push(path);
    }
    const corrupt = join(root, "settings.json");
    await writeFile(corrupt, "{");
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: paths[0],
      profile_settings: { "/profile/two": paths[1] },
      retired_settings: [...paths.slice(2), join(root, "releases/999/settings.json"), corrupt] }));
    const fetcher = healthFetcher(paths);
    const compaction = new CompactionPolicySettings(root, fetcher);
    const savings = new TaskSavingsSettings(root, fetcher);
    expect(await compaction.status()).toMatchObject({ generations: 33, configurable: true });
    expect(await savings.status()).toMatchObject({ generations: 33, compatible: 33 });
    expect(await compaction.configure("gpt-5.6-luna")).toMatchObject({ generations: 33, applied: 33 });
    expect(await savings.configure({ enabled: false })).toMatchObject({ generations: 33, applied: 33 });
    for (const path of paths) {
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.route.to).toBe("gpt-5.6-luna");
      expect(saved.taskSavings.enabled).toBe(false);
    }
    expect(await readFile(corrupt, "utf8")).toBe("{");
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: paths[0],
      profile_settings: { "/profile/two": join(root, "releases/999/settings.json") } }));
    expect(await compaction.status()).toBeNull();
    expect(await savings.status()).toBeNull();
    await expect(compaction.configure("gpt-5.6-terra")).rejects.toThrow("policy_update_failed");
    await expect(savings.configure({ enabled: true })).rejects.toThrow("savings_update_failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
