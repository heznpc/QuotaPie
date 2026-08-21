# QuotaPie

A local timer that tracks the 5-hour and weekly limits of Codex and Claude against the provider's own clock, and predicts when you will run dry based on how you personally work.

It does not simply compute `first use + 5 hours`. When a scheduled reset time passes, it does not zero out your usage locally; it records a refill only once a provider snapshot confirms one actually happened.

The everyday surface is a **native macOS menu bar app**. The CLI is for diagnosis and automation, and the web view is optional, for when you want a closer look. The menu bar app reads from a quiet local collector on `127.0.0.1`, so no browser needs to stay open.

## What is different here

- Codex uses the official `codex app-server`: `account/rateLimits/read` plus its update events.
- Claude collects through one of two paths. The default is the official status-line JSON. Turning on `collection.claudeOAuthEnabled` makes the official `api/oauth/usage` endpoint — read with Claude Code's local OAuth credentials — the primary source. If you only use the desktop app, the status line never runs, so samples never accumulate; that is the case where you want this switch on.
- When both sources are alive, a recent OAuth reading is authoritative and the status-line value stays out of the history. This stops equivalent values from arriving under a different source name and manufacturing noise events.
- Collection health is stored **per source**, not per account, and account health is derived from the best of them. An OAuth failure cannot overwrite a status-line collection that just succeeded.
- The menu bar title is one conclusion, not a row of provider abbreviations. It picks the **highest risk**, not the lowest remaining percentage — 89% left still reads as `⚠ weekly at risk` if you are on course to run dry six days before the reset.
- `doctor` and `/health` judge by actual collection results, not by whether configuration exists. An account with zero samples does not pass.
- Provider emails, remote account IDs, OAuth tokens, cookies, prompts, and conversation content are never stored. Multiple accounts are distinguished only by a local alias you choose.
- 5-hour, weekly, and per-model windows are tracked independently.
- With several Claude sessions open at once, the raw session IDs are never stored; the latest value per short hash is reconciled so that a stale window cannot roll back a newer usage figure.
- Codex promotional and per-model entries retire automatically after disappearing from two consecutive full responses, so no ghost timers are left behind.
- Normal resets, early external resets, possible allowance increases or server corrections, reset-clock rebases, and paid credit changes are each recorded as distinct events.
- The exhaustion forecast blends your burn over the last two hours with your personal pace over the last 28 days, split by weekday/weekend and neighbouring hours.
- Only your configured active hours count as remaining working time, and whichever of the 5-hour or weekly window is more dangerous is shown as the current bottleneck.
- macOS notifications and an optional external command trigger are supported.
- Multiple Codex and Claude accounts are separated by profile directory and local alias; history, personal pace, bottleneck, and alert cooldowns are all isolated per account.
- Alerts follow an honesty rule: if recent measured usage is zero, no pace warning is sent. Present-tense wording ("burning too fast") is reserved for a measured burn rate above the safe pace; when only the habitual pattern exceeds it, the wording is forward-looking ("pace forecast").
- Collection state is a four-state heartbeat (never-attempted / attempted-then-failed / stale-success / recent-success) so that a stalled collector and a disabled one do not wear the same face.
- The burn leaderboard reads only token counts, paths, and timestamps (`cwd`, `usage`, `timestamp`) from Claude Code transcripts. Conversation content is never used, stored, or transmitted. Transcripts are line-delimited JSON, so reaching those fields does require parsing the lines that contain them — the accurate claim is "the content is not used", not "the content is never touched". Lines without the fields of interest are not parsed at all.

## Integration boundary: quota.json

