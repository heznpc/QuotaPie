import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory, loadConfig } from "../config";
import { DotStore } from "./store";
import { DotBridge } from "./bridge";
import { parsePolicy, readGate } from "./policy";
import { DotsConnection } from "./connection";

export async function runDotsCommand(args: string[]): Promise<number> {
  const [command = "help", value] = args;
  if (command === "help") {
    console.log(`quotapie dots configure POLICY.json  Register a disabled target after verifying its local profile.
quotapie dots connection            Inspect the managed connection without starting it.
quotapie dots bind CONNECTION.json  Save a reviewed private connection (no credentials, references only).
quotapie dots connect               Start or reuse QuotaPie's managed connection.
quotapie dots disconnect            Pause policies and stop QuotaPie's connection.
quotapie dots review TARGET         Show the exact policy and pending result, without connecting to Dots.
quotapie dots enable TARGET         Enable the reviewed target.
quotapie dots disable TARGET        Stop new events and claims; an already-running turn remains host-owned.
quotapie dots status TARGET         Read current collector admission and limits.
quotapie dots mcp                   Private stdio MCP 2.0 server for an authenticated personal tunnel.

Configuration and subscriptions live in QUOTAPIE_HOME/dots.sqlite with mode 0600.
This command never sends a prompt or starts a provider CLI. Dots owns the native follow-up.`);
    return 0;
  }
  if (["connection", "bind", "connect", "disconnect"].includes(command)) {
    const connection = new DotsConnection();
    if (command === "bind") {
      if (!value || statSync(value).size > 8192) throw new Error("invalid-connection-file");
      connection.save(JSON.parse(readFileSync(value, "utf8")));
    }
    const result = command === "connect" ? await connection.connect() : command === "disconnect" ?
      await connection.disconnect() : await connection.status();
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const store = new DotStore(join(dataDirectory(), "dots.sqlite"));
  const bridge = new DotBridge(store, policy => readGate(loadConfig(), policy));
  try {
    if (command === "configure" && value) {
      if (statSync(value).size > 8192) throw new Error("policy-too-large");
      const policy = parsePolicy(JSON.parse(readFileSync(value, "utf8")), loadConfig());
      const gate = await readGate(loadConfig(), policy);
      if (gate.profileKey !== policy.profileKey || typeof gate.accountKey !== "string" ||
          !/^[a-f0-9]{64}$/.test(gate.accountKey)) throw new Error("account-identity-unavailable");
      policy.accountKey = gate.accountKey;
      store.create(policy);
      console.log(JSON.stringify({ configured: policy.id, enabled: false, next: "Review the policy before enabling." }));
    } else if (command === "review" && value) {
      const state = store.target(value);
      const { profileKey: _, accountKey: __, ...policy } = state.policy;
      console.log(JSON.stringify({ policy, turnsUsed: state.turns, observedUsagePercent: state.spent,
        pendingClaim: state.claimed != null, outcome: state.outcome,
        subscriptions: store.subscriptions().filter(s => s.targetId === value).map(s => ({
          id: s.id, event: s.name, expiresAtMs: s.expiresAtMs,
        })), limits: "Admission checks only. One running turn may exceed its measured usage budget. Dots must inspect the original task before sending one follow-up." }, null, 2));
    } else if ((command === "enable" || command === "disable") && value) {
      const state = store.setEnabled(value, command === "enable");
      console.log(JSON.stringify({ targetId: value, enabled: state.policy.enabled, pendingClaim: state.claimed != null }));
    } else if (command === "status" && value) {
      console.log(JSON.stringify(await bridge.status(value), null, 2));
    } else if (command === "mcp") {
      // Inherit the authenticated tunnel's single-user trust boundary. No HTTP
      // listener, tunnel registration, external account setup or GUI mutation.
      let chain: Promise<unknown> = Promise.resolve(), ticking = false;
      const timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        chain = chain.then(() => bridge.tick()).catch(() => {
          process.stderr.write("QuotaPie: event check unavailable; no continuation granted.\n");
        }).finally(() => { ticking = false; });
      }, 30000);
      let pending = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of Bun.stdin.stream()) {
          pending += decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(pending) > 65536) throw new Error("request-too-large");
          let index;
          while ((index = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            if (!line.trim()) continue;
            chain = chain.then(async () => {
              let response;
              try { response = await bridge.rpc(JSON.parse(line)); }
              catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
              if (response) process.stdout.write(JSON.stringify(response) + "\n");
            });
            await chain;
          }
        }
      } finally { clearInterval(timer); await chain; }
    } else throw new Error("usage: quotapie dots help");
    return 0;
  } finally { store.close(); }
}
