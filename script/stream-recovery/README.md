# Offline stream recovery boundary

Review component and executable installed-client probe. This directory deliberately
has no production wiring. It can be reviewed/cherry-picked separately from changes
to the SSE parser or relay integration.

Run from the repository root with Bun and an already-installed Codex binary:

```sh
bun test ./script/stream-recovery/fence.test.ts
PROBE_CODEX_BINARY=/absolute/path/to/codex bun script/stream-recovery/probe.ts
```

The probe supplies a synthetic upstream to the existing `startCompactionProxy`,
then runs the installed Codex client against loopback HTTP. It does not load user
configuration, uses a new temporary CODEX_HOME, and supplies no inference key.
No production model endpoint is fetched by the relay. It runs four scenarios,
each limited to 30 seconds and eight incoming requests. Fixture marker files
are retained in a temporary directory for inspection. Generated results include
only synthetic metadata, counts and error messages; do not commit incident logs.

## What changes

`TurnRecoveryFence` reserves a thread/turn before forwarding a sampling request.
A verified completed response releases that reservation, allowing the normal
next request containing tool results. Failure, cancellation and unverified
completion leave a tombstone. Another request for that turn returns HTTP 400
without forwarding upstream. The installed-client probe checks that this
non-retryable rejection stops reconnection after one local rejection. It never
manufactures `response.completed` or changes streamed provider content.

The baseline deliberately returns the same append command with *different call
IDs* on two incomplete responses. This demonstrates that regenerated calls can
repeat a side effect, not that identical call IDs bypass client deduplication.
The fenced scenario allows the first action and blocks further inference. It
cannot undo or prevent the first action, which Codex can execute before response
completion. SSE identity validation must happen before forwarding tool items.

A byte-free HTTP 200 is still ambiguous: the provider may have run inference or
hosted tools. The fence does not blindly replay it. Existing transport recovery
only retries allowlisted connection-establishment failures (three total tries).
Tests verify this finite recovery, exhaustion, cancellation, and non-replay of
reset/timeout/empty responses. HTTP headers alone never prove model completion.

## Integration contract and limits

- Call `begin` once, before account selection and upstream dispatch, using the
  relay's validated request identity (including its metadata-header fallback).
- Keep the returned lease by request ID. Call `finish` once at the terminal
  outcome of the *whole logical sampling request*, after any existing safe
  account failover, not at an intermediate 429. Leases prevent late callbacks
  from releasing another request's reservation.
- Missing identity fails closed. This may exclude older clients; do not invent
  an identity shared by multiple requests. Health/compaction endpoints are not
  sampling requests and must not be routed through this fence accidentally.
- A cancellation means downstream disconnected, not necessarily user intent.
  User intent requires client-side evidence. A partial response is not proof a
  tool ran. Reconcile the client's tool journal and actual effects before a new
  turn; supply existing results and explicitly exclude already completed actions.
- This prototype requires reconciliation, rather than promising automatic
  exactly-once recovery. Unknown tool outcomes must not be auto-replayed.
- Tombstones have no TTL or eviction. Capacity exhaustion rejects new work;
  availability is deliberately sacrificed rather than reopening an unsafe turn.
- State is process-local. Restart, multiple relay processes, and a new turn bypass
  this fence. Durable shared storage and an explicit reconciliation workflow are
  required before claiming protection across those boundaries.
- Existing streams continue passing bytes. Do not roll this into the shared relay
  or restart applications without reviewing the behavior and availability impact.

The official Responses streaming guide distinguishes `response.completed` from
intermediate events:
https://developers.openai.com/api/docs/guides/streaming-responses
