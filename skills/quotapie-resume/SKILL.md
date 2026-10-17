---
name: quotapie-resume
description: Connect an explicitly approved existing Codex task to Dots through QuotaPie quota events, or stop that connection. Use for quota recovery or using remaining allowance near reset.
---

# QuotaPie continuation through Dots

QuotaPie supplies measured quota, event subscriptions and a single-use admission
claim. A reviewed policy chooses native-host or profile-managed execution.
Enrol only tasks the user has explicitly selected for automatic continuation.

Read the repository's [connection guide](references/connection.md) when
preparing the private MCP connection. Register a disabled policy with
`quotapie dots configure POLICY.json`, then show `quotapie dots review TARGET`
to the user. Preserve their requirements for review before live testing.
Policies fix the exact original thread, account/profile, continuation text,
reserve, priority, expiry, turn count and observed usage budget. The current
bridge supports existing local Codex tasks only.

Connect the private MCP server to the intended ChatGPT account and Dot.
Verify that `continuation_status` finds the exact original thread and matches
its account/profile. A default computer host may belong to a different account;
do not interpret its `thread not found` as missing local history. Local Codex
plugin configuration alone does not prove a Dot connection.
Ask the Dot to subscribe to the policy's event and target ID, with the user's
approved objective and the following workflow:

1. Read `continuation_status`; wait if blocked. The profile reader's `notLoaded`
   does not establish task idleness. Managed preflight checks the last completed
   turn and absence of a writer lock, then the official CLI must acquire its
   own lock at dispatch. Stop if active, inaccessible or account-mismatched.
2. Immediately before a follow-up, call `claim_continuation` with the event's
   target and event ID. Proceed only on `granted: true`, before `startBeforeMs`.
3. For `executionMode: profile-managed`, call `execute_continuation` once with
   the claim. QuotaPie runs the reviewed prompt in the original thread/profile
   through the bundled CLI and a protected in-memory proxy. Do not also send a
   native follow-up or run a CLI command yourself. The bridge records the result
   and disables the one-turn policy; `finish_continuation` is not accepted here.
4. Native mode requires verified original-host access and remains blocked until
   that verification is implemented. When available, send one native follow-up
   and record only its witnessed result. Never create another chat, substitute
   an account, or retry an uncertain dispatch.

An event receipt is not a task start or completion. A repeated claim grants
nothing. Managed execution is limited to a read-only report, one child, 60 seconds
and no request/stream retries. Disabling, unsubscribing, expiry or connection
shutdown revokes its lease. The proxy checks permission and quota every 500ms,
including reserves raised by the observed usage budget. It cancels the upstream
connection and terminates only its own child. Unknown/stale quota or a changed
reset period also stops it. Provider accounting delay and already-processed work
mean this is not an exact consumption or billing ceiling. Native tasks remain
host-owned and cannot be cancelled by this managed runner.

For disabling, run `quotapie dots disable TARGET` and stop the matching Dot
subscription. Do not create or unpause a heartbeat as a substitute for Dots.
Report unchanged waiting states quietly; notify only meaningful results or
required user action. Verify a real Dot receipt and original-task response
before describing the complete loop as working.
