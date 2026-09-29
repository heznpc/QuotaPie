# @heznpc/quota-core

Version **0.2.0**, ESM, Node 22+ and Bun. This private package is the single
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
- `selectTaskModel(input)`: explicit phase selection, with the exact contract below.

HTTP success, protocol completion, reported model, and output quality are four
separate facts. The core does not grade quality or prove that a provider ran a
model when its response omits model evidence. Schema version describes event
semantics; the host may use its own versioned envelope/persistence format.

## Explicit task model selection (added in 0.2.0)

All 0.1.0 exports and behavior remain available. This additive API does not use
`TaskSavingsRouter`, compression policy, prompt classification, quota heuristics,
model rankings, or session creation. A phase is an exact host-provided label such
as `ideation`, `research`, `implementation`, or `verification`; it is never inferred.

```ts
export interface TaskModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly effort?: string;
}

export interface TaskModelCapability {
  readonly provider: string;
  readonly model: string;
  readonly efforts: readonly string[];
}

export interface SelectTaskModelInput {
  readonly phase: string;
  readonly manualSelection?: TaskModelChoice | null;
  readonly phasePreferences?: Readonly<Record<string, TaskModelChoice | null | undefined>>;
  readonly defaultSelection?: TaskModelChoice | null;
  readonly capabilities: readonly TaskModelCapability[];
}

export type TaskModelSelectionSource = "manual" | "phase" | "default";
export type TaskModelSelectionReason =
  | "manual_selection" | "phase_preference" | "default_selection";
export type TaskModelUnavailableReason =
  | "invalid_phase" | "invalid_selection" | "no_selection"
  | "unsupported_provider" | "unsupported_model" | "unsupported_effort";

export type TaskModelSelectionResult =
  | {
      readonly status: "selected";
      readonly phase: string;
      readonly source: TaskModelSelectionSource;
      readonly selection: TaskModelChoice;
      readonly reason: TaskModelSelectionReason;
    }
  | {
      readonly status: "unavailable";
      readonly phase: string;
      readonly source: TaskModelSelectionSource | null;
      readonly selection: null;
      readonly requested: TaskModelChoice | null;
      readonly reason: TaskModelUnavailableReason;
    };

export function selectTaskModel(input: SelectTaskModelInput): TaskModelSelectionResult;
```

Selection rules, in order:

1. A blank phase returns `invalid_phase` with null source/requested. Otherwise
   use a non-null manual selection, then an own non-null preference for that
   exact phase, then a non-null default. Missing/null entries mean unset.
2. No configured choice returns `no_selection`. Empty or whitespace-only
   provider/model/explicit effort returns `invalid_selection`. Labels are
   case-sensitive and are not trimmed or rewritten for matching.
3. Validate only that chosen candidate against the supplied capabilities.
   Missing provider, model, or explicit effort returns the corresponding
   `unsupported_*` reason with source and requested choice. **No unavailable
   candidate falls through to a lower-priority choice**, including manual ones.
4. Capabilities are scoped to the exact provider/model pair. Repeated rows union
   their supported efforts. An empty capability list establishes no support.
   Omitted effort stays omitted and delegates to the provider default; it does
   not choose an effort or assert which default the provider will use. An empty
   efforts array permits only an omitted effort. Explicit `"none"` is a literal
   effort and requires support just like any other value.
5. Return a new projected choice (provider/model/optional effort only), without
   mutating or retaining input objects. Reasons are stable machine-readable
   codes for host localization, not model quality assessments.

This is a typed API, not an `unknown` JSON parser. Hosts validate settings and
capability payload shapes and supply a current support list for the intended
account/profile. The core cannot discover freshness or account entitlement.
Selection success expresses a supported request according to that input, not
proof of execution, response model, task quality, or permission to run/resume.

```ts
const result = selectTaskModel({
  phase: "verification",
  phasePreferences: {
    verification: { provider: "example", model: "review-model", effort: "high" },
  },
  defaultSelection: { provider: "example", model: "work-model" },
  capabilities: [
    { provider: "example", model: "review-model", efforts: ["low", "high"] },
    { provider: "example", model: "work-model", efforts: [] },
  ],
});
// selected / phase / phase_preference; review-model, high
```

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

Execution ownership stays with the host that registered and authorized work.
QuotaPie's existing quota recovery, explicitly registered pause/resume records,
and authorized local batch jobs remain QuotaPie host features. Its daemon returns
a resume launch plan after approval; the local menu bar app launches it. Model
selection, quota recovery, or observing a session does not transfer Taxi's
execution ownership to QuotaPie. Taxi records, interrupts and resumes its own
executions; it must not duplicate them as QuotaPie jobs or resume registrations.
No execution/resume adapters or job stores are exported by this package.

## Reproducible package

From the repository root with locked development dependencies installed:

```sh
bun run pack:quota-core
bun run check:quota-core
bun run check:quota-core:host
```

The pack command emits `dist/quota-core/heznpc-quota-core-0.2.0.tgz` and a SHA-256
file. It uses fixed archive ownership/timestamps and packages only compiled JS,
type declarations, this contract, license and the manifest. No source maps,
private files or host paths are shipped. `private: true` blocks npm publication.

Taxi can copy the tarball to its own `vendor/` directory (not unpack/edit its
implementation), verify the checksum and pin it in its dependency and lockfile:

```sh
npm install --save-exact ./vendor/heznpc-quota-core-0.2.0.tgz
```

Use `"@heznpc/quota-core": "file:vendor/heznpc-quota-core-0.2.0.tgz"`. Commit the
artifact and lockfile together in the consuming repository under its existing
publication rules. Package updates are built from this source with a new version.
No registry publication or developer-machine absolute path is required.
