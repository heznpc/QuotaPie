---
name: quotapie-resume
description: Connect an explicitly approved existing Codex task to Dots through QuotaPie quota events, or stop that connection. Use for quota recovery or using remaining allowance near reset.
---

# QuotaPie continuation through Dots

The Dot owns the native follow-up. QuotaPie supplies measured quota, event
subscriptions and a single-use admission claim. Enrol only tasks the user has
explicitly selected for automatic continuation.

Read the repository's [connection guide](references/connection.md) when
preparing the private MCP connection. Register a disabled policy with
`quotapie dots configure POLICY.json`, then show `quotapie dots review TARGET`
to the user. Preserve their requirements for review before live testing.
Policies fix the exact original thread, account/profile, continuation text,
reserve, priority, expiry, turn count and observed usage budget. The current
bridge supports existing local Codex tasks only.

Connect the private MCP server to the intended ChatGPT account and Dot.
Verify that this Dot has access to the computer and can inspect the original
thread. Local Codex plugin configuration alone does not prove a Dot connection.
Ask the Dot to subscribe to the policy's event and target ID, with the user's
approved objective and the following workflow:

1. Read `continuation_status`; wait if blocked. Inspect the exact original
   thread through the host. Stop if it is active, finished, inaccessible or
   belongs to another account.
2. Immediately before a follow-up, call `claim_continuation` with the event's
   target and event ID. Proceed only on `granted: true`, before `startBeforeMs`.
3. Send exactly one native follow-up to the returned thread ID using the
   approved continuation text. Retain the thread's model, account and tools.
   Do not create a chat, use `codex exec resume`, or route through another account.
4. Observe the original task result. Record `completed` only when the approved
   objective is finished, `quota-blocked` only for a witnessed quota failure,
   or `failed` for another terminal failure. An uncertain send/result remains
   claimed and requires review; never send it again just because a timer expired.

An event receipt is not a task start or completion. A repeated claim grants
nothing. If permission expires while work runs, no new claim is granted; stopping
already-running work requires the host's native control and user authority.
Quota checks cannot enforce an exact consumption ceiling within a running turn.

For disabling, run `quotapie dots disable TARGET` and stop the matching Dot
subscription. Do not create or unpause a heartbeat as a substitute for Dots.
Report unchanged waiting states quietly; notify only meaningful results or
required user action. Verify a real Dot receipt and original-task response
before describing the complete loop as working.
