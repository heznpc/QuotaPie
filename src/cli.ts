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
import { resolveLocale, t } from "./i18n";
import { CLAUDE_OAUTH_SOURCE, CLAUDE_STATUSLINE_SOURCE, QuotaPieService } from "./service";
import type { AppConfig } from "./config";
import type { Locale } from "./i18n";
import type { Provider } from "./types";
import { configureAwakeHooks, releaseAwakeTask } from "./awake";

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

function help(locale: Locale): string {
  return t("cli.help", {}, locale);
}

function optionValue(args: string[], name: string, locale: Locale): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(t("cli.option.value-required", { label: name }, locale));
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resumeAccount(
  config: AppConfig,
  provider: Provider,
  requested: string | null,
  locale: Locale,
): string {
  if (requested) return requested;
  const profiles = provider === "codex"
    ? config.accounts.codex.filter((profile) => profile.enabled).map((profile) => ({
      id: profile.id,
      // A null Codex root means the stable default profile. Do not let the
      // caller's CODEX_HOME silently redefine that configured account while
      // trying to identify a different active profile.
      root: resolveUserPath(profile.codexHome ?? "~/.codex"),
    }))
    : config.accounts.claude.filter((profile) => profile.enabled).map((profile) => ({
      id: profile.id,
      root: resolveUserPath(profile.configDir),
    }));
  const environmentName = provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const environmentRoot = process.env[environmentName]?.trim();
  if (environmentRoot) {
    const activeRoot = resolveUserPath(environmentRoot);
    const matching = profiles.filter((profile) => profile.root === activeRoot);
    if (matching.length === 1) return matching[0]!.id;
    throw new Error(t("cli.error.profile-mismatch", {
      variable: environmentName,
      provider,
    }, locale));
  }
  if (profiles.length === 1) return profiles[0]!.id;
  if (profiles.length > 1) {
    throw new Error(t("cli.error.multiple-accounts", {
      provider,
      variable: environmentName,
    }, locale));
  }
  throw new Error(t("cli.error.no-account", { provider }, locale));
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

// The menu bar app has to reach the host the backend actually binds to. IPv6
// loopback needs brackets in a URL, and hardcoding 127.0.0.1 left the app
// unable to connect whenever dashboard.host was set to ::1.
function apiOrigin(host: string, port: number): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const authority = bare.includes(":") ? `[${bare}]` : bare;
  return `http://${authority}:${port}`;
}

async function deliverTestAlertThroughDaemon(config: AppConfig): Promise<{
  complete: boolean;
  nativeAppQueued: boolean;
} | null> {
  const origin = apiOrigin(config.dashboard.host, config.dashboard.port);
  let actionToken: string;
  try {
    const statusResponse = await fetch(`${origin}/api/status`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!statusResponse.ok) return null;
    const status = await statusResponse.json() as { actionToken?: unknown };
    if (typeof status.actionToken !== "string" || !status.actionToken) return null;
    actionToken = status.actionToken;
  } catch {
    return null;
  }
  try {
    const response = await fetch(`${origin}/api/notifications/test`, {
      method: "POST",
      headers: { "x-quotapie-action-token": actionToken },
      signal: AbortSignal.timeout(Math.max(
        5_000,
        config.alerts.deliveryTimeoutSeconds * 1_000 + 2_000,
      )),
    });
    // A running daemon from before native notifications were introduced does
    // not have the endpoint. Let the local compatibility path use osascript.
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) return { complete: false, nativeAppQueued: false };
    const result = await response.json() as {
      complete?: unknown;
      nativeAppQueued?: unknown;
    };
    return {
      complete: result.complete === true,
      nativeAppQueued: result.nativeAppQueued === true,
    };
  } catch {
    // Once the POST has left this process, falling back could duplicate a
    // notification whose success response alone was lost.
    return { complete: false, nativeAppQueued: false };
  }
}

