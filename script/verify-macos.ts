import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
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
  focusedResumeTaskID?: string | null;
  activeTaskIDs?: string[];
  managedJobIDs?: string[];
  hostGoalIDs?: string[];
  hostGoalReadStates?: string[];
  recentWorkIDs?: string[];
  efficiencyInsightIDs?: string[];
  testOnlySavings?: boolean;
  automaticWorkLoadedPolicyIDs?: string[];
  autoResumeControls?: Array<{kind:string;value:number;enabled:boolean;top:number}>;
  renderedText?: Array<{text:string;top:number}>;
  locale?: string;
  profileDockIcons?: string[];
  pendingResetIDs?: string[];
  excludedPostIDs?: string[];
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
  let fastQuotaScenario = false;
  const fastQuotaRequests: Array<{path:string;method:string;token:string|null;reason?:string}> = [];
  const account = (id: string, label: string, remaining: number) => ({ provider: "codex", account: id, accountLabel: label, enabled: true,
    windows: [{ provider: "codex", account: id, bucket: "codex:primary", label: "5h", windowSeconds: 18_000,
      usedPercent: 100 - remaining, remainingPercent: remaining, freshness: "fresh", quality: "authoritative",
      resetsAtMs: Date.now() + 3_600_000, observedAtMs: Date.now(), riskLevel: "none" }],
    collection: { health: "recent-success", sources: [] } });
  const pausedTasks = ["ready", "approved", "waiting"].map((state, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`, provider: "codex", account: "default",
    accountLabel: "Main", projectLabel: ["Review changes", "Check interrupted launch", "Continue implementation"][index],
    state, registeredAtMs: Date.now() - 3_600_000, expectedResetAtMs: Date.now() + 3_600_000,
  }));
  const managedJobs = [{ id: "fixture-job", label: "Registered verification job", provider: "codex", account: "default",
    state: "waiting", completedSteps: 1, totalSteps: 3, reason: "quota-unavailable", policy: {mode: "manual"} }];
  const hostGoals = pausedTasks.map(task => ({ id: task.id, taskId: task.id, provider: "codex", account: task.account,
    accountLabel: task.accountLabel, projectLabel: task.projectLabel, readState: "ready",
    objective: "Complete the linked host goal and verify the result", hostStatus: "paused",
    observedAtMs: Date.now(), expiresAtMs: Date.now() + 600_000, resumeState: task.state }));
  const autoResume = {
    accounts: ["default", "second"].map((account, index) => ({ account, label: index ? "Second" : "Main", enabled: index === 1,
      enabledAtMs: index ? Date.now() - 3600000 : null, lastScanAtMs: index ? Date.now() : null, lastError: null })),
    incidents: ["waiting", "running", "resumed", "skipped", "needs-review"].map((state, index) => ({
      id: "fixture-" + state, account: "second", threadId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      projectLabel: "Quota recovery " + (index + 1), state, detectedAtMs: Date.now() - 60000,
      reason: state === "needs-review" ? "account-binding-changed" : undefined,
    })),
  };
  // Independent expected values: no production account-selection or headline code.
  let payload = { actionToken: "isolated-fixture", headline: { kind: "normal", provider: "codex", account: "second", remainingPercent: 100 },
    accounts: [account("default", "Main", 18), account("second", "Second", 100)], events: [],
    resumeTasks: pausedTasks.slice(0, 0), jobs: managedJobs.slice(0, 0), hostGoals: {items: hostGoals.slice(0, 0)},
    autoResume: undefined as typeof autoResume | undefined,
    recentWorkState: "ready", recentWork: [
      { id: "a".repeat(64), provider: "codex", account: "default", accountLabel: "Main", projectLabel: "Example project", tokenCount: 12400, lastActiveAtMs: Date.now() - 60_000 },
      { id: "b".repeat(64), provider: "claude", account: "default", accountLabel: "Main", projectLabel: "Another project", tokenCount: 8300, lastActiveAtMs: Date.now() - 3_600_000 },
    ],
    resetSignals: { enabled: true, source: "multiple", state: "ready", lastSuccessMs: Date.now(),
      excludedPosts: [{id: "102", author: "thsottiaux", text: "Synthetic unrelated post", publishedAtMs: Date.now(),
        contextText: null, missingContext: false, reason: "no-reset-or-benefit-evidence", source: "codexreset",
        firstSeenAtMs: Date.now(), lastSeenAtMs: Date.now()}],
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
    compaction: {checkedAtMs: Date.now(), generations: 1, reachable: 1, active: [], recent: [], policy: null,
      savings: {policy: {enabled: true, configurable: true, supported: true, generations: 1, compatible: 1, applied: 1, testOnly: false, phaseConfigurable: true},
        active: [], recent: [], insights: [{id: "fixture-repeated-error", threadId: "11111111-1111-4111-8111-111111111111", kind: "repeated-failure", count: 3,
          observedDurationMs: 1500, suggestion: "review-provider-error", savingsApplied: false}]}},
    accountPool: {enabled:true, accounts:["default","second"], recent:[{sourceAccount:"default",account:"second",accountLabel:"Second",state:"completed",status:200,atMs:Date.now()}]} };
  const automaticPolicy = { id: "fixture-work", provider: "claude", account: "default", nativeSessionId: "fixture-session",
    model: "original-session-model", prompt: "Continue the selected work", objective: "Shared work fixture", completionCriteria: ["Evidence recorded"],
    dispatchOwner: "local", enabled: false, trigger: "quota-ready", resetWithinMinutes: 60,
    budgetByBucket: {five_hour: {reservePercent: 0, maxUsagePercent: 20, targetUsagePercent: 10}},
    maxTurns: 3, maxDurationSeconds: 60, maxTotalDurationSeconds: 120, expiresAtMs: Date.now()+3600000, priority: 0, onReset: "stop", revision: 2,
    state: {spentByBucket: {five_hour: 4}, turns: 1, totalDurationSeconds: 12, status: "turn-finished", activeExecutionId: null} };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const requestPath = new URL(request.url).pathname;
    if (fastQuotaScenario) {
      const entry = {path:requestPath,method:request.method,token:request.headers.get("x-quotapie-action-token")} as typeof fastQuotaRequests[number];
      fastQuotaRequests.push(entry);
      if (requestPath === "/api/collection/refresh" && request.method === "POST") {
        entry.reason = ((await request.json()) as {reason:string}).reason;
        if (entry.token !== "isolated-fixture") return new Response("Unauthorized",{status:403});
        return Response.json({collection:{refreshing:true}},{status:202});
      }
      if (requestPath === "/api/quota" && request.method === "GET") {
        return Response.json({nowMs:Date.now(),headline:payload.headline,accounts:payload.accounts,
          actionToken:payload.actionToken,collection:{refreshing:true}});
      }
      // The first meter must render while this unrelated rich request is slow;
      // its eventual timeout must not erase the continuing fast reads.
      if (requestPath === "/api/status" && request.method === "GET") await Bun.sleep(6_500);
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/api/profiles/dock-icon") {
      const body = await request.json() as {account?: string; icon?: string};
      if (body.icon !== undefined || !["default", "second"].includes(body.account ?? "")) return new Response("Read-only fixture", {status: 400});
      return Response.json({icon: body.account === "default" ? "codex-system" : "app-default", changed: false});
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/api/work/preferences") {
      if (request.headers.get("x-quotapie-action-token") !== "isolated-fixture") return new Response("Unauthorized", {status: 403});
      return Response.json({preferences: []});
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/api/work") {
      if(request.headers.get("x-quotapie-action-token")!=="isolated-fixture") return new Response("Unauthorized",{status:403});
      return Response.json({policies:[automaticPolicy], executions:[], accounts:[{provider:"claude",account:"default",label:"Main",buckets:["five_hour"],reserveByBucket:{five_hour:0}}],defaults:{timeZone:"Asia/Seoul"}});
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
      { name: "fast-quota-delayed-details", running: ["main"], frontmost: null, fastQuota: true, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "main-only", running: ["main"], frontmost: null, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "second-only", running: ["second"], frontmost: null, expected: { account: "codex/second", remaining: 100, label: "Second" } },
      { name: "both-main-frontmost", running: ["second", "main"], frontmost: "main", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "no-running-account", running: [], frontmost: null, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "invalid-response", running: ["main"], frontmost: null, expected: null },
      { name: "nickname-settings", running: ["main"], frontmost: null, initialSection: "settings", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "dock-icons", running: ["main"], frontmost: null, initialSection: "settings", contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "excluded-posts", running: ["main"], frontmost: null, initialSection: "resets", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "session-efficiency", running: ["main"], frontmost: null, initialSection: "activity", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "recent-work", running: ["main"], frontmost: null, initialSection: "work", expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "auto-resume", running: ["main"], frontmost: null, initialSection: "work", contentHeight: 1200, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "paused-overview", running: ["main"], frontmost: null, withTasks: true, contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "paused-work", running: ["main"], frontmost: null, withTasks: true, initialSection: "work", contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "linked-work", running: ["main"], frontmost: null, withTasks: true, initialSection: "activity", focusedResumeTaskID: pausedTasks[0]!.id, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "host-goals", running: ["main"], frontmost: null, withTasks: true, goalState: "ready", initialSection: "work", contentHeight: 1200, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "host-goals-stale", running: ["main"], frontmost: null, withTasks: true, goalState: "stale", initialSection: "work", contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "host-goals-account-change", running: ["main"], frontmost: null, withTasks: true, goalState: "account_changed", initialSection: "work", contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
      { name: "host-goals-absent", running: ["main"], frontmost: null, withTasks: true, goalState: "no_goal", initialSection: "work", contentHeight: 1000, expected: { account: "codex/default", remaining: 18, label: "Main" } },
    ]) {
      malformed = scenario.expected == null;
      fastQuotaScenario = "fastQuota" in scenario;
      payload.resumeTasks = "withTasks" in scenario ? pausedTasks : [];
      payload.jobs = "withTasks" in scenario ? managedJobs : [];
      payload.autoResume = scenario.name === "auto-resume" ? autoResume : undefined;
      payload.hostGoals.items = "goalState" in scenario ? hostGoals.slice(0, scenario.goalState === "ready" ? 3 : 1)
        .map(goal => ({ ...goal, readState: scenario.goalState!,
          expiresAtMs: scenario.goalState === "stale" ? Date.now() - 1 : Date.now() + 600_000 })) : [];
      const reportPath = join(stage, scenario.name + ".json");
      const request = join(stage, "request.json");
      const quotaCachePath = fastQuotaScenario ? join(stage, "isolated-quota-cache.json") : undefined;
      if (quotaCachePath) {
        const measuredAt = Date.now() - 3_600_000;
        await writeFile(quotaCachePath, JSON.stringify({version:1,endpoint:`http://127.0.0.1:${server.port}`,
          nowMs:measuredAt,accounts:payload.accounts.map(item=>({...item,
            windows:item.windows.map(window=>({...window,remainingPercent:12,observedAtMs:measuredAt}))}))}));
      }
      await writeFile(request, JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}`, reportPath, profiles,
        runningProfileIDs: scenario.running, frontmostProfileID: scenario.frontmost,
        contentHeight: "contentHeight" in scenario ? scenario.contentHeight : undefined,
        inspectAutoResume: scenario.name === "auto-resume",
        fastQuota: fastQuotaScenario, quotaCachePath,
        focusedResumeTaskID: "focusedResumeTaskID" in scenario ? scenario.focusedResumeTaskID : undefined,
        initialSection: "initialSection" in scenario ? scenario.initialSection : undefined }));
      await exec(["/usr/bin/open", "-W", "-n", "-g", app, "--args", "--verification", request], 20_000);
      const observed = JSON.parse(await readFile(reportPath, "utf8")) as Observation;
      if (scenario.name === "auto-resume") {
        // Keep Vision's first-use model loading outside the app launch deadline.
        // These labels come from captured pixels, independently of the payload.
        const ocrPath = reportPath + ".ocr.json";
        await exec(["/usr/bin/swift", "-e", `
          import Foundation
          import Vision
          let request = VNRecognizeTextRequest()
          request.recognitionLevel = .accurate
          request.recognitionLanguages = ["ko-KR", "en-US"]
          request.usesLanguageCorrection = false
          try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
          let rows: [[String: Any]] = (request.results ?? []).compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            return ["text": text, "top": 1 - observation.boundingBox.midY]
          }
          try JSONSerialization.data(withJSONObject: rows).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        `, reportPath + ".png", ocrPath], 60_000);
        observed.renderedText = JSON.parse(await readFile(ocrPath, "utf8"));
      }
      const failures = smokeFailures(observed, scenario.expected);
      if (scenario.expected && !fastQuotaScenario && observed.pendingResetIDs?.join(",") !== "100") failures.push("pending_reset_displaced_by_newer_news");
      if (fastQuotaScenario) {
        const cache = JSON.parse(await readFile(reportPath + ".cache", "utf8"));
        const first = JSON.parse(await readFile(reportPath + ".first", "utf8"));
        const final = observed as Observation & {detailsLoaded:boolean;detailsError:string|null;showingStartupCache:boolean};
        if (!cache.showingStartupCache || cache.hasActionToken || cache.canActOnTasks || cache.remainingPercent !== 12 || !cache.measurementAtMs)
          failures.push("startup_cache_claimed_authority_or_lost_reading");
        if (!first.connected || first.showingStartupCache || first.remainingPercent !== 18 || first.detailsLoaded || !first.detailsLoading)
          failures.push("fast_quota_waited_for_slow_details");
        if (!final.detailsError || final.detailsLoaded || final.showingStartupCache || !final.connected)
          failures.push("detail_timeout_erased_fast_quota");
        const posts = fastQuotaRequests.filter(item=>item.method === "POST");
        if (posts.length !== 1 || posts[0]!.path !== "/api/collection/refresh" || posts[0]!.reason !== "startup" || posts[0]!.token !== "isolated-fixture")
          failures.push("startup_collection_request_missing_or_duplicated");
        if (fastQuotaRequests.filter(item=>item.path === "/api/quota").length < 2 || fastQuotaRequests.filter(item=>item.path === "/api/status").length !== 1)
          failures.push("fast_and_rich_polling_not_independent");
        await writeFile(join(stage,"fast-quota-requests.json"),JSON.stringify(fastQuotaRequests));
      }
      if (scenario.name === "excluded-posts" && (observed.detailSection !== "resets" || observed.excludedPostIDs?.join(",") !== "codexreset:102")) failures.push("excluded_post_not_available");
      if (scenario.name === "dock-icons" && observed.profileDockIcons?.join(",") !== "codex-system,chatgpt") failures.push("profile_icons_not_preserved");
      if (scenario.name === "recent-work" && (observed.detailSection !== "work" ||
          observed.recentWorkIDs?.join(",") !== payload.recentWork.map(item => item.id).join(","))) {
        failures.push("recent_work_not_rendered");
      }
      if ("withTasks" in scenario && (observed.activeTaskIDs?.join(",") !== pausedTasks.map(task => task.id).join(",") ||
          observed.managedJobIDs?.join(",") !== "fixture-job")) failures.push("registered_work_missing");
      if (scenario.name === "paused-work" && observed.detailSection !== "work") failures.push("wrong_work_section");
      if (scenario.name === "linked-work" && (observed.detailSection !== "work" ||
          observed.focusedResumeTaskID !== pausedTasks[0]!.id)) failures.push("task_link_not_routed_to_work");
      if ("goalState" in scenario && (observed.detailSection !== "work" ||
          observed.hostGoalIDs?.join(",") !== payload.hostGoals.items.map(goal => goal.id).join(",") ||
          observed.hostGoalReadStates?.join(",") !== payload.hostGoals.items.map(() => scenario.goalState).join(","))) failures.push("host_goal_state_not_presented");
      if (scenario.name === "session-efficiency" && (observed.detailSection !== "activity" || observed.efficiencyInsightIDs?.join(",") !== "fixture-repeated-error" || observed.testOnlySavings !== false)) failures.push("session_review_not_loaded");
      if(scenario.name === "recent-work" && observed.automaticWorkLoadedPolicyIDs?.join(",") !== "fixture-work") failures.push("shared_work_not_loaded");
      if (scenario.name === "auto-resume") {
        const controls = observed.autoResumeControls ?? [];
        const text = observed.renderedText ?? [];
        const normalized = (value: string) => value.replace(/\s/g, "");
        const matchingText = (value: string) => text.filter(row => normalized(row.text) === normalized(value)).sort((a,b) => a.top-b.top);
        for (const [account, label, enabled] of [["default", "Main", 0], ["second", "Second", 1]] as const) {
          const name = matchingText(label)[0];
          if (!name || !controls.some(control => control.value === enabled && control.enabled && Math.abs(control.top-name.top)<0.015))
            failures.push("auto_resume_toggle_" + account);
        }
        const labels = observed.locale === "ko" ? ["회복 대기", "1회 재개 중", "1회 재개 종료", "건너뜀", "확인 필요"]
          : ["Waiting for recovery", "Resuming once", "One continuation ended", "Skipped", "Review needed"];
        for (const [index, state] of ["waiting", "running", "resumed", "skipped", "needs-review"].entries()) {
          if (matchingText(labels[index]!).length !== 1) failures.push("auto_resume_state_" + state);
        }
        const skips = matchingText(observed.locale === "ko" ? "이 대화 건너뛰기" : "Skip this conversation");
        const waiting = matchingText(labels[0]!)[0], running = matchingText(labels[1]!)[0];
        if (skips.length !== 1 || !waiting || !running || skips[0]!.top <= waiting.top || skips[0]!.top >= running.top)
          failures.push("auto_resume_skip_scope");
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
      try {
        if (realpathSync(command) === realpathSync(join(app, "Contents/MacOS/QuotaPie"))) {
          try { process.kill(Number(value), "SIGTERM"); } catch {}
        }
      } catch { /* An exited process or removed bundle is not ours to stop. */ }
    }
    // Keep observations and images, not a registered temporary app bundle.
    await rm(app, { recursive: true, force: true });
  }
}
if (import.meta.main) await run().catch(error => { console.error(error.message); process.exitCode = 1; });
