# QuotaPie

A local timer that tracks the 5-hour and weekly limits of Codex and Claude against the provider's own clock, and predicts when you will run dry based on how you personally work.

It does not simply compute `first use + 5 hours`. When a scheduled reset time passes, it does not zero out your usage locally; it records a refill only once a provider snapshot confirms one actually happened.

The everyday surface is a **native macOS menu bar app**. The CLI is for diagnosis and automation, and the web view is optional, for when you want a closer look. The menu bar app reads from a quiet local collector on `127.0.0.1`, so no browser needs to stay open.

## What is different here

- Codex uses the official `codex app-server`: `account/rateLimits/read` plus its update events.
- Claude collects through one of two paths. The default is the official status-line JSON. Turning on `collection.claudeOAuthEnabled` makes the official `api/oauth/usage` endpoint — read with Claude Code's local OAuth credentials — the primary source. If you only use the desktop app, the status line never runs, so samples never accumulate; that is the case where you want this switch on.
- When both sources are alive, a recent OAuth reading is authoritative and the status-line value stays out of the history. This stops equivalent values from arriving under a different source name and manufacturing noise events.
- Collection health is stored **per source**, not per account, and account health is derived from the best of them. An OAuth failure cannot overwrite a status-line collection that just succeeded.
- The menu bar shows the provider, window, and measured remaining percentage. Quota bars in the menu bar, popover, native details, and web dashboard all show remaining capacity: 100% is full and the fill shrinks with use. The shortest fresh window duration leads, regardless of plan or remaining percentage; remaining quota only breaks ties between equal durations. Unknown durations follow known ones. For Codex, only general limits compete for the menu bar; separate model allowances such as Spark remain in the account details.
- The popover is a bounded overview: choose an account, read its remaining quota, see up to three paused tasks and the latest reset post's current meaning. Fresh remaining quota below 20% turns red in the menu bar, overview, and quota details; exactly 20% keeps its normal color. Stale readings stay explicitly marked. A reusable detail window holds all quota windows, recovery history, paused-task actions, reset originals, and settings; the popover has one action row and no scrolling feed. Paused tasks are observed quota waits, not an inferred list of running sessions.
- Local API timeouts, lost connections, and unreadable responses have separate explanations. A connection failure keeps the last measured percentage beside its cause and retries automatically; it does not mean the quota is zero. Failure-category changes and recovery are recorded in the app's `StatusSync` log category.
- Reset announcements retain their uncertainty: a passed announcement time is not account recovery, and relayed posts remain source-unverified. Full source text, collection details, timestamps, and corrections remain available in Reset history. Development fixture previews are labelled and do not create a second menu bar meter.
- `doctor` and `/health` judge by actual collection results, not by whether configuration exists. An account with zero samples does not pass.
- Quota collection never stores provider emails, remote account IDs, OAuth tokens, cookies, prompts, or conversation content. Separately, explicitly registered execution jobs persist their instructions, results, and owned session references in the private local database for checkpoint recovery; those fields are excluded from status and integration files.
- 5-hour, weekly, and per-model windows are tracked independently.
- With several Claude sessions open at once, quota collection stores only short hashes; the latest value per hash is reconciled so that a stale window cannot roll back a newer usage figure.
- Codex promotional and per-model entries retire automatically after disappearing from two consecutive full responses, so no ghost timers are left behind.
- Normal resets, early external resets, possible allowance increases or server corrections, reset-clock rebases, and paid credit changes are each recorded as distinct events.
- Measured consumption uses elapsed time, including overnight work. A refill, reset-clock change, or authenticated collector change starts a new rate baseline. Forecasts require recent measured usage and estimate actual exhaustion, not entry into a hidden safety reserve.
- Codex reloads its resident collector when the profile credential file changes. Opaque collection epochs keep old account history and disappeared windows out of the current display; raw account identifiers and credential-file contents are not stored.
- While the collector is running, Codex account continuity and the quota response's plan type distinguish a different login from a plan change on the same login. Both start a new usage baseline and have separate notifications. A window-duration change alone reports an unverified cause; token refreshes and collector restarts do not prove an account change. Email is compared only in memory, with random session-scoped continuity markers persisted instead.
- After a detected account or plan change, the overview stops attaching earlier recovery records to the current quota. Those events remain in activity history, and a later observed recovery appears normally.
- Temporary account lookup failures retain the last trusted snapshot and resident comparison context until a retry succeeds. An older provider that explicitly lacks `account/read` can still provide quota; a known plan change separates its anonymous usage baselines. Change notifications identify the configured local account label.
- With the resident menu bar app connected, macOS notifications are posted by QuotaPie itself, so Notification Center attributes them to QuotaPie rather than to a script runner. `watch` and a clean older-app installation retain the legacy script notification as an upgrade fallback. An optional external command trigger is also supported.
- Multiple Codex and Claude accounts are separated by profile directory and local alias; history, personal pace, bottleneck, and alert cooldowns are all isolated per account.
- Notifications default to remaining-quota thresholds (20%, 10%, 5%) and an observed drop of at least 10 percentage points within 10 minutes. `alerts.rapidDropPercent` and `alerts.rapidWindowMinutes` set that rule. Speculative pace notifications require `alerts.paceForecasts: true`. The app shows notification permission status and a settings shortcut. After permission returns, it re-evaluates suppressed thresholds against current quota instead of replaying old messages.
- Collection state is a four-state heartbeat (never-attempted / attempted-then-failed / stale-success / recent-success) so that a stalled collector and a disabled one do not wear the same face.
- The burn leaderboard reads only token counts, paths, and timestamps (`cwd`, `usage`, `timestamp`) from Claude Code transcripts. Conversation content is never used, stored, or transmitted. Transcripts are line-delimited JSON, so reaching those fields does require parsing the lines that contain them — the accurate claim is "the content is not used", not "the content is never touched". Lines without the fields of interest are not parsed at all.

