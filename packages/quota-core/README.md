# @heznpc/quota-core

Version **0.1.0**, ESM, Node 22+ and Bun. This private package is the single
source for QuotaPie and Taxi policy and normalization. It requires neither app
to be installed and performs no I/O at import time. It has no runtime dependencies.

## Contract

Import the root `@heznpc/quota-core` entry point. Public exports include:

- `routeCompaction(path, body, policy)`, `validateCompactionRoute`,
  `DEFAULT_COMPACTION_ROUTE`, `CompactionRoute`: route only native compression,
  retaining the original request and work model settings.
- `TaskSavingsRouter`, `validateTaskSavings`, `DEFAULT_TASK_SAVINGS`,
  `TaskSavingsPolicy`, `SavingsDecision`, `SavingsReason`: create one router per
  host relay; inject `() => boolean` for verified target model support. Only a
  bounded text edit can route. Manual changes, uncertain tasks, failures and
  extended work retain/restore the original choice. Call `failed(threadId)` on
  request failure. No policy creates sessions or manager tasks.
- `ResponseCompletionObserver(contentType, compaction)`: feed unchanged response
  byte chunks with `push`; use `terminal`/`finish` for protocol completion.
  `responseModel` and `usage` are observed evidence, not inferred from routing.
- `CompactionRequestEvent`, `QUOTA_CORE_EVENT_SCHEMA_VERSION = 1`,
  `parseCompactionRequestEvent(unknown)`,
  `summarizeRequestEvents(events, activeIds, nowMs)`: explicit metadata projection
  and in-memory correlation. Events contain request/thread/turn IDs, route,
  phases, status, time, sanitized effort/errors, optional reported model and token
  counts. No prompt, credential, URL, or arbitrary provider fields are copied.
  `activeIds` must come from fresh live health. Feed one latest event per request.
  Summaries expose compaction `records`, `savingsRecords`, `retained` metadata and
  `notificationEvidence`; only non-overlapping same-thread/same-turn requests
  before the next compaction establish follow-up. Missing live state is unverified.
- `QuotaObservation`, `Provider`, `SourceQuality`,
  `parseCodexRateLimits(payload, observedAtMs?, account?)`,
  `parseClaudeStatusLine(payload, observedAtMs?, account?)`,
  `mapClaudeUsage(payload, account?, observedAtMs?)`: use explicit local account
  aliases and timestamps. Missing usage remains null, not zero; the source
  schema/semantics and account isolation are preserved. Status-line session IDs
  are hashed. Provider payloads are never retained. Do not use emails as aliases.
- `transportFailure(error)`: allowlisted transport error classification only.

HTTP success, protocol completion, reported model, and output quality are four
separate facts. The core does not grade quality or prove that a provider ran a
model when its response omits model evidence. Schema version describes event
semantics; the host may use its own versioned envelope/persistence format.

## Host boundary

The host owns network/stream transport, authentication, consent to collect,
credential access, profile discovery, capability probes, provider processes,
account/session lifecycle, storage, settings locks, OS paths, UI and installation.
QuotaPie keeps its Bun server and Swift app. Taxi supplies its Node adapters.
Do not read QuotaPie's private files or depend on its localhost service from Taxi.
Validate incoming policy at configuration boundaries, snapshot it per request,
forward bytes unchanged, and pass only projected metadata to logs/UI.

QuotaPie imports `packages/quota-core/src/*.js` (Bun resolves the corresponding
TypeScript files) through existing compatibility entry points; there is no
second policy implementation or generated runtime required for its installer.
External consumers install the compiled package tarball and import the root.

## Reproducible package

From the repository root with locked development dependencies installed:

```sh
bun run pack:quota-core
bun run check:quota-core
bun run check:quota-core:host
```

The pack command emits `dist/quota-core/heznpc-quota-core-0.1.0.tgz` and a SHA-256
file. It uses fixed archive ownership/timestamps and packages only compiled JS,
type declarations, this contract, license and the manifest. No source maps,
private files or host paths are shipped. `private: true` blocks npm publication.

Taxi can copy the tarball to its own `vendor/` directory (not unpack/edit its
implementation), verify the checksum and pin it in its dependency and lockfile:

```sh
npm install --save-exact ./vendor/heznpc-quota-core-0.1.0.tgz
```

Use `"@heznpc/quota-core": "file:vendor/heznpc-quota-core-0.1.0.tgz"`. Commit the
artifact and lockfile together in the consuming repository under its existing
publication rules. Package updates are built from this source with a new version.
No registry publication or developer-machine absolute path is required.
