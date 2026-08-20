# TimeQuota implementation brief for Claude

## Role boundary

- Claude owns all implementation, tests, build, deployment, commit, and push.
- Codex has only reviewed the current product and will review Claude's finished diff afterward.
- Do not treat a clean tree or passing unit tests as completion. Completion requires the installed backend and menu-bar app to be exercised with real local state.

## Product decision

TimeQuota should remain a small, local, account-aware quota decision tool. Its value is not generic token accounting. Its value is combining provider-reported subscription quota with personal pace, detecting unexpected relief/reset changes, and making multiple accounts safe to distinguish.

The primary user question is:

> Can I keep working at this pace until the provider resets this account?

The menu-bar app is the primary product. The web dashboard is secondary diagnostics. The CLI is setup, diagnosis, and automation infrastructure.

## Strengths to preserve

1. Provider-reported quota is kept separate from locally estimated token/cost data.
2. Codex and Claude share one normalized history without erasing provider/source provenance.
3. Scheduled reset, unexpected relief, reset-clock rebase, staleness, and pace risk are distinct concepts.
4. Account identity is a local alias; email or other PII is not exposed.
5. Multi-account Codex fails closed when credential isolation cannot be guaranteed.
6. SQLite history, alert claims, `quota.json`, and local-only HTTP provide useful durable boundaries.
7. Personal pace uses active hours and historical behavior rather than a naive wall-clock projection.

## Current weaknesses that block release

### P0 — collection truth and health

1. Claude OAuth collection is deployed but currently records no successful sample. `doctor` still exits successfully because it checks only the status-line command. `/health` checks only Codex windows. Both are false-green.
2. Collection health is stored per provider/account, while Claude has two sources. An OAuth failure can overwrite a recent status-line success. Store source-level health, then derive account health with explicit precedence.
3. OAuth and status-line observations can alternate for the same bucket and create `source_changed`, meter-correction, or schedule-rebase noise. Define source precedence:
   - fresh OAuth is authoritative;
   - status line is fallback only when OAuth is unavailable or stale;
   - switching to an equivalent observation must not generate a user event.
4. Keychain lookup supports only the default `Claude Code-credentials` service. Claude Code uses config-directory-specific Keychain service names for additional profiles. Support those names without copying tokens into TimeQuota storage.
5. Add bounded timeouts to both Keychain access and the OAuth request. A stuck Claude source must never delay Codex polling, alerts, retention, or `quota.json` publication.
6. Never tell the user merely to wait for the first response when authentication is absent. Surface an actionable state such as `Claude 로그인이 필요합니다`.

### P0 — product-facing state contract

The API must return configured enabled accounts even when no quota snapshot exists. Each account needs:

- provider, alias, label, enabled state;
- collection state: never attempted, healthy, stale, failed;
- active source and last successful sample time;
- actionable error category, with secrets and raw credentials excluded;
- zero or more quota windows.

This prevents a missing Claude account from disappearing entirely and lets the native UI render an honest empty/error state.

### P1 — menu-bar UX

Replace the current text-only `NSMenu` hierarchy with an `NSPopover` hosted by SwiftUI. Keep the app as a lightweight menu-bar accessory; do not create a dock app or make the dashboard the default surface.

#### Menu-bar title

Show one decision, not provider abbreviations:

- normal: `56% 남음`
- pace risk: `⚠ 주간 위험`
- collection stale/failed: `한도 확인 지연`
- no observations: `설정 필요`

The selected title comes from the highest-risk enabled account/window, not simply the lowest percentage. A healthy 10% remaining with ten minutes to reset can be safer than 60% remaining projected to exhaust three days early.

#### Popover hierarchy

The first visible block must answer four questions without disclosure:

1. Which provider and account?
2. How much is used and remaining?
3. When does it reset?
4. At the current pace, will it last?

Recommended structure:

```text
⚠ 주간 한도가 갱신 전에 소진될 수 있습니다

Codex · Main                         공식 · 방금
5시간   44% 사용  [████░░░░░░]  56% 남음
         01:17 갱신 · 현재 속도는 여유 있음
주간     31% 사용  [███│░░░░░░]  69% 남음
         8월 27일 16:55 갱신
         ⚠ 8월 25일경 소진 예상

Claude · Main
로그인이 필요합니다
[설정 확인]
```

