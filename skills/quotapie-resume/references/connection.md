# QuotaPie events for Dots

This connection uses MCP Events to tell a Dot when an explicitly approved local
Codex task can continue. Events and claims never start a model. A separately
reviewed `profile-managed` policy permits `execute_continuation` to run one
read-only report in the original thread and profile through the bundled Codex
CLI. Native-host continuation remains blocked until host verification exists.

## Connection

Start with `quotapie dots connection` or **Dots connection** in the macOS
settings. The app discovers the official tunnel client from PATH, Homebrew or
the official runtime manager's saved executable path. Do not ask the user to
find a binary, Dot name or tunnel ID before inspecting the available authorized
connections yourself. Inspect the account's actual Dot availability first;
local Codex sign-in alone does not establish it.

After the user has authorized the private account connection, the operator
records the resulting tunnel and credential reference with `quotapie dots bind
CONNECTION.json`. That file contains `account` (the local account hosting the
connection), `workspaceId`, `tunnelId`, and `runtimeKeyRef` (`file:/absolute/path`
to a private mode-0600 key file, or `env:VARIABLE`). Never put literal keys in
this file. Binding verifies the local account and starts nothing. The Dot's
connection account does not change any target policy's execution account.

`quotapie dots connect` manages only the `quotapie-dots` runtime through the
official manager. It verifies remote workspace membership with the runtime key
before startup, preserves another application's aliases, and checks readiness
after startup. Repeated connect does not launch a second process. The macOS
settings expose connect, status and disconnect. Disconnect first pauses task
policies, then stops only QuotaPie's runtime. This revokes managed execution;
it does not cancel a task running independently in its native host.

The initial Platform and ChatGPT approvals are separate from runtime management.
The app links to their official screens and does not claim to have finished them
without the resulting connection and observed subscription. It does not create
a Dot, buy a plan, or claim that a local test proves the cloud connection.

Run `quotapie dots mcp` as a private stdio server behind an authenticated
personal Secure MCP Tunnel. It implements MCP 2.0 discovery, event
list/subscribe/unsubscribe, callback verification and signed webhook delivery.
Legacy initialization exposes tools only, with no claim of MCP Events support.
Use one tunnel principal for this personal store; do not share its tunnel with
another account. The server trusts the tunnel's authenticated transport and
must not be exposed as an unauthenticated public service.

The machine needs a tunnel ID associated with the intended ChatGPT workspace,
the official `tunnel-client`, and a runtime key kept in the local secret
configuration. No inference API key is used by QuotaPie. Follow the official
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
to create the connection; do not put keys in Git, prompts, or shell arguments.
Private tunnel registration and Dot access must be reviewed before activation.

In ChatGPT Plugins, add the custom MCP server using the tunnel, then verify
that `quota.ready` and `quota.reset_approaching` appear in the event catalog.
Use `continuation_status` to verify the exact original Codex task in its
configured profile. A Dot's default computer host may belong to another account.
The profile reader is distinct from native-host access and from a local CLI
plugin installation.
The current environment's connection and real Dot execution must be verified;
the implementation alone does not establish either.

## User policy

Create a JSON file from this shape using an actual configured account, exact
original thread ID, and an expiry timestamp within seven days:

```json
{
  "id": "approved-work",
  "threadId": "11111111-2222-3333-4444-555555555555",
  "account": "configured-account",
  "executionMode": "profile-managed",
  "continuation": "The exact continuation the user reviewed.",
  "trigger": "quota.ready",
  "resetWithinMinutes": 30,
  "reservePercent": 20,
  "maxTurns": 1,
  "maxUsagePercent": 5,
  "expiresAtMs": 0,
  "priority": 0
}
```

The example's expiry is intentionally invalid: choose it at registration time.
`quotapie dots configure POLICY.json` verifies the thread metadata in that
account's profile, pins its opaque login identity from the running collector,
and always registers the policy disabled. Token refresh preserves the binding;
a different login in the same directory blocks the policy. Review it with
`quotapie dots review approved-work`; after approval use
`quotapie dots enable approved-work`. Disable with
`quotapie dots disable approved-work`. MCP tools cannot enrol or enable targets.

For reset preparation, use `"trigger": "quota.reset_approaching"` and specify
`resetBucket` from an observed general Codex quota window. An optional
`requiredBucket` adds the exact model-specific quota window. All general
windows and the requested model window must have fresh quota above their own
reserves and the policy reserve. The configured reserve is never lowered.
`resetWithinMinutes` controls how close to that selected reset work may begin.
The continuation identifies the useful work; higher numeric priority wins
among eligible targets on the same account.

`maxTurns` limits successful claims. `maxUsagePercent` bounds further
admission based on measured percentage-point consumption since monitoring
began. It also counts manual consumption and does not measure exact token
cost. For managed execution, the proxy raises each window's reserve to at least
its starting remaining percentage minus the budget. It requires the same windows
and reset periods throughout execution and cancels the connection when the
observed threshold is reached. Accounting delay can still exceed this amount;
the provider may have processed work before cancellation. Managed mode requires
`maxTurns: 1`, a read-only report and a 60-second limit. It forbids API-key and
alternate-account routing, and pins request/stream retries to zero. An unresolved
claim blocks other automatic work on the account. Disable, unsubscribe, policy
expiry or transport shutdown revokes managed execution; native work remains
host-owned.

## Delivery and continuation

The MCP client subscribes with the policy event and `{ "targetId": "approved-work" }`.
Callback HTTPS destinations are verified before storing a subscription.
Private/special addresses and redirects are rejected; DNS answers are checked
on each connection and the connection is pinned to the checked address.
Signing secrets and subscriptions are stored in a mode-0600 local SQLite file.
Events contain only target/thread IDs and timing, never transcript text,
provider credentials, account labels or local paths.

Each continuous ready state has one stable event ID. Successful receipt is
stored separately from claims/results. Transient transport failures retry at
most three times using that ID and fresh signatures. HTTP 410 removes the
subscription; 413 and other permanent errors stop delivery. There is no replay
cursor. Policies without active subscriptions generate no events.

On receipt the Dot follows the [continuation skill](../SKILL.md):
inspect the original profile, check quota, claim once, and call
`execute_continuation` once for managed mode. The bridge saves a durable dispatch
marker before starting its child, validates the returned thread ID and result,
and disables the target after the attempt. External `finish_continuation` is
rejected for managed mode. Duplicate dispatch and uncertain retries are blocked.
Native-mode quota failures may re-arm within original limits; managed mode is
always one attempt.

## Verification boundaries

Isolated tests inject a fake callback and quota reader; no real Dot, provider,
webhook, credit purchase or existing conversation is touched. A fresh temporary
SQLite store proves persistence and claim contention.

Before real operation, review a concrete test specifying the Dot, original
thread/account, exact continuation, maximum one follow-up, expiry, stop
conditions and which local configuration changes are allowed. Verify in order:

1. Installed settings and resume-check API.
2. Real MCP discovery, subscription and signed callback verification.
3. A measured quota-ready event received by the intended Dot.
4. Exactly one follow-up and a normal response in the original thread.
5. Policy disabled and subscription stopped after the approved test.

Never call steps 3–4 verified from a mocked callback, a HTTP 2xx receipt,
or a gate returning ready. Do not force quota state, swap accounts, spend paid
credits, purchase allowance, or reset quotas to create a test opportunity.

References: [MCP Events](https://developers.openai.com/plugins/build/mcp-events),
[Dots computer access](https://learn.chatgpt.com/docs/dots/computers-and-apps#connect-your-computer).
