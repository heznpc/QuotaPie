#!/usr/bin/env python3
"""Install, inspect, or disable the opt-in local Codex compaction relay on macOS."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.request

LABEL = "local.quotapie.compaction"
BEGIN = "# BEGIN QuotaPie compaction relay\n"
END = "# END QuotaPie compaction relay\n"


def strip_managed_config(text):
    if BEGIN not in text and END not in text:
        return text
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise ValueError("Ambiguous QuotaPie configuration markers")
    begin, end = text.index(BEGIN), text.index(END) + len(END)
    if begin != 0 or end <= len(BEGIN):
        raise ValueError("QuotaPie configuration block was moved or edited")
    managed = tomllib.loads(text[begin + len(BEGIN):end - len(END)])
    if set(managed) != {"openai_base_url"}:
        raise ValueError("QuotaPie configuration block contains unrelated settings")
    return text[end:]


def enabled_config(text, base_url):
    rest = strip_managed_config(text)
    config = tomllib.loads(rest)
    if "openai_base_url" in config:
        raise ValueError("An existing OpenAI endpoint is configured; refusing to replace it")
    if config.get("model_provider", "openai") != "openai":
        raise ValueError("The selected provider is not OpenAI; refusing to replace it")
    result = BEGIN + "openai_base_url = " + json.dumps(base_url) + "\n" + END + rest
    tomllib.loads(result)
    return result


def atomic_write(path, text, expected=None, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if expected is not None and path.read_text() != expected:
        raise RuntimeError("File changed during installation; retry without overwriting it")
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(text)
            os.fchmod(output.fileno(), mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def activate_generation(config_path, old_config, new_config, manifest_path, manifest, start, verify, stop):
    """Publish a tested generation; on failure restore only our config block.

    The previous service and its immutable files are never stopped or replaced.
    Rollback preserves unrelated edits that may have arrived during activation.
    """
    try:
        start()
        verify()
        atomic_write(config_path, new_config, expected=old_config if config_path.exists() else None)
        atomic_write(manifest_path, json.dumps(manifest, indent=2) + "\n")
    except Exception:
        candidate_url = tomllib.loads(new_config).get("openai_base_url")
        current = config_path.read_text() if config_path.exists() else ""
        if tomllib.loads(current).get("openai_base_url") == candidate_url:
            rest = strip_managed_config(current)
            old_url = tomllib.loads(old_config).get("openai_base_url")
            restored = enabled_config(rest, old_url) if old_url else rest
            # If this fails, keep the candidate alive: the config may still refer to it.
            atomic_write(config_path, restored, expected=current)
        stop()
        raise


class LocalRelay:
    def __init__(self):
        self.home = Path.home()
        self.runtime = self.home / ".local/lib/quotapie-compaction"
        self.manifest_path = self.runtime / "current.json"
        self.manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else {}
        self.settings_path = Path(self.manifest.get("settings_path", self.runtime / "settings.json"))
        self.domain = f"gui/{os.getuid()}"

    def settings(self):
        return json.loads(self.settings_path.read_text())

    def agent_path(self, settings):
        return self.home / "Library/LaunchAgents" / (settings.get("label", LABEL) + ".plist")

    def wait_healthy(self, settings):
        for _ in range(40):
            try:
                return self.health(settings)
            except (OSError, ValueError, RuntimeError):
                time.sleep(0.1)
        raise RuntimeError("Candidate relay did not become healthy; the previous relay is retained")

    @staticmethod
    def endpoint(settings):
        return f"http://127.0.0.1:{settings['port']}/{settings['token']}/backend-api/codex"

    def health(self, settings):
        # Bypass shell HTTP proxy settings for this strictly loopback request.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.endpoint(settings) + "/quotapie-health", timeout=2) as response:
            result = json.load(response)
        if result.get("service") != "quotapie-compaction" or result.get("route") != settings["route"]:
            raise RuntimeError("Unexpected relay health response")
        return result

    def install(self, args):
        if sys.platform != "darwin":
            raise RuntimeError("Local installation currently requires macOS launchd")
        previous = self.settings() if self.settings_path.exists() else {}
        source = Path(args.source or previous.get("source", Path(__file__).resolve().parent.parent)).resolve()
        bun = args.bun or shutil.which("bun")
        if not bun:
            raise RuntimeError("Bun is required")
        config_path = Path(args.codex_home or previous.get("codex_home", self.home / ".codex")).expanduser().resolve() / "config.toml"
        old_config = config_path.read_text() if config_path.exists() else ""
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        # A new listener is staged beside the old one. Loaded desktop tasks keep
        # their old endpoint, so replacing a binary or killing that listener is unsafe.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        token = secrets.token_hex(24)
        generation = str(time.time_ns())
        release = self.runtime / "releases" / generation
        release.mkdir(parents=True, mode=0o700)
        policy = dict(previous.get("route", {"from": "gpt-6-astra", "to": "gpt-5.6-sol"}))
        policy["effort"] = args.compact_effort or policy.get("effort", "low")
        if args.compact_model:
            policy["to"] = args.compact_model
        settings = {
            "port": port, "token": token, "route": policy,
            "label": LABEL + "." + generation, "bun": str(Path(bun).resolve()),
            "source": str(source), "codex_home": str(config_path.parent),
        }
        new_config = enabled_config(old_config, self.endpoint(settings))
        candidate_path = release / "settings.json"
        binary = release / "relay.js"
        subprocess.run([bun, "build", str(source / "src/codex-compaction-daemon.ts"), "--target=bun", "--outfile", str(binary)], check=True, capture_output=True)
        atomic_write(candidate_path, json.dumps(settings, indent=2) + "\n")
        subprocess.run([bun, str(binary), "--check-policy", str(candidate_path)], check=True, capture_output=True)
        manager = self.runtime / "manage.py"
        if Path(__file__).resolve() != manager:
            atomic_write(manager, Path(__file__).read_text())
        command = self.home / ".local/bin/quotapie-compaction"
        def shell_quote(value):
            return "'" + str(value).replace("'", "'\"'\"'") + "'"
        atomic_write(command, "#!/bin/sh\nexec " + shell_quote(sys.executable) + " " + shell_quote(manager) + ' "$@"\n', mode=0o700)
        log = release / "relay.log"
        log.touch(mode=0o600, exist_ok=True)
        agent = {
            "Label": settings["label"],
            "ProgramArguments": [str(Path(bun).resolve()), str(binary), str(candidate_path)],
            "RunAtLoad": True, "KeepAlive": True, "ProcessType": "Background", "ThrottleInterval": 5,
            "WorkingDirectory": str(release), "StandardOutPath": str(log), "StandardErrorPath": str(log), "Umask": 0o077,
        }
        agent_path = self.agent_path(settings)
        atomic_write(agent_path, plistlib.dumps(agent).decode())
        retired = list(self.manifest.get("retired_settings", []))
        if previous and str(self.settings_path) not in retired:
            retired.append(str(self.settings_path))
        manifest = {"settings_path": str(candidate_path), "retired_settings": retired}
        atomic_write(config_path.with_name(f"config.toml.quotapie-compaction-{generation}.bak"), old_config)
        def stop_candidate():
            subprocess.run(["launchctl", "bootout", self.domain + "/" + settings["label"]], capture_output=True)
            agent_path.unlink(missing_ok=True)
        activate_generation(config_path, old_config, new_config, self.manifest_path, manifest,
                            lambda: subprocess.run(["launchctl", "bootstrap", self.domain, str(agent_path)], check=True, capture_output=True),
                            lambda: self.wait_healthy(settings), stop_candidate)
        self.manifest = manifest
        self.settings_path = candidate_path
        return self.status()

    def status(self):
        if not self.settings_path.exists():
            return {"installed": False, "configured": False, "running": False}
        settings = self.settings()
        config_path = Path(settings["codex_home"]) / "config.toml"
        config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
        result = {
            "installed": True,
            "configured": config.get("openai_base_url") == self.endpoint(settings),
            "running": False,
            "config_path": str(config_path),
            "route": settings["route"],
            "settings_path": str(self.settings_path),
            "retained_for_loaded_tasks": self.manifest.get("retired_settings", []),
        }
        try:
            result.update(running=True, relay=self.health(settings))
        except (OSError, ValueError, RuntimeError):
            pass
        return result

    def configure(self, args):
        settings = self.settings()
        if self.health(settings).get("schemaVersion", 1) < 2:
            raise RuntimeError("Install the current relay before changing compaction policy")
        old = self.settings_path.read_text()
        if args.compact_model:
            settings["route"]["to"] = args.compact_model
        if args.compact_effort:
            settings["route"]["effort"] = args.compact_effort
        candidate = self.settings_path.with_name("policy-candidate.json")
        atomic_write(candidate, json.dumps(settings))
        try:
            subprocess.run([settings["bun"], str(self.settings_path.parent / "relay.js"), "--check-policy", str(candidate)], check=True, capture_output=True)
            atomic_write(self.settings_path, json.dumps(settings, indent=2) + "\n", expected=old)
            try:
                self.wait_healthy(settings)
            except Exception:
                atomic_write(self.settings_path, old, expected=json.dumps(settings, indent=2) + "\n")
                raise
        finally:
            candidate.unlink(missing_ok=True)
        return self.status()

    def disable(self):
        if not self.settings_path.exists():
            return self.status()
        settings = self.settings()
        config_path = Path(settings["codex_home"]) / "config.toml"
        if config_path.exists():
            current = config_path.read_text()
            configured = tomllib.loads(current).get("openai_base_url")
            if configured == self.endpoint(settings):
                restored = strip_managed_config(current)
                if restored == current:
                    raise RuntimeError("Configured relay URL has no managed block; refusing to remove unrelated settings")
                atomic_write(config_path, restored, expected=current)
            elif BEGIN in current:
                raise RuntimeError("Relay endpoint was edited; refusing to overwrite the change")
        # Leave the relay alive for already-loaded tasks, forwarding without rerouting.
        # New/resumed Codex sessions now connect directly to the original provider.
        for path in [str(self.settings_path), *self.manifest.get("retired_settings", [])]:
            file = Path(path)
            legacy = json.loads(file.read_text())
            legacy["route"]["to"] = legacy["route"]["from"]
            atomic_write(file, json.dumps(legacy, indent=2) + "\n")
        settings = self.settings()
        for _ in range(20):
            try:
                self.health(settings)
                break
            except (OSError, ValueError, RuntimeError):
                time.sleep(0.1)
        return {"configured": False, "restart_required": True,
                "next": "Quit and reopen Codex, then run quotapie-compaction stop. The relay remains available to currently loaded tasks until then."}

    def stop(self):
        if self.status().get("configured"):
            raise RuntimeError("Disable routing before stopping the relay")
        retained = []
        for path in [str(self.settings_path), *self.manifest.get("retired_settings", [])]:
            settings = json.loads(Path(path).read_text())
            try:
                health = self.health(settings)
            except (OSError, ValueError, RuntimeError):
                health = None
            if health and health.get("schemaVersion", 1) < 2:
                retained.append({"settings_path": path, "reason": "Legacy relay cannot report active requests; retained for loaded tasks"})
                continue
            if health:
                request = urllib.request.Request(self.endpoint(settings) + "/quotapie-drain", method="POST")
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(request, timeout=2) as response:
                    drain = json.load(response)
                if drain["activeRequests"]:
                    retained.append({"settings_path": path, "reason": "Waiting for active requests to finish; run stop again"})
                    continue
            subprocess.run(["launchctl", "bootout", self.domain + "/" + settings.get("label", LABEL)], capture_output=True)
            self.agent_path(settings).unlink(missing_ok=True)
        return {"configured": False, "retained": retained, "running": bool(retained)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "status", "configure", "disable", "stop"])
    parser.add_argument("--source")
    parser.add_argument("--bun")
    parser.add_argument("--codex-home")
    parser.add_argument("--compact-model")
    parser.add_argument("--compact-effort", choices=["low"])
    args = parser.parse_args()
    relay = LocalRelay()
    relay.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (relay.runtime / "management.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Another manager may have activated a generation while we waited.
        relay = LocalRelay()
        if args.action in ["install", "configure"]:
            result = getattr(relay, args.action)(args)
        else:
            result = getattr(relay, args.action)()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