The native settings window lets you select Sol, Luna, or Terra for future Astra compression requests, with the validated Low effort. It applies the choice to reachable relay generations that support live policy changes and shows how many acknowledge the selected model; older routes may retain their previous policy. Running requests keep their original policy snapshot. Activity groups compression start/end and the model of a later observed request from the same task (and the same turn when the turn ID is known). Unobserved follow-up models stay unverified. A bounded private metadata record preserves observed continuations after the relay’s live history rolls over.

## Integration boundary: quota.json

Task-specific navigation uses a separate work continuity contract; quota.json v2 remains unchanged.

External consumers (for example [Modore](https://github.com/heznpc/Modore)) read the overview file: `~/Library/Application Support/QuotaPie/quota.json`. The service rewrites it atomically (temp + rename, `0600`) on every tick.

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
    "kind": "normal", "windowKind": "weekly", "remainingPercent": 89,
    "exhaustsAt": "…", "errorCategory": null,
    "displayText": "Codex weekly 89% left"       // convenience for consumers that do not localise
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
language, the web view in the browser's, and the CLI in whatever
`profile.locale` resolves to. Native notifications carry a message key and
parameters through the durable outbox, then the app renders them in its own
language. The finished backend sentence remains only as a rolling-upgrade and
non-native integration fallback.

```json
{ "profile": { "locale": "auto" } }
```

`auto` reads `QUOTAPIE_LOCALE`, `LC_ALL`, `LC_MESSAGES`, then `LANG`, and falls
back to English. Set `"en"` or `"ko"` to pin it. The menu bar app follows the
system language on its own and also honours `QUOTAPIE_LOCALE`.

Adding a language means extending the typed catalog in `src/i18n.ts`, adding a
standard `.lproj/Localizable.strings` resource for the macOS app, and extending
the browser catalog. Native alert and event keys match the backend contract;
event keys also match the browser catalog. Tests reject a key missing from one
of those consumers. A missing or newer key falls back to the compatibility
sentence instead of silently producing a blank notification.

## Reading collection state

`quota.json`, `/health`, and the menu bar app all use the same four states. The point is to separate "it is switched on" from "values are actually arriving".

| State | Meaning | How surfaces treat it |
|---|---|---|
| `never-attempted` | never tried once | setup required |
| `attempted-then-failed` | tried, no successful sample on record | show the failure category with its recovery step |
| `stale-success` | succeeded before, but not recently | retain the last percentage and mark it as a past reading |
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

Collection and alert evaluation keep running even if the menu bar app quits. Native alerts already accepted into the outbox wait for the app to return; optional command triggers keep running. Quitting from the menu deliberately does not immediately relaunch it, but the LaunchAgent does restart it after an abnormal exit.

The first native alert asks for macOS notification permission. The collector commits each alert to a local outbox, and the app claims it before handing it to Notification Center. This keeps alerts durable while the app restarts without giving the collector any notification credentials. Once an app has registered this native path, that database stays on the app-owned outbox rather than later bypassing a denied app permission through `osascript`; queued items wait up to 24 hours for the app. Run `serve`, rather than `watch`, when using the menu bar app; `serve` owns the loopback API that drains this outbox.

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
quotapie pause                register the current task for a user-approved resume
quotapie pause --provider codex --session UUID [--account ID] [--bucket ID]
                               register explicitly when session environment variables are absent
quotapie claude-statusline --account ID
                               store an observation for that Claude profile
quotapie watch                run only the adaptive timer and alerts
quotapie serve                run the timer, alerts, and the local dashboard
quotapie doctor               check collectors and connection state
quotapie test-alert           hand a test alert to the configured channels
quotapie launchd              print a plist for running as a resident service
quotapie menubar-launchd      print a plist for launching the menu bar app
quotapie codex -- -m gpt-6-astra
                               run Codex with experimental Sol compaction routing
```

## Experimental Codex compaction routing

`quotapie codex` launches a Codex process through a private loopback relay. By
default, Astra performs the task and Sol handles only its compaction requests,
including automatic compaction in the middle of a turn. The next ordinary
request still uses Astra; QuotaPie does not interrupt or replay the turn.

```bash
quotapie codex -- -m gpt-6-astra
quotapie codex -- resume -m gpt-6-astra SESSION_UUID
quotapie codex --codex-bin /path/to/codex -- app-server --stdio
```

From an uninstalled source checkout, replace `quotapie` with `bun run src/cli.ts`.
The command uses `collection.codexCommand` unless `--codex-bin` is supplied, and
inherits the current Codex login and `CODEX_HOME`. It requires a ChatGPT login;
API-key providers are outside this experiment. `--compact-from` and
`--compact-model` override the source and compaction model names. Other model
pairs require their own compatibility check.

The relay recognizes the final `compaction_trigger` input control on
`/responses`, or the legacy `/responses/compact` endpoint. Existing summaries
and text mentioning compaction do not trigger routing. The compaction request
gets an independent model and **Low** reasoning effort. Other reasoning fields
and the rest of the request are retained; ordinary requests keep their exact
model, effort, and body. This does not write Codex thread or turn settings.
The validated target set is Sol, Luna, and Terra at Low from Astra; Spark and
other unvalidated pairs are rejected before routing is enabled.
This follows Codex's [native compaction request construction](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2_attempt.rs).

The relay forwards to the fixed ChatGPT Codex backend over HTTPS, with streaming
HTTP rather than WebSocket transport. It binds only to `127.0.0.1`, uses an
unguessable per-process path, and stops with the child process. Credentials and
conversation bodies pass through memory; QuotaPie does not save them. Its own
stderr messages contain structured request IDs, validated thread/turn IDs when
present, model pairs, requested/effective effort, lifecycle phase, HTTP status,
and timing. Conversation text and opaque control values are never logged. Codex
continues to manage its own session storage and authentication. Cancellation
reaches the upstream request, and provider errors retain Codex's normal retry
handling. QuotaPie adds no retry or fallback to a different account.

The wrapper is an opt-in **CLI/app-server launch path** and makes no persistent
changes to Codex configuration. Resume through the same wrapper to keep routing
active. The optional desktop installation below configures a resident relay.
The menu bar does not enable it yet. HTTP transport can also change ordinary
request latency, so this is not a promise of faster end-to-end work.

### Install locally for the Codex desktop app

On macOS with Bun and Python 3.11+, explicitly install the resident relay:

```bash
python3 scripts/codex-compaction-local.py install
quotapie-compaction status
```

The installer builds a separate generation under
`~/.local/lib/quotapie-compaction/releases/`, starts a new launchd listener,
and verifies its loopback health before updating `~/.codex/config.toml`.
`current.json` points to the active generation. Existing generations, their
binaries, settings, and listeners stay alive for already-loaded tasks.
Candidate startup, health, or activation failure retains the previous service;
configuration rollback preserves unrelated concurrent edits. It adds a marked `openai_base_url`
override and backs up the original configuration. This keeps the built-in
`openai` provider identity, existing tasks, and selected model. An existing
custom endpoint or different provider is rejected rather than overwritten.
The relay responds to WebSocket upgrades with HTTP 426, which Codex uses to
switch that session to streaming HTTP.

**Quit and reopen Codex after current work finishes to apply the new generation
to already-loaded tasks.** Their old connection remains usable in the meantime.
Newly loaded tasks use the new endpoint. `status` distinguishes installed,
configured, and running, and lists generations retained for loaded tasks.
No automatic compaction threshold is changed in the real profile.

Version 2 health reports attempted, completed, failed, cancelled, and unverified
compactions separately. A response header is not completion: native SSE needs a
successful `response.completed` event; a disconnect before that is cancellation.
Codex closes its reader after the terminal event, which is a successful completion.
The request's stream flag covers native Responses Lite responses without a
Content-Type header. Legacy JSON requires a recognizable compacted result.
The last 32 terminal requests and currently active requests are retained in
memory with validated thread/turn IDs; aggregate counters alone are never proof
that a particular task switched.

QuotaPie shows the actual compaction model, reasoning effort, elapsed time and
result in the popover, with request history in Activity. It reads both live
health and bounded log tails from every retained relay generation. A missing
terminal record is unverified, never inferred successful from HTTP 200. The
composer's task model stays unchanged. Legacy relays without request identities
are reported as having unavailable live observation; they are not stopped.

Change compaction policy independently of the Codex work-model picker:

```bash
quotapie-compaction configure --compact-model gpt-5.6-sol --compact-effort low
```

A policy change affects future compaction requests. In-flight requests retain
their captured policy. The Codex model picker still sets persistent work intent;
manually changing it is **not** a temporary compaction setting. There is no
hidden `thread/settings/update` or stale-snapshot restoration that overwrites a
user's later selection. The request-level guarantee is Astra/xhigh work →
Sol/Low compaction → Astra/xhigh work, while Codex's saved work settings remain
Astra/xhigh throughout.

To roll back:

```bash
quotapie-compaction disable
# Quit and reopen Codex, then:
quotapie-compaction stop
```

Disable removes only QuotaPie's marked config block, preserving subsequent
unrelated edits. It changes all retained generations into pass-through relays so
loaded tasks can continue while you restart Codex. Stop drains version 2
listeners and unloads only those without active requests; rerun it after pending
requests finish. Legacy version 1 listeners cannot prove they are idle and are
reported as retained rather than automatically terminated. Configuration
backups and generation directories remain available.
The relay starts again at login while enabled; if it stops unexpectedly, launchd
restarts it. Codex requests depend on this local service until the configuration
is disabled and the task is reloaded.

### Reproduce the live check

This explicitly uses the existing account's quota. The probe creates a private
temporary profile and empty workspace, then provides synthetic facts only in a
single synthetic tool result. A lower compaction threshold forces native
mid-turn compaction. The probe checks saved settings after compaction, then
starts a second turn **without model or effort overrides** and checks settings
and factual recall again. No manual compaction or model-switch RPC is sent.

```bash
python3 scripts/probe-codex-compaction.py --codex-bin /path/to/codex
# Exercise the installed daemon through the built-in OpenAI provider:
python3 scripts/probe-codex-compaction.py --codex-bin /path/to/codex \
  --effort xhigh --fixture constraints \
  --relay-settings ~/.local/lib/quotapie-compaction/current.json
```

Verified with Codex CLI **0.153.4** on **2026-09-12**: native automatic compaction
was routed Astra → Sol, the Astra turn completed, and all three facts survived
even though the original fact was absent from the plaintext replacement
history. The reproducible probe observed one compaction taking about 5.2 seconds.
That small synthetic result establishes interoperability, not the latency or
memory quality of long real sessions. Legacy routing has unit coverage; only
the native v2 path was exercised against the live service.
The installed desktop relay was also exercised with the built-in OpenAI provider:
one native mid-turn compaction was routed to Sol, then Astra completed with all
three facts preserved. This verifies the persistent service and configuration
path, while existing desktop tasks still require reloading.

A subsequent installed version 2 run verified **Astra xhigh → Sol Low →
Astra xhigh**, with unchanged saved thread settings and exact 12/12-field
recall in a second turn started without model or effort overrides. Native
compaction took 10.859 seconds in that one run. This does not establish
long-session quality or speed savings.

The probe also accepts `--compact-model`, `--normal-model`, `--effort` (work effort), and
`--fixture constraints` for an exact 12-field recall check with final corrections.
The 2026-09-12 model comparison
found Sol, Luna, and Terra compatible on that small fixture; Spark rejected
the native request. Single timings do not establish a production speed ranking.

## Personalisation

Configuration lives in `~/.config/quotapie/config.json` and data in `~/.local/share/quotapie/quotapie.sqlite3`. Environment variables move both, which is useful for testing or isolation.

```bash
QUOTAPIE_CONFIG=/path/config.json QUOTAPIE_HOME=/path/data ./bin/quotapie status
```

`quotapie pause` never launches an agent and never sends a prompt. It records a
SHA-256 key for the current native session plus the blocking quota bucket; the
raw session ID and working directory are not written to QuotaPie's database.
When a newer, fresh provider snapshot for that same account and bucket reports
capacity again, QuotaPie offers a resume action. Only an explicit approval
returns a structured launch plan to the local menu bar app.

Resume is intentionally bound to the same provider and account that owns the
native session. QuotaPie does not copy session state into another profile,
rotate credentials, or route a prompt to a different account. Opt-in is per
task: if `quotapie pause` was not run, there is nothing to resume.

Inside Codex or Claude, the command reads `CODEX_THREAD_ID` or
`CLAUDE_SESSION_ID`. Outside those environments, pass `--provider` and
`--session`. The account is inferred from `CODEX_HOME` or
`CLAUDE_CONFIG_DIR` when it uniquely matches a configured profile. An explicit
profile environment that matches none is rejected; without one, a sole enabled
account is used and an ambiguous multi-account setup must pass `--account`.
`--cwd` defaults to the current directory and `--label` to that directory's
base name. `--bucket` pins a specific current quota window; otherwise the
window with the least remaining capacity is captured. Codex resume also
requires the configured command's executable name to remain `codex`; wrapper
paths should therefore end with that name.

The loopback API exposes active resume tasks in `GET /api/status` together with
a process-random `actionToken`. State changes use
`POST /api/resume-tasks/:id/approve|resumed|retry|dismiss` and require that
token in `x-quotapie-action-token`. Approval returns only a structured local
launch plan; the daemon itself does not execute the command. A task becomes ready
only after a newer, fresh snapshot for the exact provider, account, and bucket
reports more remaining capacity than it had at registration. Approval checks
that fresh positive capacity again before and after session discovery. Passing
the expected reset time alone does not change its state.

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

With both macOS notifications and an external command enabled, delivery counts as complete only when every configured channel accepts the alert. The native channel's acceptance point is a committed SQLite outbox row; QuotaPie.app then claims that row and schedules it with Notification Center. Channels that already succeeded are recorded individually so a retry does not run them twice. An explicit failure logs the channel and its exit code and is retried on the next collection cycle; a claim left behind by a process that died mid-delivery is reclaimed after a five-minute lease.

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

## Storage layout

One connection, one transaction owner, several collaborators.

```text
QuotaPieService
 ├─ QuotaDatabase        snapshot / bucket / event ingestion
 ├─ AlertStore           alert claims + channel receipts + native app outbox
 ├─ CollectionStore      per-source collection heartbeat
 └─ ClaudeSessionStore   session rows in and out
      └─ selectClaudeConsensus()   pure decision, no database
```

`QuotaStorage` owns the connection, the PRAGMAs, the schema, and
`transaction()`. The stores are separate files, not separate connections:
splitting the connection would leave `BEGIN IMMEDIATE`, the alert lease, and
event delivery each atomic on their own and unrelated to one another, which is
the exact property they exist to provide.

A nested `transaction()` joins the one already in flight rather than starting a
second, and a failure inside a nested call makes the whole unit rollback-only.
Catching that failure does not let the outer unit commit: the nested writes are
part of the same transaction, so committing anyway would produce exactly the
half-state the boundary exists to prevent. Sub-units meant to be independently
recoverable would need `SAVEPOINT`, which is a different contract than the one
stated here.

`alert_state`, `event_delivery`, `alert_channel_delivery`, and the native app
outbox implement one feature between them, so one store owns them together; a
claim or durable hand-off must never have a transaction boundary through the
middle of it.

Which source is authoritative and what an account's health is are not stored
facts — they are policy, and they live in `QuotaPieService.accountStates()`.

Snapshot, bucket, and event ingestion stay together in `QuotaDatabase`, because
`classifyDelta`, the snapshot insert, the bucket-state update, and the event
insert are a single unit of work.

## Verification

```bash
bun run check
```

The tests cover low-usage normal and early resets, reset-clock rebases, allowance relief where only the ratio falls, null data, out-of-order responses, multi-session Claude consensus, multi-account isolation and validation, per-account alert keys, retirement of dynamic Codex entries, durable alert and native-notification claims, file permissions, paid credits, personal burn rate, bottleneck selection, dynamic rescheduling, exact-session resume races, API capability checks, and the native launcher's command boundary.

## Limitations

- Personal Claude subscriptions have no public always-on quota webhook. Provider-side changes while Claude is idle are only confirmed when the next Claude response refreshes the status line.
- A lower usage figure within the same Claude reset window can be reflected conservatively late — by default 15 minutes — until the higher value from another active session ages out.
- Each Claude account updates when the Claude belonging to that `CLAUDE_CONFIG_DIR` responds and runs the status line.
- Logging out of a profile directory and logging into a different remote account mixes the new usage into the old learning. Use a fresh profile directory and a fresh local ID for a different login.
- When only percentages are available, deleted usage cannot be fully distinguished from an increased limit denominator. Those cases are recorded as `allowance_relief` rather than stated as fact.
- Banked reset events are detected only when the provider actually exposes that count. QuotaPie itself never purchases credits or consumes a banked reset.

## License

MIT. See [LICENSE](LICENSE).

## Keep working with the lid closed

**Currently implemented:** the menu bar has an opt-in **Keep awake while agents
work** switch. **Connect coding agents** adds QuotaPie-owned lifecycle hooks to
enabled Codex and Claude account profiles, preserving other settings and making
backups. The equivalent CLI is `quotapie awake connect`; use
`quotapie awake disconnect` to remove those hooks. In Codex, review and trust the
new definitions in `/hooks` and start a new turn. Restart existing sessions if
necessary. Connecting does not bypass provider hook trust.

A working task holds ordinary idle sleep off. Separate sessions and profiles
have separate requests; one task finishing cannot release another task's hold.
Completion, interruption, permission/input waiting, and `quotapie pause` release
that task's request. The Mac follows its existing sleep settings afterward;
QuotaPie does not change screen timeout or force immediate sleep. An AC profile
configured to never sleep will therefore still need its normal sleep settings.

Enable **Also with the lid closed** and choose **Set up closed-lid support…** for
closed-lid operation. macOS asks for administrator authorization to install a
fixed-function helper. The UI reports ready/holding only from fresh helper
feedback, after the helper reads back `pmset`'s `SleepDisabled` state. A missing
or failed helper does not imply closed-lid protection.

The helper can only set `pmset -a disablesleep 1` and restore it to `0`. It runs
as `local.quotapie.power`, reads a bounded owner-only heartbeat, verifies its
user and the live QuotaPie process, and accepts no executable or shell commands
from that heartbeat. It does not take ownership of a pre-existing sleep
override from another utility. A durable root-owned marker restores QuotaPie's
own override after helper crashes/reboots. App exit stops the idle assertion;
a missing app heartbeat releases the closed-lid override within about 30–32
seconds while the helper is running. `launchd` restarts a crashed helper.

Both paths release at 20% battery or lower, unknown battery level while on
battery, or serious/critical macOS thermal pressure. An uninterrupted hold is
limited to eight hours. A task with no lifecycle event for 30 minutes expires;
this deliberately includes unusually long silent reasoning/tools. An app
restart requires a new task event, rather than reviving an old request.

**Design intent:** protect actual work, not the presence of an open agent app or
an increase in quota usage. The bridge parses hook input in memory but persists
only a hashed session/profile key, provider, event type, process ID, and times.
It never writes prompts, responses, tool arguments, or conversation bodies.

**Non-goals:** waking a sleeping Mac at quota reset, automatically approving
resume, observing cloud/SSH work, or guaranteeing that detached jobs/subagents
outlive their parent turn. Hooks must actually run on the Mac doing the work.
Power assertions and helper flag readback can be tested automatically; physical
lid closure and installed client hook delivery must be verified on each target
macOS/client version. Keep a working closed Mac ventilated.

To remove closed-lid support, use the built bundle's installer in uninstall mode:

```bash
sudo /bin/bash /path/to/QuotaPie.app/Contents/Resources/install_power_helper.sh uninstall "$(id -u)"
```

It stops the helper, restores only QuotaPie's owned override, then removes the
helper and launch daemon. Turn off the working-task switch and run
`quotapie awake disconnect` to remove the agent hooks as well. The original
settings backups are retained for inspection.

## Public Codex reset signals

QuotaPie can notify on **possible resets**, announcements, changes, and
withdrawals before your own quota meter changes. Enable in the local config:

```json
"resetSignals": { "enabled": true, "tokenFile": null, "pollSeconds": 300 }
```

Without a token it polls both the public [Reset Beacon alert feed](https://resetbeacon.com/api/docs/)
and quoted posts on [Codex Reset Monitor](https://codexreset.org/).
This is **partial, third-party coverage**: it is not a direct watch of every X
post. Reset history in the app shows each source's request status, coverage,
latest evidence publication time, and when additional evidence was obtained.
Successful requests do not establish complete coverage, and an older latest
post alone is not an outage. One failed source leaves the others collecting.
The monitor parser reads literal post fields and available reply context,
never executes page scripts or adopts the site's probability forecasts.
Feed classifications and time conversions are attributed to the feed; the app
does not certify the source post or account eligibility. A future promise is
not displayed as already executed merely because the feed calls it an action.

For direct X collection alongside the public relays, set `tokenFile` to an owner-only (0600) file containing
an X API Bearer Token. Tokens are read at request time, never placed in the
SQLite records or status API. The official X API requires developer access and
can incur usage charges. Five fixed accounts are watched: **thsottiaux,
reach_vb, dkundel, OpenAIDevs, OpenAI**. Search includes replies and quote posts;
referenced posts and conversation roots supply bounded context. A deterministic
first version classifies English reset phrases and several contextual hints;
it can miss jokes, images, and novel wording. No LLM key is required. Relative
times remain as original wording instead of guessing the author's timezone.

Collection runs independently of quota polling, at most every five minutes by
default. Errors preserve history and the last successful cursor; API responses,
pagination, and context lookups are bounded. `quotapie signals --refresh` reads
once and prints collection health and records; `quotapie signals` reads the
saved state. Restart `quotapie serve` after changing configuration.

Signals are kept for 30 days. Notifications use the existing durable delivery
queue and channel deduplication. Linked announcements with the same classified
conditions share an alert identity in direct-X mode; changed times and
withdrawals get new identities. Unlinked paraphrases can still produce separate
alerts. Initial imports of old signals (>24 hours), already-passed feed schedule
estimates, and superseded signals are not newly notified. Later edits and
withdrawals on an already observed source use their detection time; cached
copies cannot revive previously observed versions. Existing account-observation alerts
continue to report actual quota changes independently; a public post never
changes your quota timer, resumes a task, or spends a banked reset.

### Account recovery evidence in the menu bar

Each account has a **Recovery · last 24 hours** disclosure. It shows the latest
recorded recovery per current quota window: the interval between observations,
remaining allowance before/after, and both next-reset dates. Current observation
coverage is separate: failed/stale collection, a missing comparison, a source or
window change, and gaps over 30 minutes are unavailable, not proof of non-application.
Accounts with no snapshots remain visible. With no recorded recovery, the latest
comparison interval is shown; this is not continuous coverage of the whole day.
Past evidence remains visible during a service outage.

`GET /api/status` carries `resetTracking` for the native app. Evidence is saved in
the existing event transaction; older events without evidence are not backfilled
from posts. The 24-hour view is a bounded summary, not a complete history browser.
Public candidates are recomputed from up to 200 saved posts, not permanent causal
links. They can change when a report is corrected or leaves that bounded set.

Only explicit, universal, completed direct Codex reset reports are candidates.
Plan-specific or unknown-scope reports stay in the news section because account
plan eligibility is not collected. Explicit weekly/five-hour scope must match the
observed window. Future schedules, corrections, withdrawals, reset-credit decreases,
and uncertain observations cannot provide candidates. The six-hour proximity window
and 30-minute observation-gap limit are conservative display rules, not calibrated
confidence scores. A candidate never establishes that the public event caused the
recovery, modifies quota records, or requeues the recovery notification.