External consumers (for example [Modore](https://github.com/heznpc/Modore)) read exactly one file: `~/Library/Application Support/QuotaPie/quota.json`. The service rewrites it atomically (temp + rename, `0600`) on every tick.

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-08-17T…",           // consumers hide the display entirely once this goes stale
  "collection": {
    "lastSampleAt": "…", "healthy": true,   // if healthy=false, show "collection stalled" instead of old numbers
    "providers": { "codex": "recent-success", "claude": "never-attempted" }
  },
  "window": { "provider": "codex", "usedPercent": 66, "resetsAt": "…" },  // the single global bottleneck
  "headline": {                             // semantic fields are the contract
    "kind": "pace-risk", "windowKind": "weekly", "remainingPercent": 89,
    "exhaustsAt": "…", "errorCategory": null,
    "displayText": "⚠ weekly at risk"       // convenience for consumers that do not localise
  },
  "topBurn": [ { "remote": "github.com/…", "percent": 42.0, "lastActiveAt": "…" } ]
}
```

Removing a field or changing its meaning bumps `schemaVersion`. Version 2 replaced the headline's finished sentence with semantic fields plus `displayText`, so a consumer can render in its own language rather than inheriting this process's locale.

## Claude OAuth collection must be turned on

`collection.claudeOAuthEnabled` defaults to `false`. This path **reads the OAuth credentials Claude Code stored** in order to call the official usage endpoint. Touching credentials another application keeps is not something that should begin because you ran an installer, so it runs only when you explicitly enable it. While it is off, credentials are not looked up at all — including when `doctor` forces a diagnostic run.

```json
{ "collection": { "claudeOAuthEnabled": true } }
```

The token is read per call and never lands in QuotaPie's storage, logs, or API responses. If you would rather not enable it, configure the Claude status line hook and use that as the fallback path. With neither in place, that account reads as "not configured" — distinguished from broken, not lumped in with it.

## Language

The interface is English by default. Korean is a locale, not the substrate.

The backend moves meaning rather than prose: an event carries its kind and its
parameters, a headline carries what it concluded and about which window. Each
surface then makes the sentence — the menu bar app in the viewer's macOS
language, the web view in the browser's, the CLI and macOS notifications in
whatever `profile.locale` resolves to.

```json
{ "profile": { "locale": "auto" } }
```

`auto` reads `QUOTAPIE_LOCALE`, `LC_ALL`, `LC_MESSAGES`, then `LANG`, and falls
back to English. Set `"en"` or `"ko"` to pin it. The menu bar app follows the
system language on its own and also honours `QUOTAPIE_LOCALE`.

Adding a language means adding one column to two tables — `src/i18n.ts` for the
backend and `macos/QuotaPie/Strings.swift` for the app — plus the table in the
web view. The keys are deliberately identical across all three, and a missing
key renders as the key itself rather than as blank space.

## Reading collection state

`quota.json`, `/health`, and the menu bar app all use the same four states. The point is to separate "it is switched on" from "values are actually arriving".

| State | Meaning | How surfaces treat it |
|---|---|---|
| `never-attempted` | never tried once | setup required |
| `attempted-then-failed` | tried, no successful sample on record | show the failure category with its recovery step |
| `stale-success` | succeeded before, but not recently | show "collection delayed" instead of a number |
| `recent-success` | a recent sample exists | show normally |

Failures are classified as `auth-required`, `auth-expired`, `rate-limited`, `network`, `not-configured`, `isolation-unsafe`, `provider-error`, or `no-windows`. Credential values themselves never appear in any field.

For the default profile, Claude credentials are **read only** from `~/.claude/.credentials.json` or the `Claude Code-credentials` keychain item. A profile with its own `configDir` looks for keychain service names derived from that directory and does not fall back to the default item — falling back would attribute another account's token to this one. If your credentials live somewhere non-standard, name the item with `keychainService` in the account config.

## Requirements

- macOS
- [Bun](https://bun.sh/) 1.3+
- A logged-in Codex CLI
- Claude Code 2.1.80+ if you track Claude
- The Apple Swift toolchain if you build the menu bar app from source

The project installs no additional runtime packages. SQLite and the HTTP server come from Bun itself.

## Prior work and sources

- [The Codex App Server rate-limit API](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md): the basis for `usedPercent`, the provider's `resetsAt`, and the distinction between full reads and sparse updates.
- [Codex authentication storage](https://learn.chatgpt.com/docs/auth): how the CLI login cache and per-`CODEX_HOME` `auth.json` behave, used for multi-profile isolation.
- [Claude Code's official status-line data](https://code.claude.com/docs/en/statusline): the basis for `five_hour`/`seven_day`, the fields that can be missing, and cancellation behaviour mid-run.
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars): `CLAUDE_CONFIG_DIR`, used to run several accounts side by side.
- [CodexBar](https://github.com/steipete/CodexBar): reference for showing several providers, several windows, stale state, and reset countdowns at a glance.
- [ccusage](https://github.com/ryoppippi/ccusage): reference for using local records for long-term analysis. QuotaPie focuses on the provider quota clock and personal burn rate rather than token cost accounting.

## Quick start

```bash
cd /path/to/quotapie
./bin/quotapie init
./bin/quotapie doctor
./bin/quotapie serve
./script/build_and_run.sh --verify
```

After that, the single conclusion in the menu bar is all you need to read (`56% left`, `⚠ weekly at risk`, `Limits unconfirmed`, `Setup needed`). `serve` is not a browser command: it runs collection, alerts, and the local API that the menu bar app reads. Open the detailed web view only when you want it, from the menu or at [http://127.0.0.1:47831](http://127.0.0.1:47831).

To use the CLI from anywhere, add the project's `bin` to your `PATH`, or link `bin/quotapie` into a local bin directory of your choice.

For real use, keep the runtime in `~/.local/lib/quotapie` and link it as `~/.local/bin/quotapie`. macOS can block `launchd` from reaching Documents with `Operation not permitted`, so the resident service and the Claude status line are more reliable when they run from a copy outside that protected path. The source directory stays the reference copy.

## The menu bar app

`script/build_and_run.sh` handles the SwiftPM build, the `.app` bundle, ad-hoc signing, and launching in one step. The Run button in the Codex app is wired to this script too.

```bash
./script/build_and_run.sh            # build, then run
./script/build_and_run.sh --verify   # also confirm the process is running
```

To start it at login, first copy the built app into your user Applications folder, then register a LaunchAgent separate from the backend's.

```bash
mkdir -p ~/Applications ~/Library/LaunchAgents
ditto dist/QuotaPie.app ~/Applications/QuotaPie.app
./bin/quotapie menubar-launchd > /tmp/local.quotapie.menubar.plist
plutil -lint /tmp/local.quotapie.menubar.plist
cp /tmp/local.quotapie.menubar.plist ~/Library/LaunchAgents/local.quotapie.menubar.plist
pkill -x QuotaPie 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.quotapie.menubar.plist
```

Collection and alerts keep running even if the menu bar app quits. Quitting from the menu deliberately does not immediately relaunch it, but the LaunchAgent does restart it after an abnormal exit.

## Connecting Claude

`./bin/quotapie init` prints a fragment like the one below. Merge it into your existing `~/.claude/settings.json` while preserving your other settings. If you already have a `statusLine`, do not overwrite it — have your existing script pass the same JSON on to `quotapie claude-statusline`.

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.local/bin/quotapie claude-statusline --account default",
    "padding": 1
  }
}
```

Claude's `rate_limits` field only appears after the first API response. When the value is absent, QuotaPie leaves it `unknown` rather than turning it into `0% used`, so no phantom 100% refill is invented.

The status-line process can be cancelled when Claude redraws its screen, so it does only what is fast: store the observation and render one line. Actual notifications and external triggers are picked up from SQLite's undelivered events by the resident `watch`/`serve` process.

## Multiple accounts

An account ID is a local alias in the form `[a-z0-9][a-z0-9._-]{0,31}`, not an email address. `id` is the immutable key that ties history together, so do not swap a different login into an existing ID; change `label` if you only want a different display name.

```json
{
  "accounts": {
    "codex": [
      { "id": "default", "label": "Personal", "codexHome": "~/.codex", "enabled": true },
      { "id": "work", "label": "Work", "codexHome": "~/.codex-work", "enabled": true }
    ],
    "claude": [
      { "id": "default", "label": "Personal", "configDir": "~/.claude", "enabled": true },
      { "id": "work", "label": "Work", "configDir": "~/.claude-work", "enabled": true }
    ]
  }
}
```

Codex logs in separately per `CODEX_HOME`. To keep several profiles from collapsing into a single OS credential store, put `cli_auth_credentials_store = "file"` in each directory's `config.toml` before logging in. In a multi-account setup, QuotaPie refuses to collect from a profile that lacks this, which prevents double-counting the same login.

```bash
CODEX_HOME=~/.codex codex login
CODEX_HOME=~/.codex-work codex login
```

The default single account's `codexHome: null` is a backward-compatible setting that inherits the current shell's `CODEX_HOME`, or `~/.codex`. With multiple accounts, naming every home explicitly is safer.

Claude separates settings, session history, and plugin paths with `CLAUDE_CONFIG_DIR`. The official documentation names this variable for running several accounts in parallel; the macOS login credentials themselves remain in the system keychain. Log in under each profile, and pin the same alias in each `settings.json` status line.

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.local/bin/quotapie claude-statusline --account work",
    "padding": 1
  }
}
```

Check configured profiles with `quotapie accounts`, and per-account collection results with `quotapie doctor`. If one Codex account's authentication fails, observations from the others keep being stored. An account with `enabled: false` keeps its past data and is only hidden from display, collection, and alerts, so re-enabling it resumes the personal pace it had learned.

## Commands

```text
quotapie init                 create a default personal config and print integration steps
quotapie poll                 read the Codex source once
quotapie status               show current limits, pace, and forecast exhaustion
quotapie status --account ID  show a single local account alias
quotapie status --json        structured output for automation
quotapie explain              show the reasoning behind recent changes
quotapie accounts             show account aliases and profile roots
quotapie claude-statusline --account ID
                               store an observation for that Claude profile
