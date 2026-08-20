#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  codexProfileRoot,
  codexUsesFileCredentials,
  configPath,
  dataDirectory,
  loadConfig,
  resolveUserPath,
  writeDefaultConfig,
} from "./config";
import { compactClaudeLine, formatEvents, formatStatuses } from "./format";
import { parseClaudeStatusLine } from "./providers/claude-statusline";
import { startDashboard } from "./server";
import { collectionErrorText } from "./analytics";
import { CLAUDE_OAUTH_SOURCE, CLAUDE_STATUSLINE_SOURCE, QuotaPieService } from "./service";
import { deliverTrigger } from "./triggers";

const ROOT = resolve(import.meta.dir, "..");
const BIN = resolve(ROOT, "bin", "quotapie");

function preferredBin(): string {
  const installed = resolve(homedir(), ".local", "bin", "quotapie");
  return existsSync(installed) ? installed : BIN;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function help(): string {
  return `QuotaPie — provider clocks + personal burn-rate timer

Usage:
  quotapie init                 Create a private default config and print integrations
  quotapie poll [--json]        Fetch Codex once and update history
  quotapie status [--account ID] [--json]
                                 Show current windows, pace, and predicted exhaustion
  quotapie explain [--account ID] [--json]
                                 Explain resets, relief, re-bases, and paid-credit changes
  quotapie accounts [--json]    Show local account aliases and isolated profile roots
  quotapie claude-statusline [--account ID]
                                 Ingest Claude status-line JSON and render one account's compact line
  quotapie watch                Run the adaptive collector and macOS triggers
  quotapie serve                Watch and serve the local dashboard
  quotapie doctor               Verify the local data sources
  quotapie test-alert           Send a test through configured notification channels
  quotapie launchd              Print a launchd plist for an always-on local service
  quotapie menubar-launchd      Print a launchd plist for the native menu bar app

Environment:
  QUOTAPIE_CONFIG=/path/config.json
  QUOTAPIE_HOME=/path/data-dir`;
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function claudeSnippet(account = "default"): string {
  return JSON.stringify(
    {
      statusLine: {
        type: "command",
        command: `${preferredBin()} claude-statusline --account ${account}`,
        padding: 1,
      },
    },
    null,
    2,
  );
}

function launchdPlist(): string {
  const logDir = dataDirectory();
  const home = homedir();
  const envPath = `${home}/.bun/bin:${home}/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.quotapie</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(preferredBin())}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(home)}</string>
    <key>PATH</key><string>${xmlEscape(envPath)}</string>
    <key>QUOTAPIE_CONFIG</key><string>${xmlEscape(configPath())}</string>
    <key>QUOTAPIE_HOME</key><string>${xmlEscape(dataDirectory())}</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(resolve(logDir, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(resolve(logDir, "service.error.log"))}</string>
</dict>
</plist>`;
}

function menubarLaunchdPlist(port: number): string {
  const logDir = dataDirectory();
  const home = homedir();
  const executable = process.env.QUOTAPIE_MENU_APP
    ? resolve(process.env.QUOTAPIE_MENU_APP, "Contents", "MacOS", "QuotaPie")
    : resolve(home, "Applications", "QuotaPie.app", "Contents", "MacOS", "QuotaPie");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.quotapie.menubar</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(executable)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>Umask</key><integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(home)}</string>
    <key>QUOTAPIE_API_URL</key><string>http://127.0.0.1:${port}</string>
    <key>QUOTAPIE_CONFIG</key><string>${xmlEscape(configPath())}</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(resolve(logDir, "menubar.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(resolve(logDir, "menubar.error.log"))}</string>
</dict>
</plist>`;
}

async function main(): Promise<number> {
  const [command = "status", ...args] = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const selectedAccount = optionValue(args, "--account");
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(help());
    return 0;
  }
  if (command === "init") {
    const path = writeDefaultConfig(configPath(), args.includes("--force"));
    const initialized = loadConfig(path);
    mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory(), 0o700);
    console.log(`Config: ${path}`);
    console.log(`Data:   ${dataDirectory()}`);
    for (const profile of initialized.accounts.claude.filter((item) => item.enabled)) {
      const settingsPath = resolve(resolveUserPath(profile.configDir), "settings.json");
      console.log(`\nMerge this into ${settingsPath} for ${profile.label} (${profile.id}):\n`);
      console.log(claudeSnippet(profile.id));
    }
    console.log(`\nThen run: ${preferredBin()} serve`);
    return 0;
  }
  if (command === "launchd") {
    console.log(launchdPlist());
    return 0;
  }
  if (command === "menubar-launchd") {
    console.log(menubarLaunchdPlist(loadConfig().dashboard.port));
    return 0;
  }

  const config = loadConfig();
  const configuredAccount = selectedAccount == null || [
    ...config.accounts.codex,
    ...config.accounts.claude,
  ].some((profile) => profile.id === selectedAccount && profile.enabled);
  if (!configuredAccount) throw new Error(`unknown or disabled account alias: ${selectedAccount}`);
  const service = new QuotaPieService(config);
  let dashboard: ReturnType<typeof startDashboard> | null = null;

  const shutdown = async () => {
    dashboard?.stop(true);
    await service.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    switch (command) {
      case "poll": {
        await service.pollCodex();
        await service.evaluateTriggers();
        const statuses = service.statuses().filter((status) => selectedAccount == null || status.account === selectedAccount);
        console.log(jsonOutput ? JSON.stringify(statuses, null, 2) : formatStatuses(statuses));
        return 0;
      }
      case "status": {
        const statuses = service.statuses().filter((status) => selectedAccount == null || status.account === selectedAccount);
        console.log(jsonOutput ? JSON.stringify(statuses, null, 2) : formatStatuses(statuses));
        return 0;
      }
      case "explain": {
        const events = service.recentEvents(100)
          .filter((event) => selectedAccount == null || event.account === selectedAccount);
        console.log(jsonOutput ? JSON.stringify(events, null, 2) : formatEvents(events));
        return 0;
      }
      case "claude-statusline": {
        const account = selectedAccount ?? "default";
        const profile = config.accounts.claude.find((item) => item.id === account && item.enabled);
        if (!profile) throw new Error(`unknown or disabled Claude account alias: ${account}`);
        const input = await Bun.stdin.text();
        const payload = JSON.parse(input) as unknown;
        const observations = parseClaudeStatusLine(payload, Date.now(), account);
        if (observations.length) {
          // Claude may cancel an in-flight status-line process on the next UI update.
          // Persist quickly; the durable watch/serve daemon owns alert delivery.
          service.ingestClaudeSessions(observations);
        }
        console.log(compactClaudeLine(
          service.analyses(Date.now(), "claude").filter((window) => window.account === account),
          profile.label,
        ));
        return 0;
      }
      case "accounts": {
        const rows = [
          ...config.accounts.codex.map((profile) => ({
            provider: "codex" as const,
            id: profile.id,
            label: profile.label,
            enabled: profile.enabled,
            profileRoot: profile.codexHome == null
              ? resolveUserPath(process.env.CODEX_HOME ?? "~/.codex")
              : resolveUserPath(profile.codexHome),
            inherited: profile.codexHome == null,
          })),
          ...config.accounts.claude.map((profile) => ({
            provider: "claude" as const,
            id: profile.id,
            label: profile.label,
            enabled: profile.enabled,
            profileRoot: resolveUserPath(profile.configDir),
            inherited: false,
          })),
        ];
        if (jsonOutput) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          for (const row of rows) {
            console.log(`${row.enabled ? "●" : "○"} ${row.provider}/${row.id} · ${row.label}`);
            console.log(`  profile root: ${row.profileRoot}${row.inherited ? " (inherited default)" : ""}`);
            if (row.provider === "codex") {
              console.log(`  login: env CODEX_HOME=${shellQuote(row.profileRoot)} ${config.collection.codexCommand} login`);
            } else {
              console.log(`  login: env CLAUDE_CONFIG_DIR=${shellQuote(row.profileRoot)} claude auth login`);
              console.log(`  status line: ${preferredBin()} claude-statusline --account ${row.id}`);
            }
          }
          if (config.accounts.codex.filter((profile) => profile.enabled).length > 1) {
            console.log("\nFor isolated Codex logins, set cli_auth_credentials_store = \"file\" in each CODEX_HOME/config.toml.");
          }
        }
        return 0;
      }
      case "doctor": {
        const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
        checks.push({
          check: "config",
          ok: existsSync(configPath()),
          detail: existsSync(configPath()) ? configPath() : `not created; defaults active (${configPath()})`,
        });
        if (config.collection.codexEnabled) {
          checks.push({
            check: "codex binary",
            ok: Bun.which(config.collection.codexCommand) != null,
            detail: Bun.which(config.collection.codexCommand) ?? "not found",
          });
          try {
            await service.pollCodex();
          } catch (error) {
            // Per-account results below retain the useful failure details even
            // when every configured account failed.
          }
          for (const result of service.codexPollResults()) {
            const profile = config.accounts.codex.find((item) => item.id === result.account)!;
            checks.push({
              check: `codex rate limits [${result.account}]`,
              ok: result.error == null && result.count > 0,
              detail: result.error ?? (
                result.count > 0
                  ? `${result.count} windows · ${profile.label}`
                  : `current response contained no windows · ${profile.label}`
              ),
            });
            if (config.accounts.codex.filter((item) => item.enabled).length > 1) {
              const root = codexProfileRoot(profile);
              const configToml = resolve(root, "config.toml");
              const fileCredentials = codexUsesFileCredentials(profile);
              checks.push({
                check: `codex auth isolation [${result.account}]`,
                ok: fileCredentials,
                detail: fileCredentials
                  ? `${configToml} uses file-scoped credentials`
                  : `set cli_auth_credentials_store = \"file\" in ${configToml}`,
              });
            }
          }
        }
        // 상태줄 설정 여부가 아니라 실제 수집 결과를 본다. 설정만 보고 통과시키면
        // 34일간 표본 0건인 계정이 정상으로 보이는 거짓 초록이 만들어진다.
        await service.pollClaudeOAuth(Date.now(), true);
        for (const account of service.accountStates().filter((state) => state.provider === "claude")) {
          const oauth = account.collection.sources.find((source) => source.source === CLAUDE_OAUTH_SOURCE);
          const statusLine = account.collection.sources.find(
            (source) => source.source === CLAUDE_STATUSLINE_SOURCE,
          );
          const healthy = account.collection.health === "recent-success";
          const detail = healthy
            ? `${account.collection.activeSource} · ${account.windows.length} windows · ${account.accountLabel}`
            : `${collectionErrorText(account.collection)}${
              account.collection.errorDetail ? ` (${account.collection.errorDetail})` : ""
            }`;
          checks.push({
            check: `claude collection [${account.account}]`,
            ok: healthy,
            detail,
          });
          // 폴백 소스는 없어도 되지만, 상태는 드러내 둔다.
          if (!healthy && statusLine?.health === "recent-success") {
            checks.push({
              check: `claude status line [${account.account}]`,
              ok: true,
              detail: "fallback source is delivering while OAuth is unavailable",
            });
          }
          if (oauth?.errorCategory === "auth-required" || oauth?.errorCategory === "auth-expired") {
            checks.push({
              check: `claude login [${account.account}]`,
              ok: false,
              detail: "run `claude auth login` in a terminal, then re-run doctor",
            });
          }
        }
        if (jsonOutput) console.log(JSON.stringify(checks, null, 2));
        else {
          for (const check of checks) console.log(`${check.ok ? "✓" : "○"} ${check.check}: ${check.detail}`);
        }
        // 수집 실패는 이제 실패로 취급한다. config 미생성만 정보성으로 남긴다.
        return checks.some((check) => !check.ok && check.check !== "config") ? 1 : 0;
      }
      case "test-alert": {
        const delivery = await deliverTrigger(
          {
            key: "manual:test",
            title: "QuotaPie 테스트",
            message: "알림 채널이 정상적으로 연결됐습니다.",
            severity: "info",
          },
          config,
        );
        const ok = delivery.complete;
        console.log(ok ? "Test alert delivered." : "Test alert failed; check notification settings and command.");
        return ok ? 0 : 1;
      }
      case "watch": {
        console.log("QuotaPie is watching provider clocks. Press Ctrl-C to stop.");
        await service.watch();
        return 0;
      }
      case "serve": {
        dashboard = startDashboard(service, config);
        console.log(`QuotaPie dashboard: http://${config.dashboard.host}:${dashboard.port}`);
        await service.watch();
        return 0;
      }
      default:
        console.error(`Unknown command: ${command}\n\n${help()}`);
        return 2;
    }
  } finally {
    dashboard?.stop(true);
    await service.close().catch(() => undefined);
  }
}

const exitCode = await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[quotapie] ${message}`);
  return 1;
});
process.exitCode = exitCode;
