import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface Observation {
  connected: boolean;
  selectedAccount: string | null;
  remainingPercent: number | null;
  menuVisible: boolean;
  menuHasImage: boolean;
  menuAccessibleLabel: string;
  viewRendered: boolean;
  detailSection?: string;
  recentWorkIDs?: string[];
  profileDockIcons?: string[];
  accountSelectorVerified?: boolean;
  statusFailure: string | null;
  routedAccount?: string | null;
  routedRemainingPercent?: number | null;
  poolError?: string | null;
}
export function smokeFailures(observed: Observation, expected: { account: string; remaining: number; label: string } | null): string[] {
  const failures: string[] = [];
  if (observed.menuVisible) failures.push("fixture_created_menu_bar");
  if (observed.accountSelectorVerified === false) failures.push("account_selector_focus_or_identity");
  if (!observed.viewRendered) failures.push("view_not_rendered");
  if (expected) {
    if (!observed.connected || observed.statusFailure) failures.push("not_connected");
    if (observed.selectedAccount !== expected.account || observed.remainingPercent !== expected.remaining) failures.push("wrong_account_or_quota");
    if (!observed.menuHasImage || !observed.menuAccessibleLabel.includes(expected.label)) failures.push("wrong_menu_rendering");
  } else if (observed.connected || !observed.statusFailure || observed.menuHasImage) failures.push("connection_failure_hidden");
  return failures;
}

async function sourceHash(root: string) {
  const hash = createHash("sha256");
  async function walk(relative: string) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { hash.update(path + "\0"); hash.update(await readFile(join(root, path))); }
    }
  }
  for (const directory of ["macos/QuotaPie", "macos/PowerCore", "macos/QuotaPiePowerHelper"]) await walk(directory);
  for (const file of ["Package.swift", "script/build_and_run.sh", "script/verify-macos.ts"]) hash.update(await readFile(join(root, file)));
  return hash.digest("hex");
}

