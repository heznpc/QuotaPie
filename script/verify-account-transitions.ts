// Installed-app smoke check with an isolated service and synthetic observations.
// Usage: bun script/verify-account-transitions.ts /tmp/quotapie-context-stage
// Write account, plan, window, or work-plan after connecting the app.
import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import type { QuotaObservation } from "../src/types";

const stagePath = process.argv[2];
if (!stagePath) throw new Error("Stage path required");
const config = structuredClone(DEFAULT_CONFIG);
config.dashboard.port = 0;
config.accounts.codex[0]!.label = "개인 검증용";
config.accounts.codex.push({ id: "work", label: "업무 검증용", enabled: true, codexHome: null });
config.accounts.claude = [];
config.collection.codexEnabled = false;
config.resetSignals.enabled = false;
config.alerts.enabled = true;
config.alerts.macOSNotifications = true;
config.alerts.command = null;
config.alerts.remainingThresholds = [];
config.profile.locale = "ko";
const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
const server = startDashboard(service, config);
const states = {
  initial: { accountContext: "synthetic-a", planType: "plus", collectorEpoch: "1", minutes: 300 },
  account: { accountContext: "synthetic-b", planType: "pro", collectorEpoch: "2", minutes: 10080 },
  plan: { accountContext: "synthetic-b", planType: "plus", collectorEpoch: "3", minutes: 300 },
  window: { accountContext: "synthetic-b", planType: "plus", collectorEpoch: "3", minutes: 10080 },
};
function ingest(stage: keyof typeof states, account = "default") {
  const { minutes, ...context } = states[stage];
  const now = Date.now();
  const observation: QuotaObservation = {
    provider: "codex", account, bucket: `codex:primary:${minutes}`,
    label: minutes === 300 ? "Codex 5h" : "Codex weekly", windowSeconds: minutes * 60,
    usedPercent: 20, resetsAtMs: 2_000_000_000_000, observedAtMs: now,
    source: "codex-app-server", quality: "authoritative",
    metadata: { limitId: "codex", lane: "primary", contextSession: "synthetic-session", ...context },
  };
  service.collection.recordAttempt("codex", account, "codex-appserver", now, null, null);
  return service.ingestCodexSnapshot([observation]);
}
ingest("initial");
ingest("account", "work");
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
let previous = "", busy = false, receipts = "";
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const stage = (await readFile(stagePath, "utf8").catch(() => "")).trim();
    if (stage !== previous && ["account", "plan", "window", "work-plan"].includes(stage)) {
      previous = stage;
      const events = stage === "work-plan" ? ingest("plan", "work") : ingest(stage as keyof typeof states);
      // The installed app must have claimed once before emitting test alerts.
      if (!service.alerts.hasNativeNotificationConsumer()) throw new Error("Connect installed app before changing stage");
      await service.evaluateTriggers(Date.now(), []);
      console.log(JSON.stringify({ stage, events: events.map(event => event.kind) }));
    }
    const next = JSON.stringify(service.storage.db.query("SELECT title,message,disposition FROM app_notification_outbox").all());
    if (receipts !== next) { receipts = next; console.log(JSON.stringify({ receipts: JSON.parse(next) })); }
  } finally { busy = false; }
}, 500);
