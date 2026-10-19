#!/usr/bin/env python3
"""Install, inspect, or disable the opt-in local Codex compaction relay on macOS."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
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
GUARD_REVISION = 3
RUNTIME_REVISION = 1
LISTENER_POLICY_VERSION = 2
UPGRADE_LABEL = LABEL + ".upgrade"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
    published = False
    try:
        start()
        verify()
        atomic_write(config_path, new_config, expected=old_config if config_path.exists() else None)
        published = True
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
        # Once advertised in config, another task may already have cached the
        # candidate URL. Restoring config cannot revoke that request safely.
        if not published:
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
        # Reuse the exact URL cached by existing conversations. Installation no
        # longer creates a fresh endpoint when this profile already owns one.
        if self.manifest:
            configured = tomllib.loads(old_config).get("openai_base_url")
            matching = [(path, settings) for path, _, settings in self.registered_entries()
                        if Path(settings["codex_home"]).resolve() == config_path.parent
                        and self.endpoint(settings) == configured]
            if matching:
                if getattr(args, "compact_model", None) or getattr(args, "compact_effort", None):
                    self.configure(argparse.Namespace(compact_model=getattr(args, "compact_model", None),
                                                       compact_effort=getattr(args, "compact_effort", None),
                                                       codex_home=str(config_path.parent)))
                self.install_manager()
                result = self.upgrade(argparse.Namespace(source=str(source), codex_home=str(config_path.parent),
                                                         watch=getattr(args, "watch", False)))
                return {"installed": True, "configured": True, "endpoints_preserved": True,
                        "restart_required": False, "upgrade": result,
                        "settings_path": str(matching[0][0]), "pending": bool(result["deferred"])}
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
        policy = dict(previous.get("route", {"from": "gpt-6-astra", "to": "gpt-6-astra"}))
        policy["effort"] = args.compact_effort or policy.get("effort", "low")
        if args.compact_model:
            policy["to"] = args.compact_model
        settings = {
            "port": port, "token": token, "route": policy,
            "taskSavings": previous.get("taskSavings", {"enabled": False, "model": "gpt-5.6-luna", "effort": "low"}),
            "label": LABEL + "." + generation, "bun": str(Path(bun).resolve()),
            "source": str(source), "codex_home": str(config_path.parent),
        }
        new_config = enabled_config(old_config, self.endpoint(settings))
        candidate_path = release / "settings.json"
        binary = release / "relay.js"
        atomic_write(candidate_path, json.dumps(settings, indent=2) + "\n")
        descriptor = self.stage_runtime(candidate_path, settings, source)
        os.replace(release / "relay-runtime-candidate.js", binary)
        atomic_write(release / "runtime-current.json", json.dumps(descriptor, indent=2) + "\n")
        (release / "pending-upgrade.json").unlink()
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
                health = self.health(settings)
                guard = health.get("subscriptionGuard", {})
                profile_key = hashlib.sha256(str(target).encode()).hexdigest()
                if (health.get("relayRuntimeRevision") == RUNTIME_REVISION and health.get("reloadSupported") is True
                        and health.get("subscriptionGuardVersion") == 1 and health.get("subscriptionGuardRevision") == GUARD_REVISION
                        and health.get("nativeRequestPolicyVersion") == 1 and health.get("nativeRequestPolicy") == "source-origin"
                        and health.get("sourceContinuationRevision") == 3 and health.get("executionMode") == "interactive"
                        and guard.get("version") == 1
                        and guard.get("profileKey") == profile_key and guard.get("account")):
                    return {"relayConnected": True, "restart_required": False}
                # Keep the loaded endpoint and stage its replacement safely.
                break
        # Existing custom endpoints are rejected by enabled_config, never replaced.
        result = self.install(args)
        connected = False
        current_endpoint = tomllib.loads(config_path.read_text()).get("openai_base_url")
        for _, _, settings in self.registered_entries():
            if Path(settings["codex_home"]).resolve() != target or self.endpoint(settings) != current_endpoint:
                continue
            try:
                current = self.health(settings)
                guard = current.get("subscriptionGuard", {})
                connected = (current.get("subscriptionGuardVersion") == 1
                             and current.get("subscriptionGuardRevision") == GUARD_REVISION
                             and current.get("nativeRequestPolicyVersion") == 1 and current.get("nativeRequestPolicy") == "source-origin"
                             and current.get("sourceContinuationRevision") == 3 and current.get("executionMode") == "interactive"
                             and guard.get("profileKey") == hashlib.sha256(str(target).encode()).hexdigest()
                             and guard.get("version") == 1 and bool(guard.get("account")))
            except (OSError, ValueError, RuntimeError):
                pass
        # Old historical listeners can still be pending even when the configured
        # profile endpoint is healthy; keep those two observations separate.
        return {"relayConnected": connected, "restart_required": result.get("restart_required", False),
                "upgrade": result.get("upgrade"), "pending": result.get("pending", False)}

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
        result["listenerUpgrades"] = [state for path, _, settings in self.registered_entries()
                                      if (state := self.listener_upgrade_status(path, settings)) is not None]
        return result

    def install_manager(self):
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        manager = self.runtime / "manage.py"
        if Path(__file__).resolve() != manager:
            atomic_write(manager, Path(__file__).read_text())
        return manager

    def install_upgrade_watcher(self):
        """Explicitly enrolled retry, never an implicit process termination."""
        manager = self.install_manager()
        agent = self.home / "Library/LaunchAgents" / (UPGRADE_LABEL + ".plist")
        job = {"Label": UPGRADE_LABEL, "ProgramArguments": [sys.executable, str(manager), "apply-upgrades"],
               "RunAtLoad": True, "StartInterval": 30, "ProcessType": "Background", "Umask": 0o077,
               "StandardOutPath": str(self.runtime / "upgrade.log"), "StandardErrorPath": str(self.runtime / "upgrade.log")}
        content = plistlib.dumps(job).decode()
        if agent.exists():
            if plistlib.loads(agent.read_bytes()).get("ProgramArguments") != job["ProgramArguments"]:
                raise RuntimeError("Upgrade watcher ownership could not be verified")
            atomic_write(agent, content, expected=agent.read_text())
        else:
            atomic_write(agent, content)
        loaded = subprocess.run(["launchctl", "print", self.domain + "/" + UPGRADE_LABEL], capture_output=True)
        if loaded.returncode != 0:
            subprocess.run(["launchctl", "bootstrap", self.domain, str(agent)], check=True, capture_output=True)
        return {"installed": True, "interval_seconds": 30}

    def owned_agent(self, path, settings):
        # Older registrations may lack the executable identity. They cannot be
        # upgraded safely, but must not prevent verified generations upgrading.
        if (not isinstance(settings, dict) or not isinstance(settings.get("bun"), str)
                or not settings["bun"].strip()):
            raise RuntimeError("Relay launch agent ownership could not be verified")
        agent = self.agent_path(settings)
        if not agent.exists():
            agent = path.parent / "retired-launch-agent.plist"
        job = plistlib.loads(agent.read_bytes())
        if (job.get("Label") != settings.get("label", LABEL)
                or job.get("ProgramArguments") != [settings["bun"], str(path.parent / "relay.js"), str(path)]):
            raise RuntimeError("Relay launch agent ownership could not be verified")
        return agent

    def listener_upgrade_binding(self, path, settings):
        """Called under management.lock; never reads credentials or controls a process."""
        if path.is_symlink() or json.loads(path.read_text()) != settings:
            raise RuntimeError("Listener settings changed")
        agent = self.owned_agent(path, settings)
        if agent.is_symlink():
            raise RuntimeError("Listener launch ownership changed")
        return {"settingsHash": digest(path), "launchAgentHash": digest(agent),
                "profileKey": hashlib.sha256(str(Path(settings["codex_home"]).resolve()).encode()).hexdigest()}

    @staticmethod
    def listener_identity(health, profile_key):
        guard = health.get("subscriptionGuard")
        if (not isinstance(guard, dict) or guard.get("version") != 1 or guard.get("profileKey") != profile_key
                or not isinstance(guard.get("account"), str) or not guard["account"].strip()
                or guard.get("reason") in {"account-unavailable", "account-identity-changed", "profile-mismatch",
                    "subscription-auth-required", "subscription-auth-unavailable", "request-identity-mismatch"}):
            raise RuntimeError("Listener profile identity unavailable")
        return guard["account"]

    def listener_upgrade_status(self, path, settings, health=None):
        marker = path.parent / "listener-upgrade-pending.json"
        if not marker.exists() and not marker.is_symlink():
            return None
        state = {"generation": path.parent.name, "state": "pending", "reason": "listener-state-unverified",
                 "handlerApplied": False, "listenerApplied": False}
        try:
            if marker.is_symlink():
                raise RuntimeError("Listener marker ownership changed")
            raw = marker.read_text()
            pending = json.loads(raw)
            binding = self.listener_upgrade_binding(path, settings)
            if (pending.get("schemaVersion") != 1 or pending.get("listenerPolicyVersion") != LISTENER_POLICY_VERSION
                    or any(pending.get(key) != value for key, value in binding.items())
                    or any(not isinstance(pending.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", pending[key])
                           for key in ("sourceHash", "bootstrapSourceHash"))):
                raise RuntimeError("Listener binding changed")
            binary = path.parent / "relay.js"
            runtime = path.parent / ("relay-runtime-" + pending["sourceHash"] + ".js")
            if (binary.is_symlink() or runtime.is_symlink() or digest(binary) != pending["bootstrapSourceHash"]
                    or digest(runtime) != pending["sourceHash"]):
                raise RuntimeError("Listener startup files changed")
            observed = self.health(settings) if health is None else health
            account = self.listener_identity(observed, binding["profileKey"])
            if pending.get("account") is not None and pending["account"] != account:
                raise RuntimeError("Listener account changed")
            state["handlerApplied"] = observed.get("runtimeSourceHash") == pending["sourceHash"]
            state["reason"] = "listener-awaiting-natural-restart"
            if (observed.get("relayRuntimeRevision") == RUNTIME_REVISION and observed.get("reloadSupported") is True
                    and observed.get("listenerPolicyVersion") == LISTENER_POLICY_VERSION and state["handlerApplied"]):
                # A health read can race a policy, launch-job or file change.
                # Recheck the complete binding before removing durable evidence.
                if (self.listener_upgrade_binding(path, settings) != binding or marker.read_text() != raw
                        or digest(binary) != pending["bootstrapSourceHash"] or digest(runtime) != pending["sourceHash"]):
                    raise RuntimeError("Listener binding changed during verification")
                marker.unlink()
                state.update(state="applied", reason="listener-verified", listenerApplied=True)
            return state
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError, plistlib.InvalidFileException):
            return {**state, "handlerApplied": False, "reason": "listener-state-unverified"}

    def stage_listener_upgrade(self, path, settings, pending, health):
        """Remember the immutable startup target before replacing its disk file.

        Request-handler reload cannot change the listener. A natural restart is
        the only supported completion path; no request-idle heuristic is used.
        """
        marker = path.parent / "listener-upgrade-pending.json"
        binding = self.listener_upgrade_binding(path, settings)
        if binding["settingsHash"] != pending["settingsHash"]:
            raise RuntimeError("Staged listener settings changed")
        binary = path.parent / "relay.js"
        if binary.is_symlink():
            raise RuntimeError("Listener bootstrap ownership changed")
        previous_hash = digest(binary)
        account = None
        try:
            account = self.listener_identity(health, binding["profileKey"])
        except RuntimeError:
            if health.get("relayRuntimeRevision") == RUNTIME_REVISION:
                raise
        existing = marker.read_text() if marker.exists() else None
        if marker.is_symlink():
            raise RuntimeError("Listener marker ownership changed")
        if existing is not None:
            prior = json.loads(existing)
            if (not isinstance(prior, dict) or prior.get("schemaVersion") != 1
                    or prior.get("listenerPolicyVersion") != LISTENER_POLICY_VERSION
                    or any(prior.get(key) != value for key, value in binding.items())
                    or any(not isinstance(prior.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", prior[key])
                           for key in ("sourceHash", "bootstrapSourceHash"))
                    or previous_hash not in {prior.get("bootstrapSourceHash"), prior.get("previousBootstrapSourceHash")}
                    or prior.get("account") is not None and prior["account"] != account):
                raise RuntimeError("Pending listener identity changed")
            prior_runtime = path.parent / ("relay-runtime-" + prior["sourceHash"] + ".js")
            if prior_runtime.is_symlink() or digest(prior_runtime) != prior["sourceHash"]:
                raise RuntimeError("Pending listener runtime changed")
        record = {"schemaVersion": 1, "listenerPolicyVersion": LISTENER_POLICY_VERSION,
                  "sourceHash": pending["sourceHash"], "bootstrapSourceHash": pending["bootstrapSourceHash"],
                  "previousBootstrapSourceHash": previous_hash, **binding, "account": account,
                  "observedPid": health.get("pid") if type(health.get("pid")) is int else None,
                  "stagedAt": int(time.time() * 1000)}
        atomic_write(marker, json.dumps(record, indent=2) + "\n", expected=existing)

    def finish_handler_upgrade(self, path, settings, pending, bootstrap, health, method):
        marker = path.parent / "pending-upgrade.json"
        if json.loads(marker.read_text()) != pending:
            raise RuntimeError("Runtime upgrade changed during application")
        self.stage_listener_upgrade(path, settings, pending, health)
        replacement = path.parent / "relay-upgrade-replacement.js"
        # Keep the validated candidate until both durable records are updated,
        # so an interrupted disk write can be retried without losing its input.
        shutil.copy2(bootstrap, replacement)
        os.replace(replacement, path.parent / "relay.js")
        if json.loads(marker.read_text()) != pending:
            raise RuntimeError("Runtime upgrade changed during application")
        state = self.listener_upgrade_status(path, settings, health)
        if state["reason"] == "listener-state-unverified":
            raise RuntimeError("Listener application could not be verified")
        if json.loads(marker.read_text()) != pending:
            raise RuntimeError("Runtime upgrade changed during application")
        marker.unlink()
        bootstrap.unlink()
        return {"generation": path.parent.name, "method": method, "sourceHash": pending["sourceHash"],
                "handlerApplied": True, "listenerApplied": state["listenerApplied"]}, state

    def stage_runtime(self, path, settings, source):
        directory = path.parent
        bootstrap = directory / "relay-runtime-candidate.js"
        runtime = directory / "relay-runtime-build.js"
        try:
            for entry, output in (("codex-compaction-daemon.ts", bootstrap), ("codex-relay-runtime.ts", runtime)):
                # Bun includes source-relative paths in its output. A fixed cwd
                # makes runtime identity independent of where the manager ran.
                subprocess.run([settings["bun"], "build", str(source / "src" / entry), "--target=bun", "--outfile", str(output)],
                               cwd=source, check=True, capture_output=True)
            subprocess.run([settings["bun"], str(bootstrap), "--check-policy", str(path)], check=True, capture_output=True)
            source_hash = digest(runtime)
            immutable = directory / ("relay-runtime-" + source_hash + ".js")
            if immutable.exists():
                if immutable.is_symlink() or digest(immutable) != source_hash:
                    raise RuntimeError("Immutable runtime hash mismatch")
                runtime.unlink()
            else:
                os.replace(runtime, immutable)
            descriptor = {"schemaVersion": 1, "sourceHash": source_hash, "candidatePath": str(immutable)}
            atomic_write(directory / "runtime-candidate.json", json.dumps(descriptor, indent=2) + "\n")
            pending = {"schemaVersion": 1, "sourceHash": source_hash, "bootstrapSourceHash": digest(bootstrap),
                       "settingsHash": digest(path), "stagedAt": int(time.time() * 1000)}
            atomic_write(directory / "pending-upgrade.json", json.dumps(pending, indent=2) + "\n")
            return descriptor
        except Exception:
            bootstrap.unlink(missing_ok=True)
            raise
        finally:
            runtime.unlink(missing_ok=True)

    def pending_runtime(self, path):
        directory = path.parent
        pending = json.loads((directory / "pending-upgrade.json").read_text())
        descriptor = json.loads((directory / "runtime-candidate.json").read_text())
        if not isinstance(pending, dict) or not isinstance(descriptor, dict):
            raise RuntimeError("Staged runtime descriptor is invalid")
        source_hash = descriptor.get("sourceHash")
        if (pending.get("schemaVersion") != 1 or descriptor.get("schemaVersion") != 1
                or not isinstance(source_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_hash)
                or pending.get("sourceHash") != source_hash or pending.get("settingsHash") != digest(path)):
            raise RuntimeError("Staged runtime identity changed")
        runtime = directory / ("relay-runtime-" + source_hash + ".js")
        bootstrap = directory / "relay-runtime-candidate.js"
        if (descriptor.get("candidatePath") != str(runtime) or runtime.is_symlink() or bootstrap.is_symlink()
                or digest(runtime) != source_hash or digest(bootstrap) != pending.get("bootstrapSourceHash")):
            raise RuntimeError("Staged runtime integrity failed")
        return pending, descriptor, bootstrap

    def upgrade(self, args):
        """Keep endpoints stable; legacy listeners change only on natural restart."""
        target = Path(args.codex_home).expanduser().resolve() if getattr(args, "codex_home", None) else None
        staged, deferred = [], []
        for path, raw, settings in self.registered_entries():
            if target is not None and Path(settings["codex_home"]).resolve() != target:
                continue
            generation = path.parent.name
            try:
                self.owned_agent(path, settings)
            except (OSError, ValueError, RuntimeError, plistlib.InvalidFileException):
                deferred.append({"generation": generation, "reason": "ownership-unverified"})
                continue
            source = Path(getattr(args, "source", None) or settings.get("source") or Path(__file__).resolve().parent.parent).resolve()
            self.stage_runtime(path, settings, source)
            if path.read_text() != raw:
                raise RuntimeError("Relay settings changed during staging")
            staged.append(generation)
        result = self.apply_upgrades(args)
        result["staged"] = staged
        result["deferred"] = deferred + result["deferred"]
        return result

    def apply_upgrades(self, args=None):
        target = Path(args.codex_home).expanduser().resolve() if args and getattr(args, "codex_home", None) else None
        applied, deferred, listeners = [], [], []
        for path, _, settings in self.registered_entries():
            if target is not None and Path(settings["codex_home"]).resolve() != target:
                continue
            directory, generation = path.parent, path.parent.name
            marker = directory / "pending-upgrade.json"
            if not marker.exists():
                state = self.listener_upgrade_status(path, settings)
                if state is not None:
                    listeners.append(state)
                    if not state["listenerApplied"]:
                        deferred.append({"generation": generation, "reason": state["reason"]})
                continue
            try:
                self.owned_agent(path, settings)
                pending, descriptor, bootstrap = self.pending_runtime(path)
            except (OSError, ValueError, RuntimeError, plistlib.InvalidFileException):
                deferred.append({"generation": generation, "reason": "upgrade-state-unverified"})
                continue
            try:
                health = self.health(settings)
            except (OSError, ValueError, RuntimeError):
                health = {}
            modern = health.get("relayRuntimeRevision") == RUNTIME_REVISION and health.get("reloadSupported") is True
            if modern and health.get("runtimeSourceHash") == descriptor["sourceHash"]:
                # This proves only the handler. The boot-time listener policy
                # remains independently pending until its health confirms it.
                try:
                    result, state = self.finish_handler_upgrade(path, settings, pending, bootstrap, health,
                        "natural-restart" if pending.get("phase") == "legacy-awaiting-natural-restart" else "verified-reload")
                    applied.append(result)
                    listeners.append(state)
                    if not state["listenerApplied"]:
                        deferred.append({"generation": generation, "reason": state["reason"]})
                except (OSError, ValueError, TypeError, RuntimeError, plistlib.InvalidFileException):
                    deferred.append({"generation": generation, "reason": "listener-state-unverified"})
                continue
            binary = directory / "relay.js"
            try:
                if binary.is_symlink():
                    raise RuntimeError("Relay executable ownership is invalid")
                previous_hash = digest(binary)
                backup = directory / ("relay-before-upgrade-" + previous_hash + ".js")
                if backup.exists():
                    if backup.is_symlink() or digest(backup) != previous_hash:
                        raise RuntimeError("Relay backup integrity failed")
                else:
                    shutil.copy2(binary, backup)
            except (OSError, RuntimeError):
                deferred.append({"generation": generation, "reason": "bootstrap-unverified"})
                continue
            if modern:
                try:
                    request = urllib.request.Request(self.endpoint(settings) + "/quotapie-reload", method="POST")
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with opener.open(request, timeout=15) as response:
                        acknowledged = json.load(response)
                    checked = self.health(settings)
                    if (not isinstance(acknowledged, dict) or acknowledged.get("runtimeSourceHash") != descriptor["sourceHash"]
                            or checked.get("runtimeSourceHash") != descriptor["sourceHash"]):
                        raise RuntimeError("Runtime reload acknowledgement mismatch")
                    result, state = self.finish_handler_upgrade(path, settings, pending, bootstrap, checked, "reload")
                    applied.append(result)
                    listeners.append(state)
                    if not state["listenerApplied"]:
                        deferred.append({"generation": generation, "reason": state["reason"]})
                except (OSError, ValueError, RuntimeError):
                    try:
                        observed = self.health(settings).get("runtimeSourceHash")
                    except (OSError, ValueError, RuntimeError):
                        observed = None
                    pending.update(phase="reload-unverified", observedRuntimeSourceHash=observed if isinstance(observed, str) and re.fullmatch(r"[a-f0-9]{64}", observed) else None)
                    atomic_write(marker, json.dumps(pending, indent=2) + "\n")
                    deferred.append({"generation": generation, "reason": "reload-unverified",
                                     "runtime_change_observed": observed == descriptor["sourceHash"]})
                continue
            # A legacy listener cannot hand off its socket. Never infer that a
            # request gap permits a restart: its task may be executing a tool.
            # Stage startup files only; the current process keeps serving, and
            # a future natural restart loads the new runtime at this same URL.
            if pending.get("phase") == "legacy-awaiting-natural-restart":
                deferred.append({"generation": generation, "reason": "legacy-awaiting-natural-restart"})
                continue
            current = directory / "runtime-current.json"
            previous = current.read_text() if current.exists() else None
            agent = self.agent_path(settings)
            archived = directory / "retired-launch-agent.plist"
            restored_agent = False
            try:
                if not agent.exists():
                    # Retired endpoints must remain reachable after login too.
                    # Copy owned launch metadata; never bootstrap or kickstart.
                    atomic_write(agent, archived.read_text())
                    restored_agent = True
                atomic_write(current, json.dumps(descriptor, indent=2) + "\n")
                replacement = directory / "relay-upgrade-replacement.js"
                shutil.copy2(bootstrap, replacement)
                os.replace(replacement, binary)
                pending.update(phase="legacy-awaiting-natural-restart", previousBootstrapPath=str(backup), previousRuntimeDescriptor=previous)
                atomic_write(marker, json.dumps(pending, indent=2) + "\n")
                deferred.append({"generation": generation, "reason": "legacy-awaiting-natural-restart"})
            except Exception:
                # Roll back disk preparation only. Never signal the live daemon.
                replacement = directory / "relay-upgrade-rollback.js"
                shutil.copy2(backup, replacement)
                os.replace(replacement, binary)
                if previous is None:
                    current.unlink(missing_ok=True)
                else:
                    atomic_write(current, previous)
                if restored_agent:
                    agent.unlink(missing_ok=True)
                deferred.append({"generation": generation, "reason": "upgrade-staging-rolled-back"})
        result = {"applied": applied, "deferred": deferred, "listenerUpgrades": listeners, "endpoints_preserved": True}
        if args and getattr(args, "watch", False):
            result["watcher"] = self.install_upgrade_watcher()
        return result

    def repair_idle(self, args):
        # Compatibility alias: request-idle drain/restart was unsafe during tool work.
        return self.upgrade(args)

    def configure(self, args):
        changes = []
        target = Path(args.codex_home).expanduser().resolve() if getattr(args, "codex_home", None) else None
        # Match the dashboard: update every compatible live generation, including
        # endpoints retained by loaded tasks and separately registered profiles.
        for path, old, settings in self.registered_entries():
            if target is not None and Path(settings["codex_home"]).resolve() != target:
                continue
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

    def disable(self, args=None):
        if not self.settings_path.exists():
            return self.status()
        configs = {}
        entries = self.registered_entries()
        target = Path(args.codex_home).expanduser().resolve() if args and args.codex_home else None
        if target is not None:
            entries = [entry for entry in entries if Path(entry[2]["codex_home"]).resolve() == target]
            if not entries:
                raise ValueError("No registered relay for this profile")
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
        settings = entries[-1][2] if target is not None else self.settings()
        for _ in range(20):
            try:
                self.health(settings)
                break
            except (OSError, ValueError, RuntimeError):
                time.sleep(0.1)
        return {"configured": False, "restart_required": True,
                **({"codex_home": str(target)} if target is not None else {}),
                "next": ("Restart only this Codex profile. Its relay stays available for already-loaded tasks."
                         if target is not None else
                         "Quit and reopen Codex, then run quotapie-compaction stop. The relay remains available to currently loaded tasks until then.")}

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
    parser.add_argument("action", choices=["install", "ensure-profile", "status", "configure", "disable", "stop", "retire", "repair-idle", "upgrade", "apply-upgrades"])
    parser.add_argument("--watch", action="store_true", help="Enroll pending upgrade verification without restarting listeners")
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
        if args.action in ["install", "configure", "ensure-profile", "disable", "repair-idle", "upgrade", "apply-upgrades"]:
            result = getattr(relay, args.action.replace("-", "_"))(args)
        else:
            result = getattr(relay, args.action)()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