async function run() {
  if (process.platform !== "darwin") throw new Error("Native verification requires macOS; not verified");
  const root = resolve(import.meta.dir, "..");
  const hash = await sourceHash(root);
  const stage = await mkdtemp(join(tmpdir(), "quotapie-native-check-"));
  const app = join(stage, "QuotaPie.app");
  const bundleID = `local.quotapie.verification.${randomUUID()}`;
  const exec = async (cmd: string[], timeout = 120_000) => {
    const child = Bun.spawn(cmd, { cwd: root, env: { ...process.env, QUOTAPIE_BUILD_CONFIGURATION: "debug" }, stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    try { if (await child.exited !== 0) throw new Error(`Native verification command failed: ${cmd[0]}`); }
    finally { clearTimeout(timer); }
  };
  let malformed = false;
  const account = (id: string, label: string, remaining: number) => ({ provider: "codex", account: id, accountLabel: label, enabled: true,
    windows: [{ provider: "codex", account: id, bucket: "codex:primary", label: "5h", windowSeconds: 18_000,
      usedPercent: 100 - remaining, remainingPercent: remaining, freshness: "fresh", quality: "authoritative",
      resetsAtMs: Date.now() + 3_600_000, observedAtMs: Date.now(), riskLevel: "none" }],
    collection: { health: "recent-success", sources: [] } });
  // Independent expected values: no production account-selection or headline code.
  let payload = { actionToken: "isolated-fixture", headline: { kind: "normal", provider: "codex", account: "second", remainingPercent: 100 },
    accounts: [account("default", "Main", 18), account("second", "Second", 100)], events: [], resumeTasks: [],
    recentWorkState: "ready", recentWork: [
      { id: "a".repeat(64), provider: "codex", account: "default", accountLabel: "Main", projectLabel: "Example project", tokenCount: 12400, lastActiveAtMs: Date.now() - 60_000 },
      { id: "b".repeat(64), provider: "claude", account: "default", accountLabel: "Main", projectLabel: "Another project", tokenCount: 8300, lastActiveAtMs: Date.now() - 3_600_000 },
    ],
    resetSignals: { enabled: true, source: "multiple", state: "ready", lastSuccessMs: Date.now(),
      coverage: "partial-relays", signals: [{ id: "100", fingerprint: "fixture-reset", author: "thsottiaux",
        sourceUrl: "https://x.com/thsottiaux/status/100", text: "We are almost Tuesday and I promised a reset for Tuesday.",
        publishedAtMs: Date.now() - 86_400_000, detectedAtMs: Date.now() - 60_000,
        state: "announced", resetKind: "unknown", observedVia: "codexreset", targetAtMs: null,
        timeHint: "We are almost Tuesday and I promised a reset for Tuesday" },
        { id: "101:limits", sourcePostId: "101", fingerprint: "fixture-allowance", author: "thsottiaux",
          sourceUrl: "https://x.com/thsottiaux/status/101", text: "Synthetic: 50% more usage for everyone.",
          publishedAtMs: Date.now(), state: "reported", resetKind: "unknown", observedVia: "codexreset",
          benefitKind: "limits", change: { percent: 50, evidence: "Synthetic: 50% more usage for everyone." },
          benefitText: "Announced: +50% (1.5× previous allowance)", targetAtMs: null }] },
    accountPool: {enabled:true, accounts:["default","second"], recent:[{sourceAccount:"default",account:"second",accountLabel:"Second",state:"completed",status:200,atMs:Date.now()}]} };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method === "POST" && new URL(request.url).pathname === "/api/profiles/dock-icon") {
      const body = await request.json() as {account?: string; icon?: string};
      if (body.icon !== undefined || !["default", "second"].includes(body.account ?? "")) return new Response("Read-only fixture", {status: 400});
      return Response.json({icon: body.account === "default" ? "codex-system" : "app-default", changed: false});
    }
    if (request.method !== "GET" || new URL(request.url).pathname !== "/api/status") return new Response("Unexpected request", { status: 400 });
    return malformed ? new Response("{invalid", { headers: { "content-type": "application/json" } }) : Response.json(payload);
  } });
  const profiles = ["main", "second"].map((id, index) => ({ id, name: id, codexHome: join(stage, id, "home"),
    appData: join(stage, id, "data"), collectionAccount: index ? "second" : "default", dockIcon: index ? "chatgpt" : "codex-system" }));
  try {
    await exec(["bash", "script/build_and_run.sh", "bundle", stage]);
    const plist = join(app, "Contents/Info.plist");
    await exec(["/usr/libexec/PlistBuddy", "-c", `Set :CFBundleIdentifier ${bundleID}`, plist]);
    await exec(["/usr/libexec/PlistBuddy", "-c", "Delete :CFBundleURLTypes", plist]);
    await exec(["codesign", "--force", "--sign", "-", "--timestamp=none", join(app, "Contents/Helpers/QuotaPiePowerHelper")]);
    await exec(["codesign", "--force", "--sign", "-", "--timestamp=none", app]);
    await exec(["/usr/bin/defaults", "write", bundleID, "local.quotapie.codex-desktop-profiles.v1", "-data", Buffer.from(JSON.stringify(profiles)).toString("hex")]);
    for (const scenario of [
      { name: "main-only", running: ["main"], frontmost: null, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "second-only", running: ["second"], frontmost: null, expected: { account: "codex/second", remaining: 100, label: "Second" } },
      { name: "both-main-frontmost", running: ["second", "main"], frontmost: "main", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "no-running-account", running: [], frontmost: null, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "invalid-response", running: ["main"], frontmost: null, expected: null },
      { name: "nickname-settings", running: ["main"], frontmost: null, initialSection: "settings", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "dock-icons", running: ["main"], frontmost: null, initialSection: "settings", contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "recent-work", running: ["main"], frontmost: null, initialSection: "work", expected: { account: "codex/default", remaining: 18, label: "Main" } },
    ]) {
      malformed = scenario.expected == null;
      const reportPath = join(stage, scenario.name + ".json");
      const request = join(stage, "request.json");
      await writeFile(request, JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}`, reportPath, profiles,
        runningProfileIDs: scenario.running, frontmostProfileID: scenario.frontmost,
        contentHeight: "contentHeight" in scenario ? scenario.contentHeight : undefined,
        initialSection: "initialSection" in scenario ? scenario.initialSection : undefined }));
      await exec(["/usr/bin/open", "-W", "-n", "-g", app, "--args", "--verification", request], 20_000);
      const observed = JSON.parse(await readFile(reportPath, "utf8")) as Observation;
      const failures = smokeFailures(observed, scenario.expected);
      if (scenario.name === "dock-icons" && observed.profileDockIcons?.join(",") !== "codex-system,chatgpt") failures.push("profile_icons_not_preserved");
      if (scenario.name === "recent-work" && (observed.detailSection !== "work" ||
          observed.recentWorkIDs?.join(",") !== payload.recentWork.map(item => item.id).join(","))) {
        failures.push("recent_work_not_rendered");
      }
      console.log(JSON.stringify({ check: scenario.name, result: failures.length ? "fail" : "pass", failures }));
      if (failures.length) throw new Error(`Native verification failed: ${scenario.name}`);
    }
    // Reuse independently observed relay/backend snapshots, not fabricated UI routes.
    const routingEvidence = process.argv[2];
    if (routingEvidence) {
      const evidence = JSON.parse(await readFile(routingEvidence, "utf8"));
      if (evidence.result !== "pass" || evidence.kind !== "isolated-loopback-http") throw new Error("Invalid routing evidence");
      for (const snapshot of evidence.uiSnapshots) {
        malformed = false; payload = snapshot.payload;
        const reportPath = join(stage, snapshot.name + ".json");
        const requestPath = join(stage, "request.json");
        await writeFile(requestPath, JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}`, reportPath,
          profiles: profiles.map((p,i)=>({...p,collectionAccount:i ? "b" : "a"})), runningProfileIDs:["main"], frontmostProfileID:"main" }));
        await exec(["/usr/bin/open", "-W", "-n", "-g", app, "--args", "--verification", requestPath], 20_000);
        const observed: Observation = JSON.parse(await readFile(reportPath, "utf8"));
        const selected = payload.accounts.find((a:any)=>a.account==="a");
        const remaining = selected?.windows[0]?.remainingPercent;
        if (remaining == null) throw new Error("Routing evidence lacks selected account quota");
        const failures = smokeFailures(observed,{account:"codex/a",remaining,label:"Fixture A"});
        if (observed.routedAccount !== snapshot.expected.account || observed.routedRemainingPercent !== snapshot.expected.remaining)
          failures.push("route_account_or_quota_mismatch");
        if (observed.poolError !== snapshot.expected.error) failures.push("routing_failure_or_recovery_hidden");
        console.log(JSON.stringify({check:snapshot.name,result:failures.length ? "fail":"pass",failures}));
        if (failures.length) throw new Error(`Routing UI verification failed: ${snapshot.name}`);
      }
    }
    if (hash !== await sourceHash(root)) throw new Error("Sources changed during native verification; rerun required");
    console.log(JSON.stringify({ result: "pass", sourceHash: hash, evidence: stage }));
  } finally {
    server.stop(true);
    Bun.spawnSync(["/usr/bin/defaults", "delete", bundleID]);
    // Stop only the executable created by this run, even after open times out.
    const pids = Bun.spawnSync(["pgrep", "-x", "QuotaPie"]).stdout.toString().trim().split(/\s+/).filter(Boolean);
    for (const value of pids) {
      const command = Bun.spawnSync(["ps", "-p", value, "-o", "comm="]).stdout.toString().trim();
      if (command === join(app, "Contents/MacOS/QuotaPie")) { try { process.kill(Number(value), "SIGTERM"); } catch {} }
    }
    // Keep observations and images, not a registered temporary app bundle.
    await rm(app, { recursive: true, force: true });
  }
}
if (import.meta.main) await run().catch(error => { console.error(error.message); process.exitCode = 1; });