- Progress fill represents **used** percentage consistently.
- Text always states both used and remaining; never show an unlabeled number.
- Overlay an elapsed-time/safe-pace marker only when it is mathematically meaningful.
- Express pace in plain Korean. Keep raw ratios such as `1.6×` in a secondary detail row.
- Show exact absolute reset date/time for weekly windows and a countdown for short windows.
- Put source quality and freshness beside the account header: `공식 · 방금`, `대체 수집 · 8분 전`, or `수집 실패`.
- Group by account. Never merge multiple accounts into a provider-wide minimum without naming the responsible account.
- Hide inactive/irrelevant model-scoped windows and low-value events behind disclosure.

#### Events

Only user-meaningful events appear in the main popover:

- confirmed scheduled reset;
- confirmed unexpected relief/recharge;
- authentication or collection failure;
- meaningful reset-clock shift;
- threshold or pace-risk transition.

Do not show small reset-clock jitter, source changes with equivalent values, first-observation bookkeeping, or bucket-retirement internals in the primary UI. Keep them available in diagnostics.

#### First-run and recovery UX

- A configured account with no data must remain visible.
- Distinguish `로그인 필요`, `첫 응답 대기`, `수집 실패`, and `오래된 값`.
- `설정 확인` opens a small native diagnostic view or the relevant local configuration; it must not send users to the web dashboard as the only explanation.
- Include a short `표시 읽는 법` disclosure explaining used fill, pace marker, and reset time.

### P1 — diagnostics and reliability

1. `timequota doctor` must test every enabled account and every configured source. Exit nonzero when the only authoritative/usable collection path is broken.
2. `/health` must derive its result from all enabled accounts, not only existing Codex windows.
3. Avoid raw OAuth error strings in the menu. Map them to stable error categories while retaining sanitized detail for CLI diagnostics.
4. A provider failure must not block the watch loop. Poll independent providers/accounts concurrently with bounded work and publish health even after partial failure.
5. Preserve historical data for disabled/deleted accounts but hide it from active status, triggers, and the popover.

## Non-goals

- Do not add API-key cost tracking to the primary quota bars.
- Do not scrape conversation bodies.
- Do not expose account emails.
- Do not auto-switch accounts or automate login.
- Do not add cloud sync, a hosted dashboard, or telemetry.
- Do not display every stored event or metric merely because it exists.
- Do not delete the existing web dashboard; demote it to diagnostics.

## Required test coverage

### Backend

- default and non-default Claude Keychain service resolution;
- OAuth timeout and Keychain timeout do not block a tick;
- OAuth failure plus status-line success derives healthy fallback state;
- fresh OAuth wins over status-line fallback without duplicate events;
- configured account with no snapshot appears in the API;
- `doctor` and `/health` fail for a broken enabled Claude account;
- one broken provider does not prevent another provider from publishing fresh status;
- disabled account data remains stored but invisible to active consumers.

### Native app

- normal, pace-risk, stale, failed, and no-data title states;
- multiple accounts remain visibly separated;
- weekly risk outranks a lower remaining percentage that is safe until reset;
- Korean used/remaining/reset copy is unambiguous;
- error and empty-state cards render without requiring a status window.

## Completion gate

Claude should not mark this complete until all of the following are true:

1. `bun run check` passes.
2. Swift release build and type checks pass.
3. The installed source copy and app bundle are updated.
4. Backend and menu-bar LaunchAgents are restarted and remain running.
5. `/api/status`, `/health`, `timequota doctor`, and `quota.json` agree about each enabled account's health.
6. The menu-bar popover is visually inspected in all five states using deterministic fixtures or preview data.
7. Real Codex collection remains fresh after a failing Claude poll.
8. No credential value, email, or conversation content appears in logs, API payloads, UI, tests, or commits.
9. Changes are committed and pushed as `heznpc` without co-author metadata.

## Review handback

When implementation is finished, provide Codex with:

- commit hash and pushed branch;
- concise diff summary;
- commands and results for backend, Swift, and runtime verification;
- screenshots of the five native UI states;
- sanitized examples of `/api/status`, `/health`, `doctor`, and `quota.json` showing agreement;
- known limitations that remain.
