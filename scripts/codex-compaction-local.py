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


def registered_settings(manifest):
    return list(dict.fromkeys([manifest["settings_path"], *manifest.get("profile_settings", {}).values(),
                               *manifest.get("retired_settings", [])]))


def updated_manifest(manifest, candidate, codex_home, primary_home):
    next_manifest = dict(manifest)
    profiles = dict(manifest.get("profile_settings", {}))
    retired = list(manifest.get("retired_settings", []))
    if manifest.get("settings_path") and codex_home != primary_home:
        previous = profiles.get(codex_home)
        profiles[codex_home] = candidate
    else:
        previous = manifest.get("settings_path")
        next_manifest["settings_path"] = candidate
    if previous and previous not in retired:
        retired.append(previous)
    next_manifest["profile_settings"] = profiles
    next_manifest["retired_settings"] = retired
    return next_manifest


class LocalRelay:
    def __init__(self):
        self.home = Path.home()
        self.runtime = self.home / ".local/lib/quotapie-compaction"
        self.manifest_path = self.runtime / "current.json"
        self.manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else {}
        self.settings_path = Path(self.manifest.get("settings_path", self.runtime / "settings.json"))
        if self.settings_path.exists():
            self.manifest.setdefault("settings_path", str(self.settings_path))
        self.domain = f"gui/{os.getuid()}"

    def settings(self):
        return json.loads(self.settings_path.read_text())

    def registered_entries(self):
        """Require current/profile settings, but tolerate damaged historical files."""
        active = {self.manifest["settings_path"], *self.manifest.get("profile_settings", {}).values()}
        entries = []
        for value in registered_settings(self.manifest):
            try:
                path = Path(value)
                raw = path.read_text()
                settings = json.loads(raw)
                if (not isinstance(settings, dict) or not isinstance(settings.get("route"), dict)
                        or not all(isinstance(settings["route"].get(key), str) for key in ("from", "to"))
                        or not isinstance(settings.get("codex_home"), str)
                        or not isinstance(settings.get("port"), int) or not isinstance(settings.get("token"), str)):
                    raise ValueError("Invalid relay settings")
                entries.append((path, raw, settings))
            except (OSError, ValueError, TypeError):
                if value in active:
                    raise
        return entries

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
            "taskSavings": previous.get("taskSavings", {"enabled": True, "model": "gpt-5.6-luna", "effort": "low"}),
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
        manifest = updated_manifest(self.manifest, str(candidate_path), str(config_path.parent),
                                    str(Path(previous.get("codex_home", config_path.parent)).resolve()))
        atomic_write(config_path.with_name(f"config.toml.quotapie-compaction-{generation}.bak"), old_config)
        def stop_candidate():
            subprocess.run(["launchctl", "bootout", self.domain + "/" + settings["label"]], capture_output=True)
            agent_path.unlink(missing_ok=True)
        activate_generation(config_path, old_config, new_config, self.manifest_path, manifest,
                            lambda: subprocess.run(["launchctl", "bootstrap", self.domain, str(agent_path)], check=True, capture_output=True),
                            lambda: self.wait_healthy(settings), stop_candidate)
        self.manifest = manifest
        self.settings_path = Path(manifest["settings_path"])
        try:
            retirement = self.retire()
        except (OSError, ValueError, RuntimeError, TypeError) as error:
            # Activation already succeeded. Retirement must not invalidate it.
            retirement = {"error": str(error), "loaded_listeners_untouched": True}
        if str(config_path.parent) in manifest["profile_settings"]:
            return {"installed": True, "configured": True, "running": True, "restart_required": True,
                    "settings_path": str(candidate_path), "relay": self.health(settings), "retirement": retirement}
        return {**self.status(), "retirement": retirement}

    def retire(self):
        """Retire login persistence, never a listener loaded by an existing task.

        launchd retains the loaded job (including crash recovery) for this login.
        After logout/reboot no old clients survive and only current agents reload.
        Idleness alone cannot prove a loaded conversation has released its endpoint.
        """
        active = {self.manifest["settings_path"], *self.manifest.get("profile_settings", {}).values()}
        entries = self.registered_entries()
        replacements = {}
        for path, _, settings in entries:
            if str(path) not in active:
                continue
            try:
                config = tomllib.loads((Path(settings["codex_home"]) / "config.toml").read_text())
                if config.get("openai_base_url") == self.endpoint(settings):
                    self.health(settings)
                    replacements[str(Path(settings["codex_home"]).resolve())] = settings
            except (OSError, ValueError, RuntimeError):
                pass
        archived, retained = [], []
        for path, _, settings in entries:
            if str(path) in active:
                continue
            agent = self.agent_path(settings)
            if not agent.exists():
                continue
            try:
                home = str(Path(settings["codex_home"]).resolve())
                if home not in replacements:
                    raise ValueError("No healthy configured replacement")
                raw = agent.read_bytes()
                job = plistlib.loads(raw)
                args = job.get("ProgramArguments", [])
                if (job.get("Label") != settings.get("label", LABEL) or len(args) != 3
                        or args[1:] != [str(path.parent / "relay.js"), str(path)]):
                    raise ValueError("Launch agent ownership could not be verified")
                archive = path.parent / "retired-launch-agent.plist"
                if archive.exists():
                    raise ValueError("An archived launch agent already exists")
                config = tomllib.loads((Path(home) / "config.toml").read_text())
                if config.get("openai_base_url") != self.endpoint(replacements[home]):
                    raise ValueError("Configuration changed during retirement")
                # A rename preserves the exact job for recovery, without bootout,
                # drain, config changes, or replacing the running relay binary.
                agent.rename(archive)
                archived.append(str(path))
            except (OSError, ValueError, TypeError, plistlib.InvalidFileException) as error:
                retained.append({"settings_path": str(path), "reason": str(error)})
        return {"retired_after_logout": archived, "retained": retained,
                "loaded_listeners_untouched": True}

    def ensure_profile(self, args):
        if not args.codex_home:
            raise ValueError("Profile home required")
        if not self.settings_path.exists() or not self.status().get("configured"):
            return {"relayConnected": False}
        target = Path(args.codex_home).expanduser().resolve()
        if not target.is_dir():
            raise ValueError("Profile home does not exist")
        config_path = target / "config.toml"
        config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
        endpoint = config.get("openai_base_url")
        for _, _, settings in self.registered_entries():
            if Path(settings.get("codex_home", "")).resolve() == target and endpoint == self.endpoint(settings):
                self.health(settings)
                return {"relayConnected": True, "restart_required": True}
        # Existing custom endpoints are rejected by enabled_config, never replaced.
        self.install(args)
        return {"relayConnected": True, "restart_required": True}

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
        changes = []
        # Match the dashboard: update every compatible live generation, including
        # endpoints retained by loaded tasks and separately registered profiles.
        for path, old, settings in self.registered_entries():
            try:
                compatible = self.health(settings).get("schemaVersion", 1) >= 2
            except (OSError, ValueError, RuntimeError):
                if path == self.settings_path:
                    raise
                continue
            if not compatible:
                if path == self.settings_path:
                    raise RuntimeError("Install the current relay before changing compaction policy")
                continue
            if args.compact_model:
                settings["route"]["to"] = args.compact_model
            if args.compact_effort:
                settings["route"]["effort"] = args.compact_effort
            candidate = path.with_name("policy-candidate.json")
            try:
                atomic_write(candidate, json.dumps(settings))
                subprocess.run([settings["bun"], str(path.parent / "relay.js"), "--check-policy", str(candidate)], check=True, capture_output=True)
            finally:
                candidate.unlink(missing_ok=True)
            changes.append((path, old, json.dumps(settings, indent=2) + "\n", settings))
        written = []
        try:
            for path, old, content, settings in changes:
                atomic_write(path, content, expected=old)
                written.append((path, old, content))
            for _, _, _, settings in changes:
                self.wait_healthy(settings)
        except Exception:
            for path, old, content in reversed(written):
                try:
                    atomic_write(path, old, expected=content)
                except (OSError, RuntimeError):
                    pass  # Preserve concurrent edits while restoring the other generations.
            raise
        return self.status()

    def disable(self):
        if not self.settings_path.exists():
            return self.status()
        configs = {}
        entries = self.registered_entries()
        for _, _, settings in entries:
            config_path = Path(settings["codex_home"]) / "config.toml"
            configs.setdefault(config_path, set()).add(self.endpoint(settings))
        changes = []
        for config_path, endpoints in configs.items():
            if not config_path.exists():
                continue
            current = config_path.read_text()
            configured = tomllib.loads(current).get("openai_base_url")
            if configured in endpoints:
                restored = strip_managed_config(current)
                if restored == current:
                    raise RuntimeError("Configured relay URL has no managed block; refusing to remove unrelated settings")
                changes.append((config_path, current, restored))
            elif BEGIN in current:
                raise RuntimeError("Relay endpoint was edited; refusing to overwrite the change")
        for config_path, current, restored in changes:
            atomic_write(config_path, restored, expected=current)
        # Leave the relay alive for already-loaded tasks, forwarding without rerouting.
        # New/resumed Codex sessions now connect directly to the original provider.
        for file, raw, legacy in entries:
            legacy["route"]["to"] = legacy["route"]["from"]
            if isinstance(legacy.get("taskSavings"), dict):
                legacy["taskSavings"]["enabled"] = False
            atomic_write(file, json.dumps(legacy, indent=2) + "\n", expected=raw)
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
        entries = self.registered_entries()
        for _, _, settings in entries:
            config_path = Path(settings["codex_home"]) / "config.toml"
            if config_path.exists() and tomllib.loads(config_path.read_text()).get("openai_base_url") == self.endpoint(settings):
                raise RuntimeError("Disable routing before stopping the relay")
        retained = []
        for path, _, settings in entries:
            def retain(reason):
                retained.append({"settings_path": str(path), "reason": reason})

            try:
                health = self.health(settings)
                if health.get("schemaVersion", 1) < 2:
                    retain("Legacy relay cannot report active requests; retained for loaded tasks")
                    continue
            except (OSError, ValueError, RuntimeError, TypeError, AttributeError):
                retain("Relay health could not be verified; retained until idle can be confirmed")
                continue
            try:
                request = urllib.request.Request(self.endpoint(settings) + "/quotapie-drain", method="POST")
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(request, timeout=2) as response:
                    drain = json.load(response)
                if (not isinstance(drain, dict) or drain.get("draining") is not True
                        or type(drain.get("activeRequests")) is not int or drain["activeRequests"] < 0):
                    raise ValueError("Invalid relay drain response")
            except (OSError, ValueError, RuntimeError):
                retain("Relay drain could not be verified; retained until idle can be confirmed")
                continue
            if drain["activeRequests"]:
                retain("Waiting for active requests to finish; run stop again")
                continue
            stopped = subprocess.run(["launchctl", "bootout", self.domain + "/" + settings.get("label", LABEL)], capture_output=True)
            if stopped.returncode != 0:
                retain("Relay unload failed; run stop again")
                continue
            self.agent_path(settings).unlink(missing_ok=True)
        return {"configured": False, "retained": retained, "running": bool(retained)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "ensure-profile", "status", "configure", "disable", "stop", "retire"])
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
        if args.action in ["install", "configure", "ensure-profile"]:
            result = getattr(relay, args.action.replace("-", "_"))(args)
        else:
            result = getattr(relay, args.action)()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