quotapie watch                run only the adaptive timer and alerts
quotapie serve                run the timer, alerts, and the local dashboard
quotapie doctor               check collectors and connection state
quotapie test-alert           actually deliver through the configured alert channels
quotapie launchd              print a plist for running as a resident service
quotapie menubar-launchd      print a plist for launching the menu bar app
```

## Personalisation

Configuration lives in `~/.config/quotapie/config.json` and data in `~/.local/share/quotapie/quotapie.sqlite3`. Environment variables move both, which is useful for testing or isolation.

```bash
QUOTAPIE_CONFIG=/path/config.json QUOTAPIE_HOME=/path/data ./bin/quotapie status
```

The settings that matter most:

```json
{
  "profile": {
    "timeZone": "Asia/Seoul",
    "recentLookbackMinutes": 120,
    "historyDays": 28,
    "recentWeight": 0.7,
    "workSchedule": {
      "weekday": [{ "start": "09:00", "end": "02:00" }],
      "weekend": [{ "start": "11:00", "end": "01:00" }]
    }
  },
  "reservePercent": {
    "codex": { "short": 10, "weekly": 15, "other": 10 },
    "claude": { "short": 10, "weekly": 15, "other": 10 }
  },
  "accounts": {
    "codex": [{ "id": "default", "label": "Main", "codexHome": null, "enabled": true }],
    "claude": [{ "id": "default", "label": "Main", "configDir": "~/.claude", "enabled": true }]
  },
  "collection": {
    "claudeSessionTtlSeconds": 900
  }
}
```

- `recentWeight`: how strongly today's measured pace overrides your long-term personal pattern. With few samples, the long-term pattern automatically carries more weight.
- `workSchedule`: ranges may cross midnight. `09:00`–`02:00` means 9am until 2am the next day.
- `reservePercent`: the safety margin you want left when the reset arrives.
- `accounts.*[].id`: the stable local alias used in the database and alerts. It must be unique within a provider.
- `codexHome` / `configDir`: the per-account profile root. Two enabled accounts sharing a directory is rejected at startup.
- `alerts.remainingThresholds`: the remaining-percentage steps that trigger alerts.
- `alerts.staleProviders`: providers for which idle data should raise a fault alert. Claude is excluded by default because it is response-driven.
- `alerts.command`: an extra trigger, executed as an exact argv array without a shell. The decision JSON is passed in the `QUOTAPIE_EVENT_JSON` environment variable.
- `alerts.deliveryTimeoutSeconds`: the longest a single alert channel may hold up the resident collection loop.
- `collection.claudeSessionTtlSeconds`: how long the highest usage among several Claude sessions in the same reset window is held as the consensus.

With both macOS notifications and an external command enabled, delivery counts as complete only when every configured channel succeeds. Channels that already succeeded are recorded individually so a retry does not run them twice. An explicit failure logs the channel and its exit code and is retried on the next collection cycle; a claim left behind by a process that died mid-delivery is reclaimed after a five-minute lease.

For example, to run a macOS Shortcut alongside the notification:

```json
{
  "alerts": {
    "command": ["/usr/bin/shortcuts", "run", "QuotaPie Alert"]
  }
}
```

## Classification rules

| Observation | QuotaPie's verdict |
|---|---|
| Usage drops near the scheduled reset and a new reset time appears | normal reset; a small drop only lowers confidence |
| Usage drops before the scheduled time and the clock is reset too | external refill or manual reset; a small drop only lowers confidence |
| The reset time is unchanged but usage drops sharply | cannot distinguish a reset from an allowance increase or a server correction |
| Usage is unchanged but the reset time moves | timer resynchronisation |
| The source value is null or missing | unknown; the previous value is kept as history only |
| The scheduled time has passed with no new source value | reset_due; no phantom refill |
| The credit balance falls | paid usage warning |
| The provider exposes a banked reset count and it falls | a banked reset was likely consumed |

`quotapie explain` shows the verdict and the reasoning behind each change.

## Running as a resident service

QuotaPie does not install `launchd` files for you. It prints them so you can read them first.

```bash
./bin/quotapie launchd > /tmp/local.quotapie.plist
plutil -lint /tmp/local.quotapie.plist
```

Once you have reviewed it, move it to `~/Library/LaunchAgents/local.quotapie.plist` and register it yourself. QuotaPie performs no system changes such as deleting or overwriting on your behalf.

```bash
mkdir -p ~/Library/LaunchAgents
cp /tmp/local.quotapie.plist ~/Library/LaunchAgents/local.quotapie.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.quotapie.plist
launchctl print "gui/$(id -u)/local.quotapie"

