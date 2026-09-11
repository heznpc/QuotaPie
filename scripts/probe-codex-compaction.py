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
        (self.profile / "auth.json").symlink_to(auth)
        (self.profile / "config.toml").write_text(
            'cli_auth_credentials_store = "file"\n'
            'model = "gpt-6-astra"\n'
            'model_reasoning_effort = "low"\n'
            'approval_policy = "never"\n'
            'sandbox_mode = "read-only"\n'
            'model_auto_compact_token_limit = 12000\n'
            '[features]\nremote_plugin = false\napps = false\n'
        )
        self.relay_settings = json.loads(Path(args.relay_settings).read_text()) if args.relay_settings else None
        if self.relay_settings:
            settings = self.relay_settings
            self.relay_url = f"http://127.0.0.1:{settings['port']}/{settings['token']}/backend-api/codex"
            config_path = self.profile / "config.toml"
            config_path.write_text("openai_base_url = " + json.dumps(self.relay_url) + "\n" + config_path.read_text())
        self.facts = {
            "project_code": secrets.token_hex(8),
            "release_color": "copper",
            "max_batch": 37,
        }
        self.pending = {}
        self.events = asyncio.Queue()
        self.seq = 0
        self.tool_calls = 0
        self.report = {"normal_model": "gpt-6-astra", "compact_model": "gpt-5.6-sol", "threshold": 12000}

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
                    if message.get("method") == "item/tool/call" and params.get("tool") == "read_probe_record" and self.tool_calls == 0:
                        self.tool_calls += 1
                        payload = "AUTHORITATIVE FACTS: " + json.dumps(self.facts) + "\n"
                        payload += "\n".join(
                            f"Historical observation {i}: synthetic task is resolved, no action or constraints remain."
                            for i in range(700)
                        )
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

    async def execute(self):
        environment = dict(os.environ, CODEX_HOME=str(self.profile))
        for key in ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]:
            environment.pop(key, None)
        command = [self.args.bun, str(ROOT / "src/cli.ts"), "codex", "--codex-bin", self.args.codex_bin, "--", "app-server", "--stdio"]
        if self.relay_settings:
            command = [self.args.codex_bin, "app-server", "--stdio"]
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
                    "model": "gpt-6-astra", "cwd": str(self.workspace), "approvalPolicy": "never", "sandbox": "read-only",
                    "baseInstructions": "This is a synthetic compaction test. Use only read_probe_record exactly once. Preserve its authoritative facts through compaction.",
                    "developerInstructions": "Do not access files or network. Call read_probe_record once, then return its project_code, release_color, and max_batch as JSON.",
                    "dynamicTools": [{"name": "read_probe_record", "description": "Read synthetic project facts and expendable observations.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}],
                })
                self.report["thread_id"] = result["thread"]["id"]
                self.report["provider"] = result.get("modelProvider")
                await self.request("turn/start", {
                    "threadId": result["thread"]["id"], "model": "gpt-6-astra", "effort": "low",
                    "input": [{"type": "text", "text": "Read the probe record once, then return its three authoritative facts as JSON."}],
                })
                started = time.monotonic()
                compactions = {}
                answer = ""
                while True:
                    message = await self.events.get()
                    method, params = message["method"], message.get("params", {})
                    item = params.get("item", {})
                    if method == "item/started" and item.get("type") == "contextCompaction":
                        compactions[item["id"]] = time.monotonic()
                        print("Native mid-turn compaction started", flush=True)
                    if method == "item/completed" and item.get("type") == "contextCompaction":
                        duration = time.monotonic() - compactions[item["id"]]
                        self.report.setdefault("compaction_seconds", []).append(round(duration, 3))
                    if method == "item/completed" and item.get("type") == "agentMessage":
                        answer += item.get("text", "")
                    if method == "probe/closed":
                        raise RuntimeError("Codex closed before the turn completed")
                    if method == "turn/completed":
                        self.report["turn_status"] = params["turn"]["status"]
                        self.report["turn_seconds"] = round(time.monotonic() - started, 3)
                        break
                try:
                    self.report["facts_preserved"] = json.loads(answer) == self.facts
                except ValueError:
                    self.report["facts_preserved"] = False
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
        self.report["routed_requests"] = transport.count("[QuotaPie] compaction gpt-6-astra → gpt-5.6-sol (HTTP 200)")
        if self.relay_settings:
            self.report["routed_requests"] = self.relay_health()["compactions"] - self.before_relay["compactions"]
        plaintext = []
        turn_models = []
        for rollout in self.profile.glob("sessions/**/*.jsonl"):
            for line in rollout.open():
                item = json.loads(line)
                if item["type"] == "compacted":
                    history = json.dumps(item["payload"].get("replacement_history", []))
                    plaintext.append(self.facts["project_code"] in history)
                if item["type"] == "turn_context":
                    turn_models.append(item["payload"].get("model"))
        self.report["original_fact_absent_from_plaintext_history"] = bool(plaintext) and not any(plaintext)
        self.report["turn_models"] = turn_models
        self.report["passed"] = all([
            self.report.get("turn_status") == "completed", self.report.get("facts_preserved"),
            self.report["routed_requests"] > 0, bool(self.report.get("compaction_seconds")),
            self.report["original_fact_absent_from_plaintext_history"],
            bool(turn_models) and set(turn_models) == {"gpt-6-astra"}, self.tool_calls == 1,
        ])


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-bin", default=shutil.which("codex"))
    parser.add_argument("--bun", default=shutil.which("bun"))
    parser.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    parser.add_argument("--relay-settings", help="Use an installed persistent relay via the built-in OpenAI provider")
    args = parser.parse_args()
    if not args.codex_bin or not args.bun:
        parser.error("Codex and Bun must be installed or passed explicitly")
    probe = Probe(args)
    print(f"Private evidence: {probe.run}", flush=True)
    try:
        await asyncio.wait_for(probe.execute(), 180)
    except Exception as error:
        probe.report.update(passed=False, failure_type=type(error).__name__)
    (probe.run / "result.json").write_text(json.dumps(probe.report, indent=2) + "\n")
    print(json.dumps(probe.report, indent=2))
    return 0 if probe.report.get("passed") else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
