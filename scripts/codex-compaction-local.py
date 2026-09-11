#!/usr/bin/env python3
"""Install, inspect, or disable the opt-in local Codex compaction relay on macOS."""

import argparse
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


class LocalRelay:
    def __init__(self):
        self.home = Path.home()
        self.runtime = self.home / ".local/lib/quotapie-compaction"
        self.settings_path = self.runtime / "settings.json"
        self.agent = self.home / "Library/LaunchAgents" / (LABEL + ".plist")
        self.domain = f"gui/{os.getuid()}"

    def settings(self):
        return json.loads(self.settings_path.read_text())

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
        if previous:
            port, token = previous["port"], previous["token"]
        else:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            token = secrets.token_hex(24)
        settings = {
            "port": port, "token": token, "route": {"from": "gpt-6-astra", "to": "gpt-5.6-sol"},
            "source": str(source), "codex_home": str(config_path.parent),
        }
        new_config = enabled_config(old_config, self.endpoint(settings))
        subprocess.run([bun, "build", str(source / "src/codex-compaction-daemon.ts"), "--target=bun", "--outfile", str(self.runtime / "relay.js")], check=True, capture_output=True)
        atomic_write(self.settings_path, json.dumps(settings, indent=2) + "\n")
        manager = self.runtime / "manage.py"
        if Path(__file__).resolve() != manager:
            atomic_write(manager, Path(__file__).read_text())
        command = self.home / ".local/bin/quotapie-compaction"
        def shell_quote(value):
            return "'" + str(value).replace("'", "'\"'\"'") + "'"
        atomic_write(command, "#!/bin/sh\nexec " + shell_quote(sys.executable) + " " + shell_quote(manager) + ' "$@"\n', mode=0o700)
        log = self.runtime / "relay.log"
        log.touch(mode=0o600, exist_ok=True)
        agent = {
            "Label": LABEL,
            "ProgramArguments": [str(Path(bun).resolve()), str(self.runtime / "relay.js"), str(self.settings_path)],
            "RunAtLoad": True, "KeepAlive": True, "ProcessType": "Background", "ThrottleInterval": 5,
            "WorkingDirectory": str(self.runtime), "StandardOutPath": str(log), "StandardErrorPath": str(log), "Umask": 0o077,
        }
        atomic_write(self.agent, plistlib.dumps(agent).decode())
        subprocess.run(["launchctl", "bootout", self.domain + "/" + LABEL], capture_output=True)
        subprocess.run(["launchctl", "bootstrap", self.domain, str(self.agent)], check=True, capture_output=True)
        ready = False
        for _ in range(30):
            try:
                self.health(settings)
                ready = True
                break
            except (OSError, ValueError, RuntimeError):
                time.sleep(0.1)
        if not ready:
            raise RuntimeError("Relay did not start; Codex configuration has not been changed")
        if new_config != old_config:
            backup = config_path.with_name(f"config.toml.quotapie-compaction-{time.time_ns()}.bak")
            atomic_write(backup, old_config)
            atomic_write(config_path, new_config, expected=old_config if config_path.exists() else None)
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
        }
        try:
            result.update(running=True, relay=self.health(settings))
        except (OSError, ValueError, RuntimeError):
            pass
        return result

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
        settings["route"] = {"from": "gpt-6-astra", "to": "gpt-6-astra"}
        atomic_write(self.settings_path, json.dumps(settings, indent=2) + "\n")
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
        subprocess.run(["launchctl", "bootout", self.domain + "/" + LABEL], check=True, capture_output=True)
        if self.agent.exists():
            self.agent.unlink()
        return {"configured": False, "running": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "status", "disable", "stop"])
    parser.add_argument("--source")
    parser.add_argument("--bun")
    parser.add_argument("--codex-home")
    args = parser.parse_args()
    relay = LocalRelay()
    if args.action == "install":
        result = relay.install(args)
    else:
        result = getattr(relay, args.action)()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