function menubarLaunchdPlist(host: string, port: number): string {
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
    <key>QUOTAPIE_API_URL</key><string>${xmlEscape(apiOrigin(host, port))}</string>
    <key>QUOTAPIE_CONFIG</key><string>${xmlEscape(configPath())}</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(resolve(logDir, "menubar.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(resolve(logDir, "menubar.error.log"))}</string>
</dict>
</plist>`;
}

function configuredLocale(): Locale {
  try {
    return resolveLocale(loadConfig().profile.locale);
  } catch {
    // Configuration errors are reported by the command itself. Locale
    // selection still has a safe environment/default path for that report.
    return resolveLocale("auto");
  }
}

let outputLocale = resolveLocale("auto");

async function main(): Promise<number> {
  const [command = "status", ...args] = process.argv.slice(2);
  outputLocale = configuredLocale();
  const jsonOutput = args.includes("--json");
  const selectedAccount = optionValue(args, "--account", outputLocale);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(help(outputLocale));
    return 0;
  }
  if (command === "init") {
    const path = writeDefaultConfig(configPath(), args.includes("--force"));
    const initialized = loadConfig(path);
    outputLocale = resolveLocale(initialized.profile.locale);
    mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
    chmodSync(dataDirectory(), 0o700);
    console.log(t("cli.init.config", { path }, outputLocale));
    console.log(t("cli.init.data", { path: dataDirectory() }, outputLocale));
    for (const profile of initialized.accounts.claude.filter((item) => item.enabled)) {
      const settingsPath = resolve(resolveUserPath(profile.configDir), "settings.json");
      console.log(`\n${t("cli.init.merge", {
        path: settingsPath,
        label: profile.label,
        account: profile.id,
      }, outputLocale)}\n`);
      console.log(claudeSnippet(profile.id));
    }
    console.log(`\n${t("cli.init.then-run", {
      command: `${preferredBin()} serve`,
    }, outputLocale)}`);
    return 0;
  }
  if (command === "launchd") {
    console.log(launchdPlist());
    return 0;
  }
  if (command === "menubar-launchd") {
    {
      const dashboard = loadConfig().dashboard;
      console.log(menubarLaunchdPlist(dashboard.host, dashboard.port));
    }
    return 0;
  }

  const config = loadConfig();
  outputLocale = resolveLocale(config.profile.locale);
  const configuredAccount = selectedAccount == null || [
    ...config.accounts.codex,
    ...config.accounts.claude,
  ].some((profile) => profile.id === selectedAccount && profile.enabled);
  if (!configuredAccount) {
    throw new Error(t("cli.error.unknown-account", { account: selectedAccount ?? "" }, outputLocale));
  }
  if (command === "awake") {
    const action = args[0];
    if (action !== "connect" && action !== "disconnect") throw new Error("Usage: quotapie awake connect|disconnect");
    const paths = configureAwakeHooks(config, action === "connect");
    console.log(JSON.stringify({ changed: paths, next: action === "connect" ? "Review and trust the new hooks in Codex /hooks, then start a new turn. Enable Keep awake while working in QuotaPie." : "Hooks disconnected. Turn off Keep awake while working to release existing holds." }, null, 2));
    return 0;
  }
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
        console.log(jsonOutput ? JSON.stringify(statuses, null, 2) : formatStatuses(statuses, outputLocale));
        return 0;
      }
      case "status": {
        const statuses = service.statuses().filter((status) => selectedAccount == null || status.account === selectedAccount);
        console.log(jsonOutput ? JSON.stringify(statuses, null, 2) : formatStatuses(statuses, outputLocale));
        return 0;
      }
      case "explain": {
        const events = service.recentEvents(100)
          .filter((event) => selectedAccount == null || event.account === selectedAccount);
        console.log(jsonOutput ? JSON.stringify(events, null, 2) : formatEvents(events, outputLocale));
        return 0;
      }
      case "claude-statusline": {
        const account = selectedAccount ?? "default";
        const profile = config.accounts.claude.find((item) => item.id === account && item.enabled);
        if (!profile) {
          throw new Error(t("cli.error.unknown-claude-account", { account }, outputLocale));
        }
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
          outputLocale,
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
            console.log(t("cli.accounts.profile-root", {
              root: row.profileRoot,
              detail: row.inherited ? t("cli.accounts.inherited", {}, outputLocale) : "",
            }, outputLocale));
            if (row.provider === "codex") {
              console.log(t("cli.accounts.login", {
                command: `env CODEX_HOME=${shellQuote(row.profileRoot)} ${config.collection.codexCommand} login`,
              }, outputLocale));
            } else {
              console.log(t("cli.accounts.login", {
                command: `env CLAUDE_CONFIG_DIR=${shellQuote(row.profileRoot)} claude auth login`,
              }, outputLocale));
              console.log(t("cli.accounts.status-line", {
                command: `${preferredBin()} claude-statusline --account ${row.id}`,
              }, outputLocale));
            }
          }
          if (config.accounts.codex.filter((profile) => profile.enabled).length > 1) {
            console.log(`\n${t("cli.accounts.codex-isolation", {}, outputLocale)}`);
          }
        }
        return 0;
      }
      case "pause": {
        const requestedProvider = optionValue(args, "--provider", outputLocale);
        if (requestedProvider != null && requestedProvider !== "codex" && requestedProvider !== "claude") {
          throw new Error(t("cli.error.provider-invalid", {}, outputLocale));
        }
        const codexSession = process.env.CODEX_THREAD_ID?.trim() || null;
        const claudeSession = process.env.CLAUDE_SESSION_ID?.trim() || null;
        let provider = requestedProvider as "codex" | "claude" | null;
        if (provider == null) {
          if (codexSession && claudeSession) {
            throw new Error(t("cli.error.session-ambiguous", {}, outputLocale));
          }
          if (codexSession) provider = "codex";
          else if (claudeSession) provider = "claude";
          else throw new Error(t("cli.error.provider-required", {}, outputLocale));
        }
        const nativeId = optionValue(args, "--session", outputLocale) ?? (
          provider === "codex" ? codexSession : claudeSession
        );
        if (!nativeId) {
          const variable = provider === "codex" ? "CODEX_THREAD_ID" : "CLAUDE_SESSION_ID";
          throw new Error(t("cli.error.session-required", { variable }, outputLocale));
        }
        const task = service.registerResumeTask({
          provider,
          account: resumeAccount(config, provider, selectedAccount, outputLocale),
          nativeId,
          cwd: optionValue(args, "--cwd", outputLocale) ?? process.cwd(),
          projectLabel: optionValue(args, "--label", outputLocale) ?? undefined,
          bucket: optionValue(args, "--bucket", outputLocale) ?? undefined,
        });
        const profileRoot = provider === "codex"
          ? resolveUserPath(config.accounts.codex.find(p => p.id === task.account)!.codexHome ?? "~/.codex")
          : resolveUserPath(config.accounts.claude.find(p => p.id === task.account)!.configDir);
        await releaseAwakeTask(provider, profileRoot, nativeId);
        console.log(jsonOutput
          ? JSON.stringify(task, null, 2)
          : t("resume.registered", { label: task.projectLabel }, outputLocale));
        return 0;
      }
      case "doctor": {
        const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
        const configCheck = t("cli.doctor.check.config", {}, outputLocale);
        checks.push({
          check: configCheck,
          ok: existsSync(configPath()),
          detail: existsSync(configPath())
            ? configPath()
            : t("cli.doctor.not-created", { path: configPath() }, outputLocale),
        });
        if (config.collection.codexEnabled) {
          checks.push({
            check: t("cli.doctor.check.codex-binary", {}, outputLocale),
            ok: Bun.which(config.collection.codexCommand) != null,
            detail: Bun.which(config.collection.codexCommand) ?? t("cli.doctor.not-found", {}, outputLocale),
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
              check: t("cli.doctor.check.codex-rate-limits", { account: result.account }, outputLocale),
              ok: result.error == null && result.count > 0,
              detail: result.error ?? (
                result.count > 0
                  ? t("cli.doctor.windows", {
                    count: result.count,
                    label: profile.label,
                  }, outputLocale)
                  : t("cli.doctor.no-windows", { label: profile.label }, outputLocale)
              ),
            });
            if (config.accounts.codex.filter((item) => item.enabled).length > 1) {
              const root = codexProfileRoot(profile);
              const configToml = resolve(root, "config.toml");
              const fileCredentials = codexUsesFileCredentials(profile);
              checks.push({
                check: t("cli.doctor.check.codex-auth-isolation", {
                  account: result.account,
                }, outputLocale),
                ok: fileCredentials,
                detail: fileCredentials
                  ? t("cli.doctor.file-credentials", { path: configToml }, outputLocale)
                  : t("cli.doctor.set-file-credentials", { path: configToml }, outputLocale),
              });
            }
          }
        }
        // Judge by actual collection results, not by whether a status line is
        // configured. Passing on configuration alone is how an account with
        // zero samples in 34 days looked healthy.
        // With the gate off, this call returns immediately without reading
        // any credentials.
        await service.pollClaudeOAuth(Date.now(), true);
        for (const account of service.accountStates().filter((state) => state.provider === "claude")) {
          const oauth = account.collection.sources.find((source) => source.source === CLAUDE_OAUTH_SOURCE);
          const statusLine = account.collection.sources.find(
            (source) => source.source === CLAUDE_STATUSLINE_SOURCE,
          );
          const healthy = account.collection.health === "recent-success";
          const detail = healthy
            ? t("cli.doctor.healthy-collection", {
              source: account.collection.activeSource ?? "—",
              count: account.windows.length,
              label: account.accountLabel,
            }, outputLocale)
            : `${collectionErrorText(account.collection, outputLocale)}${
              account.collection.errorDetail ? ` (${account.collection.errorDetail})` : ""
            }`;
          checks.push({
            check: t("cli.doctor.check.claude-collection", {
              account: account.account,
            }, outputLocale),
            ok: healthy,
            detail,
          });
          // The fallback source is optional, but its state is worth showing.
          if (!healthy && statusLine?.health === "recent-success") {
            checks.push({
              check: t("cli.doctor.check.claude-status-line", {
                account: account.account,
              }, outputLocale),
              ok: true,
              detail: t("cli.doctor.fallback-delivering", {}, outputLocale),
            });
          }
          if (oauth?.errorCategory === "auth-required" || oauth?.errorCategory === "auth-expired") {
            checks.push({
              check: t("cli.doctor.check.claude-login", { account: account.account }, outputLocale),
              ok: false,
              detail: t("cli.doctor.login-instruction", {}, outputLocale),
            });
          }
          // With OAuth off, the status line is the only path left, so report
          // whether the hook is configured — otherwise the user cannot tell
          // which of the two routes to take.
          if (!config.collection.claudeOAuthEnabled) {
            const profile = config.accounts.claude.find((item) => item.id === account.account)!;
            const claudeSettings = resolve(resolveUserPath(profile.configDir), "settings.json");
            let statusCommand = "";
            try {
              const parsed = JSON.parse(readFileSync(claudeSettings, "utf8")) as {
                statusLine?: { command?: unknown };
              };
              statusCommand = typeof parsed.statusLine?.command === "string" ? parsed.statusLine.command : "";
            } catch {
              statusCommand = "";
            }
            const accountFlag = `--account ${profile.id}`;
            const configured = statusCommand.includes("claude-statusline") && (
              statusCommand.includes(accountFlag) ||
              (profile.id === "default" && !statusCommand.includes("--account"))
            );
            checks.push({
              check: t("cli.doctor.check.claude-status-line", {
                account: account.account,
              }, outputLocale),
              ok: configured || statusLine?.health === "recent-success",
              detail: configured
                ? t("cli.doctor.configured-in", { path: claudeSettings }, outputLocale)
                : t("cli.doctor.oauth-off", {
                  path: claudeSettings,
                  command: `${preferredBin()} claude-statusline ${accountFlag}`,
                }, outputLocale),
            });
          }
        }
        if (jsonOutput) console.log(JSON.stringify(checks, null, 2));
        else {
          for (const check of checks) console.log(`${check.ok ? "✓" : "○"} ${check.check}: ${check.detail}`);
        }
        // A collection failure now fails the command. Only a missing config
        // file stays informational.
        return checks.some((check) => !check.ok && check.check !== configCheck) ? 1 : 0;
      }
      case "test-alert": {
        const delivery = await deliverTestAlertThroughDaemon(config) ?? await service.deliverTestAlert();
        const ok = delivery.complete;
        console.log(delivery.nativeAppQueued
          ? ok
            ? t("cli.test-alert.native-ok", {}, outputLocale)
            : t("cli.test-alert.native-partial", {}, outputLocale)
          : ok
            ? t("cli.test-alert.channels-ok", {}, outputLocale)
            : t("cli.test-alert.channels-failed", {}, outputLocale));
        return ok ? 0 : 1;
      }
      case "watch": {
        console.log(t("cli.watch.started", {}, outputLocale));
        await service.watch();
        return 0;
      }
      case "serve": {
        dashboard = startDashboard(service, config);
        console.log(t("cli.serve.started", {
          url: `http://${config.dashboard.host}:${dashboard.port}`,
        }, outputLocale));
        await service.watch();
        return 0;
      }
      default:
        console.error(`${t("cli.error.unknown-command", { command }, outputLocale)}\n\n${help(outputLocale)}`);
        return 2;
    }
  } finally {
    dashboard?.stop(true);
    await service.close().catch(() => undefined);
  }
}

const exitCode = await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[quotapie] ${t("cli.error.prefix", {}, outputLocale)}: ${message}`);
  return 1;
});
process.exitCode = exitCode;