# stop and remove
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/local.quotapie.plist
rm ~/Library/LaunchAgents/local.quotapie.plist
```

If you generate the plist with `QUOTAPIE_CONFIG` and `QUOTAPIE_HOME` set, those paths are pinned into the plist as well.

The data directory is corrected to `0700`, and the config, SQLite, WAL, and log files to `0600`. Analysis snapshots are retained for your configured `historyDays` plus a day of slack, and events for 180 days. The most recent snapshot of each entry is kept even when it is old, so current state can still be displayed.

## Verification

```bash
bun run check
```

The tests cover low-usage normal and early resets, reset-clock rebases, allowance relief where only the ratio falls, null data, out-of-order responses, multi-session Claude consensus, multi-account isolation and validation, per-account alert keys, retirement of dynamic Codex entries, durable alert claims, file permissions, paid credits, personal burn rate, bottleneck selection, and dynamic rescheduling.

## Limitations

- Personal Claude subscriptions have no public always-on quota webhook. Provider-side changes while Claude is idle are only confirmed when the next Claude response refreshes the status line.
- A lower usage figure within the same Claude reset window can be reflected conservatively late — by default 15 minutes — until the higher value from another active session ages out.
- Each Claude account updates when the Claude belonging to that `CLAUDE_CONFIG_DIR` responds and runs the status line.
- Logging out of a profile directory and logging into a different remote account mixes the new usage into the old learning. Use a fresh profile directory and a fresh local ID for a different login.
- When only percentages are available, deleted usage cannot be fully distinguished from an increased limit denominator. Those cases are recorded as `allowance_relief` rather than stated as fact.
- Banked reset events are detected only when the provider actually exposes that count. QuotaPie itself never purchases credits or consumes a banked reset.

## License

MIT. See [LICENSE](LICENSE).
