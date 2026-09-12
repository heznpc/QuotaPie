import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, relative } from "node:path";
import { validateCompactionRoute, type CompactionRoute } from "./codex-compaction-policy";

export const COMPACTION_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"];

export async function relayHealth(settings: any, fetcher: typeof fetch) {
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535 ||
      !/^[a-f0-9]{48}$/.test(settings.token)) throw new Error("relay_unavailable");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("relay_unavailable")); }, 1500);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetcher(`http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex/quotapie-health`,
        { redirect: "error", signal: controller.signal });
      const health = await response.json() as any;
      if (!response.ok || health.service !== "quotapie-compaction") throw new Error("relay_unavailable");
      return health;
    })()]);
  } finally { clearTimeout(timer!); controller.abort(); }
}

export class CompactionPolicySettings {
  private busy = false;
  constructor(private root: string, private fetcher: typeof fetch = fetch) {}

  private async paths() {
    const manifest = JSON.parse(await readFile(join(this.root, "current.json"), "utf8"));
    const paths = [...new Set<string>([manifest.settings_path, ...(manifest.retired_settings ?? [])])];
    if (!paths.length || paths.length > 32) throw new Error("invalid_installation");
    for (const path of paths) {
      if (typeof path !== "string" || !/^(?:settings\.json|releases\/\d+\/settings\.json)$/.test(relative(resolve(this.root), resolve(path)))) {
        throw new Error("invalid_installation");
      }
    }
    return paths;
  }

  private async inspect(healthByPath?: Map<string, any>) {
    const paths = await this.paths();
    const realRoot = await realpath(this.root);
    return Promise.all(paths.map(async (path, index) => {
      if (await realpath(path) !== join(realRoot, relative(resolve(this.root), resolve(path)))) throw new Error("invalid_installation");
      const raw = await readFile(path, "utf8");
      const settings = JSON.parse(raw);
      const saved = validateCompactionRoute(settings.route);
      let effective: CompactionRoute | null = null;
      let configurable = false;
      try {
        const health = healthByPath ? healthByPath.get(path) : await relayHealth(settings, this.fetcher);
        configurable = health.schemaVersion >= 2;
        if (configurable) effective = validateCompactionRoute(health.route);
      } catch { /* Transport details can contain a capability. Never return them. */ }
      return { path, raw, settings, saved, effective, configurable, current: index === 0 };
    }));
  }

  async status(healthByPath?: Map<string, any>) {
    try {
      const entries = await this.inspect(healthByPath);
      const current = entries[0]!;
      return { model: current.saved.to, effort: "low", models: COMPACTION_MODELS,
        configurable: current.configurable, generations: entries.length,
        applied: entries.filter(e => e.effective?.to === current.saved.to && e.effective?.effort === "low").length };
    } catch { return null; }
  }

  async configure(model: unknown) {
    if (typeof model !== "string" || !COMPACTION_MODELS.includes(model)) throw new Error("invalid_model");
    if (this.busy) throw new Error("policy_busy");
    this.busy = true;
    const written: { path: string; before: string; after: string }[] = [];
    try {
      const entries = await this.inspect();
      if (!entries[0]?.configurable) throw new Error("relay_unavailable");
      for (const entry of entries.filter(e => e.configurable)) {
        const route = validateCompactionRoute({ from: entry.saved.from, to: model, effort: "low" });
        const after = JSON.stringify({ ...entry.settings, route }, null, 2) + "\n";
        await this.replace(entry.path, entry.raw, after);
        written.push({ path: entry.path, before: entry.raw, after });
      }
      // File watchers apply asynchronously. Saving and live acknowledgement are
      // reported separately; never restart a relay or change an in-flight request.
      await Bun.sleep(600);
      return await this.status();
    } catch (error) {
      for (const item of written.reverse()) {
        try { await this.replace(item.path, item.after, item.before); } catch { /* Preserve concurrent edits. */ }
      }
      if (error instanceof Error && ["invalid_model", "policy_busy", "relay_unavailable", "settings_changed"].includes(error.message)) throw error;
      throw new Error("policy_update_failed");
    } finally { this.busy = false; }
  }

  private async replace(path: string, expected: string, content: string) {
    const temp = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      if (await readFile(path, "utf8") !== expected) throw new Error("settings_changed");
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
  }
}
