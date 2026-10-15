#!/usr/bin/env python3
"""Paid live smoke test: a synthetic tool result triggers native mid-turn compaction.

Uses an existing Codex file login in a private temporary profile. Never sends a
manual compaction or model-switch RPC. Does not read project files. The profile
and evidence remain in a private temporary directory for inspection.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


class Probe:
    def __init__(self, args):
        self.args = args
        self.run = Path(tempfile.mkdtemp(prefix="quotapie-compaction-"))
        self.profile = self.run / "profile"
        self.workspace = self.run / "workspace"
        self.profile.mkdir(mode=0o700)
        self.workspace.mkdir(mode=0o700)
        auth = Path(args.codex_home).expanduser().resolve() / "auth.json"
        if not auth.is_file():
            raise RuntimeError("This probe requires an existing Codex file login (auth.json)")
        shutil.copyfile(auth, self.profile / "auth.json")
        (self.profile / "auth.json").chmod(0o600)
        (self.profile / "config.toml").write_text(
            'cli_auth_credentials_store = "file"\n'
            f'model = "{args.normal_model}"\n'
            f'model_reasoning_effort = "{args.effort}"\n'
            'approval_policy = "never"\n'
            'sandbox_mode = "read-only"\n'
            'model_auto_compact_token_limit = 12000\n'
            '[features]\nremote_plugin = false\napps = false\n'
        )
        self.relay_settings = json.loads(Path(args.relay_settings).read_text()) if args.relay_settings else None
        if self.relay_settings and "settings_path" in self.relay_settings:
            self.relay_settings = json.loads(Path(self.relay_settings["settings_path"]).read_text())
        if self.relay_settings:
            settings = self.relay_settings
            if {k: settings["route"][k] for k in ["from", "to"]} != {"from": args.normal_model, "to": args.compact_model}:
                raise ValueError("Installed relay route does not match the requested probe models")
            self.relay_url = f"http://127.0.0.1:{settings['port']}/{settings['token']}/backend-api/codex"
            config_path = self.profile / "config.toml"
            config_path.write_text("openai_base_url = " + json.dumps(self.relay_url) + "\n" + config_path.read_text())
        self.facts = {
            "project_code": args.record_id or secrets.token_hex(8),
            "release_color": "copper",
            "max_batch": 37,
        }
        if args.fixture == "constraints":
            self.facts.update({
                "branch": "fix/queue-order", "entrypoint": "src/queue.ts",
                "completed": ["schema migration", "duplicate guard"],
                "pending": ["retry test", "local preview"],
                "constraints": ["do not deploy", "keep old exports", "preserve user edits"],
                "decision": "use FIFO, not priority order",
                "rejected": "automatic retry of non-idempotent jobs",
                "rollback": "disable queue_v2 flag", "next_action": "run the retry test",
            })
        # The guard requires a registered profile. Register only this temporary
        # copy in an isolated QuotaPie config; never edit the user's accounts.
        self.probe_config = self.run / "quotapie-config.json"
        self.probe_config.write_text(json.dumps({"accounts": {"codex": [{
            "id": "compaction-probe", "label": "Isolated compaction probe",
            "codexHome": str(self.profile), "enabled": True}], "claude": []}}))
        self.pending = {}
        self.events = asyncio.Queue()
        self.seq = 0
        self.tool_calls = 0
        self.round_tool_calls = 0
        self.round_index = 0
        self.relay_events = {}
        self.report = {"normal_model": args.normal_model, "compact_model": args.compact_model,
                       "requested_effort": args.effort, "compaction_effort": "low", "fixture": args.fixture, "threshold": 12000, "rounds": [], "record_id": self.facts["project_code"]}

    def relay_health(self):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.relay_url + "/quotapie-health", timeout=2) as response:
            return json.load(response)

    def write(self, value):
        self.process.stdin.write((json.dumps(value) + "\n").encode())

    async def request(self, method, params):
        self.seq += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.seq] = future
        self.write({"id": self.seq, "method": method, "params": params})
        return await asyncio.wait_for(future, 30)

    async def pump(self):
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                identifier = message.get("id")
                if identifier in self.pending:
                    future = self.pending.pop(identifier)
                    if not future.done():
                        if "error" in message:
                            future.set_exception(RuntimeError("Codex rejected a probe RPC"))
                        else:
                            future.set_result(message.get("result"))
                elif "id" in message:
                    params = message.get("params", {})
                    if message.get("method") == "item/tool/call" and params.get("tool") == "read_probe_record" and self.round_tool_calls == 0:
                        self.tool_calls += 1
                        self.round_tool_calls += 1
                        initial = dict(self.facts)
                        if self.args.fixture == "constraints":
                            initial.update(release_color="silver", max_batch=120)
                        # Later rounds supply only a correction. Earlier constraints must
                        # survive the previous encrypted compactions, not be re-fed.
                        payload = ("AUTHORITATIVE FACTS: " + json.dumps(initial) + "\n" if self.round_index == 0
                                   else "UPDATE ONLY: max_batch is now " + str(self.facts["max_batch"]) + ". Preserve every other earlier fact.\n")
                        payload += "\n".join(
                            f"Historical observation {i}: synthetic task is resolved, no action or constraints remain."
                            for i in range(700)
                        )
                        if self.args.fixture == "constraints" and self.round_index == 0:
                            payload += '\nFINAL CORRECTION: release_color is copper; max_batch is 37. These override the earlier values. All other facts remain in effect.\n'
                        self.write({"id": identifier, "result": {"contentItems": [{"type": "inputText", "text": payload}], "success": True}})
                    else:
                        self.write({"id": identifier, "error": {"code": -32601, "message": "No other probe tools are available"}})
                elif message.get("method"):
                    await self.events.put(message)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Codex app-server closed"))
            await self.events.put({"method": "probe/closed"})

    def capture_relay_events(self):
        for event in self.relay_health().get("recent", []):
            if event.get("threadId") == self.report.get("thread_id"):
                self.relay_events[event["requestId"]] = event

    async def observe_turn(self):
        started = time.monotonic()
        compactions, durations = {}, []
        answer = ""
        while True:
            message = await self.events.get()
            method, params = message["method"], message.get("params", {})
            item = params.get("item", {})
            if method == "item/started" and item.get("type") == "contextCompaction":
                compactions[item["id"]] = time.monotonic()
            if method == "item/completed" and item.get("type") == "contextCompaction":
                if item["id"] in compactions:
                    durations.append(round(time.monotonic() - compactions[item["id"]], 3))
            if method == "item/completed" and item.get("type") == "agentMessage":
                # Commentary is not the final JSON response.
                if item.get("phase") != "commentary":
                    answer += item.get("text", "")
            if method == "probe/closed":
                raise RuntimeError("Codex closed before the turn completed")
            if method == "turn/completed":
                error = params["turn"].get("error") or {}
                if isinstance(error, dict) and isinstance(error.get("message"), str):
                    self.report["provider_error"] = re.sub(r"https?://\S+", "[url]", error["message"])[:2000]
                try:
                    actual = json.loads(answer)
                except ValueError:
                    actual = None
                return {"status": params["turn"]["status"], "facts_preserved": actual == self.facts,
                        "fields_preserved": sum(actual.get(k) == v for k, v in self.facts.items()) if isinstance(actual, dict) else 0,
                        "fields_total": len(self.facts), "compaction_seconds": durations,
                        "seconds": round(time.monotonic() - started, 3)}

    async def execute(self):
        environment = dict(os.environ, CODEX_HOME=str(self.profile),
                           QUOTAPIE_CONFIG=str(self.probe_config), QUOTAPIE_HOME=str(self.run / "data"))
        for key in ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENAI_API_KEY", "OPENAI_BASE_URL",
                    "OPENAI_API_BASE", "CHATGPT_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]:
            environment.pop(key, None)
        command = [self.args.bun, str(Path(self.args.runtime_root).resolve() / "src/cli.ts"), "codex", "--codex-bin", self.args.codex_bin,
                   "--compact-from", self.args.normal_model, "--compact-model", self.args.compact_model,
                   "--", "app-server", "--listen", "stdio://"]
        if self.relay_settings:
            command = [self.args.codex_bin, "app-server", "--listen", "stdio://"]
            self.before_relay = self.relay_health()
        with (self.run / "transport.log").open("w") as log:
            self.process = await asyncio.create_subprocess_exec(
                *command, cwd=self.workspace, env=environment,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=log,
                limit=8 * 1024 * 1024,
            )
            reader = asyncio.create_task(self.pump())
            try:
                await self.request("initialize", {
                    "clientInfo": {"name": "quotapie_compaction_probe", "version": "0.1.0"},
                    "capabilities": {"experimentalApi": True},
                })
                self.write({"method": "initialized"})
                result = await self.request("thread/start", {
                    "model": self.args.normal_model, "cwd": str(self.workspace), "approvalPolicy": "never", "sandbox": "read-only",
                    "baseInstructions": "This is a synthetic compaction test. Use only read_probe_record once when the user requests a record read. Preserve its authoritative facts through compaction.",
                    "developerInstructions": "Do not access files or network. When asked, call read_probe_record once. Apply any final corrections, then return every authoritative fact as one JSON object. Preserve lists and exact values; do not add prose or keys.",
                    "dynamicTools": [{"name": "read_probe_record", "description": "Read synthetic project facts and expendable observations.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}],
                })
                self.report["thread_id"] = result["thread"]["id"]
                self.report["provider"] = result.get("modelProvider")
                self.report["settings_before"] = {"model": result.get("model"), "effort": result.get("reasoningEffort")}
                for round_index in range(self.args.rounds):
                    self.round_index = round_index
                    self.round_tool_calls = 0
                    if round_index:
                        self.facts["max_batch"] += 7
                    await self.request("turn/start", {
                        "threadId": result["thread"]["id"],
                        "input": [{"type": "text", "text": f"This is record-read round {round_index + 1}. Call read_probe_record again now, even if you called it in an earlier turn. Then return all authoritative facts as JSON. Apply this round's corrections and retain every earlier unchanged fact."}],
                    })
                    outcome = await self.observe_turn()
                    outcome["tool_calls"] = self.round_tool_calls
                    self.report["rounds"].append(outcome)
                    print(json.dumps({"round": round_index + 1, **outcome}), flush=True)
                    if self.relay_settings:
                        self.capture_relay_events()
                    if outcome["status"] != "completed":
                        raise RuntimeError("Probe turn failed; no follow-up inference will be sent")
                self.report["turn_status"] = self.report["rounds"][-1]["status"]
                self.report["facts_preserved"] = all(r["facts_preserved"] for r in self.report["rounds"])
                self.report["compaction_seconds"] = [duration for r in self.report["rounds"] for duration in r["compaction_seconds"]]
                after = (await self.request("thread/read", {"threadId": self.report["thread_id"]}))["thread"]
                self.report["settings_after_compaction"] = {"model": after.get("model"), "effort": after.get("reasoningEffort")}
                # Deliberately omit model and effort: explicit overrides would hide
                # a compaction that accidentally changed subsequent work settings.
                await self.request("turn/start", {"threadId": self.report["thread_id"],
                    "input": [{"type": "text", "text": "Do not call a tool. Repeat the authoritative facts as the same JSON object."}]})
                followup = await self.observe_turn()
                self.report["next_turn_status"] = followup["status"]
                self.report["next_turn_facts_preserved"] = followup["facts_preserved"]
                if self.relay_settings:
                    self.capture_relay_events()
                after = (await self.request("thread/read", {"threadId": self.report["thread_id"]}))["thread"]
                self.report["settings_after_next_turn"] = {"model": after.get("model"), "effort": after.get("reasoningEffort")}
            finally:
                if self.process.returncode is None:
                    self.process.terminate()
                    try:
                        await asyncio.wait_for(self.process.wait(), 10)
                    except asyncio.TimeoutError:
                        self.process.kill()
                        await self.process.wait()
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
        transport = (self.run / "transport.log").read_text()
        relay_events = []
        for line in transport.splitlines():
            try:
                event = json.loads(line)
                if event.get("service") == "quotapie-compaction" and "requestId" in event:
                    relay_events.append(event)
            except (ValueError, AttributeError):
                pass
        if self.relay_settings:
            # Associate only this probe, never another desktop task's global count.
            self.capture_relay_events()
            relay_events = list(self.relay_events.values())
        compact_events = [event for event in relay_events if event.get("kind") == "compaction" and event.get("phase") == "completed"]
        self.report["routed_requests"] = sum(bool(event.get("routed")) for event in compact_events)
        self.report["completed_compactions"] = len(compact_events)
        self.report["request_usage"] = [{"kind": e.get("kind"), "model": e.get("responseModel"),
            "usage": e.get("usage"), "duration_ms": e.get("durationMs")}
            for e in relay_events if e.get("phase") == "completed"]
        self.report["routing_statuses"] = [event["status"] for event in compact_events]
        self.report["observed_compaction_efforts"] = [event.get("reasoningEffort") for event in compact_events]
        self.report["relay_completion_ids"] = [event["requestId"] for event in compact_events]
        ordinary_events = [event for event in relay_events if event.get("kind") == "response" and event.get("phase") == "completed"]
        self.report["observed_work_settings"] = [{"model": event.get("to"), "effort": event.get("reasoningEffort")} for event in ordinary_events]
        plaintext = []
        turn_models = []
        turn_efforts = []
        for rollout in self.profile.glob("sessions/**/*.jsonl"):
            for line in rollout.open():
                item = json.loads(line)
                if item["type"] == "compacted":
                    history = json.dumps(item["payload"].get("replacement_history", []))
                    plaintext.append(self.facts["project_code"] in history)
                if item["type"] == "turn_context":
                    turn_models.append(item["payload"].get("model"))
                    turn_efforts.append(item["payload"].get("effort"))
        self.report["original_fact_absent_from_plaintext_history"] = bool(plaintext) and not any(plaintext)
        self.report["turn_models"] = turn_models
        self.report["turn_efforts"] = turn_efforts
        expected = {"model": self.args.normal_model, "effort": self.args.effort}
        self.report["settings_preserved"] = all(self.report.get(key) == expected for key in
            ["settings_before", "settings_after_compaction", "settings_after_next_turn"])
        self.report["passed"] = all([
            self.report.get("turn_status") == "completed", self.report.get("facts_preserved"),
            self.report["completed_compactions"] >= self.args.rounds,
            all(r["compaction_seconds"] for r in self.report["rounds"]),
            self.report["original_fact_absent_from_plaintext_history"],
            bool(turn_models) and set(turn_models) == {self.args.normal_model},
            bool(turn_efforts) and set(turn_efforts) == {self.args.effort}, self.tool_calls == self.args.rounds,
            all(r["tool_calls"] == 1 for r in self.report["rounds"]),
            self.report["settings_preserved"], self.report.get("next_turn_status") == "completed",
            self.report.get("next_turn_facts_preserved"),
            bool(compact_events) and all(event.get("reasoningEffort") == "low" for event in compact_events),
            bool(ordinary_events) and all(item == expected for item in self.report["observed_work_settings"]),
        ])


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", default=str(ROOT), help="QuotaPie runtime to exercise, including an installed runtime directory")
    parser.add_argument("--codex-bin", default=shutil.which("codex"))
    parser.add_argument("--bun", default=shutil.which("bun"))
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    parser.add_argument("--relay-settings", help="Use an installed persistent relay via the built-in OpenAI provider")
    parser.add_argument("--normal-model", default="gpt-6-astra")
    parser.add_argument("--compact-model", default="gpt-5.6-sol")
    parser.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], default="low")
    parser.add_argument("--fixture", choices=["basic", "constraints"], default="basic")
    parser.add_argument("--rounds", type=int, choices=range(1, 6), default=1)
    parser.add_argument("--record-id", help="Use the same synthetic identifier for paired comparisons")
    args = parser.parse_args()
    if not args.codex_bin or not args.bun:
        parser.error("Codex and Bun must be installed or passed explicitly")
    if not all(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", model) for model in [args.normal_model, args.compact_model]):
        parser.error("Invalid model name")
    probe = Probe(args)
    print(f"Private evidence: {probe.run}", flush=True)
    try:
        await asyncio.wait_for(probe.execute(), 180 * args.rounds)
    except Exception as error:
        probe.report.update(passed=False, failure_type=type(error).__name__)
    finally:
        (probe.profile / "auth.json").unlink(missing_ok=True)
    (probe.run / "result.json").write_text(json.dumps(probe.report, indent=2) + "\n")
    print(json.dumps(probe.report, indent=2))
    return 0 if probe.report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
