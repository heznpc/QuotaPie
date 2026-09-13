// Local native-app smoke test, isolated from production history and preferences.
// bun script/verify-notification-preferences.ts /tmp/quotapie-notification-stage
// Write possible, announced, updated, withdrawn, or reported to the stage file.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { classifyPost } from "../src/signals/classify";

const stagePath = process.argv[2];
if (!stagePath) throw new Error("Stage path required");
const root = await mkdtemp(join(tmpdir(), "quotapie-notification-smoke-"));
const config = structuredClone(DEFAULT_CONFIG);
config.dashboard.port = 0;
config.collection.codexEnabled = false;
config.resetSignals.enabled = true;
config.profile.locale = "ko";
const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
service.signalCollector.poll = async () => {};
service.setNativeNotificationTransportAvailable(true);
service.alerts.setNativeNotificationConsumer(true);
const server = startDashboard(service, config, { compactionRoot: root, preferencesPath: join(root, "config.json") });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, root }));
const messages: Record<string, string> = {
  possible: "[검증용] Codex might get a reset soon.",
  announced: "[검증용] Codex reset is landing by midnight today.",
  updated: "[검증용] Codex reset moved to tomorrow.",
  withdrawn: "[검증용] Codex reset tomorrow is cancelled.",
  reported: "[검증용] Codex reset is now complete.",
};
let prior = "";
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const stage = (await readFile(stagePath, "utf8").catch(() => "")).trim();
    if (stage !== prior && messages[stage]) {
      prior = stage;
      const post = { id: String(Date.now()), author: "thsottiaux", text: messages[stage]!, createdAtMs: Date.now(), conversationId: stage, references: [] };
      const signal = classifyPost(post, new Map());
      if (!signal) throw new Error("Fixture was not classified");
      signal.observedVia = "public-feed";
      service.resetSignals.save([signal], Date.now());
      await service.collectResetSignals();
      console.log(JSON.stringify({ stage, state: signal.state, history: service.resetSignals.list().length,
        pending: service.resetSignals.pending(Date.now()).length }));
    }
    const state = JSON.stringify({ preferences: service.notificationPreferences(), receipts: service.storage.db.query("SELECT title,disposition FROM app_notification_outbox").all() });
    if (state !== lastState) { lastState = state; console.log(state); }
  } finally { busy = false; }
}, 500);
let lastState = "";
