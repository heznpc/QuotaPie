// Isolated native-app verification. Run with a stage-file path, then connect
// QuotaPie using the printed QUOTAPIE_API_URL. No production data is accessed.
// Stages: muted-event, new-event, repeat-event, race.
// For race: toggle a preference and refresh the app while it saves; the proxy
// returns the pre-save status snapshot after the successful save response.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";

const stagePath = process.argv[2];
if (!stagePath) throw new Error("Stage path required");
const root = await mkdtemp(join(tmpdir(), "quotapie-review-smoke-"));
const config = structuredClone(DEFAULT_CONFIG);
config.dashboard.port = 0;
config.collection.codexEnabled = false;
config.profile.locale = "ko";
const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
service.setNativeNotificationTransportAvailable(true);
const backend = startDashboard(service, config, { compactionRoot: root, preferencesPath: join(root, "config.json") });
let delayNextSave = false;
let saving = false;
let releaseStatus: (() => void) | null = null;
const proxy = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.QUOTAPIE_VERIFY_PORT ?? 0), async fetch(request) {
  const url = new URL(request.url);
  const save = url.pathname === "/api/notifications/preferences" && delayNextSave;
  if (save) {
    delayNextSave = false;
    saving = true;
    await Bun.sleep(2_000);
  }
  const hold = url.pathname === "/api/status" && saving;
  const response = await fetch(new Request(`http://127.0.0.1:${backend.port}${url.pathname}`, request));
  const body = await response.arrayBuffer();
  if (save) saving = false;
  if (hold) {
    console.log("race: pre-save status captured");
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { releaseStatus = null; console.log("race: timeout"); resolve(); }, 4_000);
      releaseStatus = () => { clearTimeout(timeout); releaseStatus = null; console.log("race: stale status released"); resolve(); };
    });
  }
  if (url.pathname === "/api/notifications/preferences" && response.ok && releaseStatus) {
    console.log("race: save succeeded; stale status will follow");
    setTimeout(() => releaseStatus?.(), 750);
  }
  return new Response(body, { status: response.status, headers: response.headers });
} });
console.log(JSON.stringify({ url: `http://127.0.0.1:${proxy.port}`, root }));
let prior = "", lastState = "", busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const stage = (await readFile(stagePath, "utf8").catch(() => "")).trim();
    if (stage !== prior) {
      prior = stage;
      if (stage === "race") { delayNextSave = true; console.log("race: armed"); }
      if (["muted-event", "new-event", "repeat-event"].includes(stage)) {
        if (!service.alerts.hasNativeNotificationConsumer()) throw new Error("Connect app before emitting events");
        service.db.insertEvent({ provider: "codex", account: "default", bucket: "primary", kind: "credit_topup",
          severity: "info", occurredAtMs: Date.now(), confidence: "high", displayText: `[검증용] ${stage}`, details: { stage } });
        await service.evaluateTriggers(Date.now(), []);
      }
    }
    const state = JSON.stringify({ preferences: service.notificationPreferences(),
      events: service.storage.db.query("SELECT event_id, disposition FROM event_delivery ORDER BY event_id").all(),
      receipts: service.storage.db.query("SELECT delivery_key, disposition FROM app_notification_outbox ORDER BY rowid").all() });
    if (state !== lastState) { lastState = state; console.log(state); }
  } finally { busy = false; }
}, 100);
