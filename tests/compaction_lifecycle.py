"""Relay lifecycle regressions using temporary files and mocked launchd/HTTP."""
import importlib.util
import io
import json
import hashlib
import plistlib
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("relay", Path("scripts/codex-compaction-local.py"))
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="quotapie-lifecycle-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.relay = object.__new__(manager.LocalRelay)
        self.relay.home = self.root
        self.relay.domain = "test"
        self.relay.runtime = self.root
        self.relay.manifest_path = self.root / "current.json"
        self.paths = []
        self.settings = []
        for index in range(3):
            home = self.root / ("primary" if index != 1 else "profile")
            home.mkdir(exist_ok=True)
            directory = self.root / "releases" / str(index)
            directory.mkdir(parents=True)
            settings = {
                "port": 45000 + index, "token": str(index) * 48,
                "label": "test." + str(index), "bun": "test-bun", "codex_home": str(home),
                "route": {"from": "gpt-6-astra", "to": "gpt-5.6-sol", "effort": "low"},
                "taskSavings": {"enabled": True, "model": "gpt-5.6-luna", "effort": "low"},
                "unrelated": "preserved",
            }
            path = directory / "settings.json"
            path.write_text(json.dumps(settings))
            self.paths.append(path)
            self.settings.append(settings)
            if index < 2:
                (home / "config.toml").write_text(manager.enabled_config(
                    'model = "gpt-6-astra"\n# user setting\n', self.relay.endpoint(settings)))
        self.relay.settings_path = self.paths[0]
        self.relay.manifest = {
            "settings_path": str(self.paths[0]), "profile_settings": {"profile": str(self.paths[1])},
            "retired_settings": [str(self.paths[2])],
        }
        self.relay.agent_path = lambda settings: self.root / (settings["label"] + ".plist")
        for settings in self.settings:
            self.relay.agent_path(settings).write_text("launch agent")
        self.relay.health = self.healthy
        self.relay.wait_healthy = self.healthy
        self.arguments = SimpleNamespace(compact_model="gpt-5.6-terra", compact_effort="low")

    def healthy(self, settings):
        return {"service": "quotapie-compaction", "schemaVersion": 3, "route": settings["route"],
                "relayRuntimeRevision": 1, "reloadSupported": True,
                "nativeRequestPolicyVersion": 1, "nativeRequestPolicy": "source-origin", "sourceContinuationRevision": 3, "executionMode": "interactive",
                "subscriptionGuardVersion": 1, "subscriptionGuardRevision": 3, "subscriptionGuard": {"version": 1, "account": "fixture",
                "profileKey": hashlib.sha256(str(Path(settings["codex_home"]).resolve()).encode()).hexdigest()}}

    def add_unreadable_retired(self):
        corrupt = self.root / "corrupt.json"
        corrupt.write_text("{")
        malformed = self.root / "malformed.json"
        malformed.write_text("{}")
        self.relay.manifest["retired_settings"] += [str(self.root / "missing.json"), str(corrupt), str(malformed)]

    def disable(self):
        self.relay.disable()

    def drain(self, response):
        return patch.object(manager.urllib.request, "build_opener", return_value=SimpleNamespace(
            open=lambda *args, **kwargs: io.StringIO(json.dumps(response))))

    def legacy_thread(self, provider="quotapie_compaction"):
        self.write_owned_agents()
        home = Path(self.settings[1]["codex_home"]).resolve()
        thread_id = "11111111-1111-4111-8111-111111111111"
        sessions = home / "sessions"
        sessions.mkdir()
        rollout = sessions / "fixture.jsonl"
        rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": thread_id}}) + "\n")
        (home / "auth.json").write_text('{"fixture":"not-a-credential"}')
        with sqlite3.connect(home / "state_5.sqlite") as db:
            db.execute("CREATE TABLE threads (id TEXT,model_provider TEXT,rollout_path TEXT)")
            db.execute("INSERT INTO threads VALUES (?,?,?)", (thread_id, provider, str(rollout)))
        return SimpleNamespace(codex_home=str(home), thread_id=thread_id), home, rollout

    def test_legacy_provider_repairs_only_verified_thread_and_is_idempotent(self):
        args, home, _ = self.legacy_thread()
        config = home / "config.toml"
        before = config.read_text() + '[features]\njs_repl = false\n[model_providers.other]\nname = "user"\n'
        config.write_text(before)
        database_before = (home / "state_5.sqlite").read_bytes()
        with patch.object(manager.subprocess, "run") as run:
            self.assertEqual(self.relay.repair_legacy_provider(args), {"status": "ready", "changed": True})
            after = config.read_text()
            self.assertEqual(self.relay.repair_legacy_provider(args), {"status": "ready", "changed": False})
            run.assert_not_called()
        self.assertEqual(config.read_text(), after)
        self.assertTrue(after.startswith(before))
        parsed = tomllib.loads(after)
        self.assertNotIn("model_provider", parsed)
        self.assertFalse(parsed["features"]["js_repl"])
        self.assertEqual(parsed["model_providers"]["other"], {"name": "user"})
        self.assertEqual(parsed["model_providers"][manager.LEGACY_PROVIDER], manager.legacy_provider(self.relay.endpoint(self.settings[1])))
        backups = list(home.glob("config.toml.quotapie-legacy-provider-*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), before)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual((home / "state_5.sqlite").read_bytes(), database_before)

    def test_nonlegacy_thread_never_reads_health_or_changes_config(self):
        args, home, _ = self.legacy_thread("openai")
        before = (home / "config.toml").read_bytes()
        self.relay.health = lambda settings: self.fail("Unneeded relay access")
        self.assertEqual(self.relay.repair_legacy_provider(args), {"status": "not-needed", "changed": False})
        self.assertEqual((home / "config.toml").read_bytes(), before)
        self.assertFalse(list(home.glob("*.bak")))

    def test_legacy_provider_rejects_unmanaged_or_edited_alias_even_when_endpoint_matches(self):
        args, home, _ = self.legacy_thread()
        config = home / "config.toml"
        before = config.read_text()
        safe = manager.legacy_provider_config(before, self.relay.endpoint(self.settings[1]))
        for conflict in (safe.replace(manager.ALIAS_BEGIN, "").replace(manager.ALIAS_END, ""),
                         safe.replace('wire_api = "responses"', 'wire_api = "chat"'),
                         safe.replace(self.relay.endpoint(self.settings[1]), self.relay.endpoint(self.settings[0])),
                         safe + manager.ALIAS_BEGIN):
            with self.subTest(conflict=conflict[-40:]):
                config.write_text(conflict)
                with self.assertRaises((ValueError, RuntimeError)):
                    self.relay.repair_legacy_provider(args)
                self.assertEqual(config.read_text(), conflict)
        self.assertFalse(list(home.glob("*.bak")))

    def test_legacy_provider_rejects_wrong_rollout_identity_or_outside_profile(self):
        args, home, rollout = self.legacy_thread()
        before = (home / "config.toml").read_text()
        rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": "wrong"}}) + "\n")
        with self.assertRaisesRegex(ValueError, "identity"):
            self.relay.repair_legacy_provider(args)
        rollout.unlink()
        outside = self.root / "outside.jsonl"
        outside.write_text(json.dumps({"type": "session_meta", "payload": {"id": args.thread_id}}) + "\n")
        rollout.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "outside"):
            self.relay.repair_legacy_provider(args)
        self.assertEqual((home / "config.toml").read_text(), before)

    def test_legacy_provider_rejects_stale_guard_account_and_identity_races(self):
        args, home, _ = self.legacy_thread()
        before = (home / "config.toml").read_text()
        for mode in ("policy", "account", "credentials", "settings", "agent", "config", "thread"):
            with self.subTest(mode=mode):
                self.paths[1].write_text(json.dumps(self.settings[1]))
                self.write_owned_agents()
                (home / "config.toml").write_text(before)
                calls = 0
                def health(settings):
                    nonlocal calls
                    calls += 1
                    result = self.healthy(settings)
                    if mode == "policy": result["sourceContinuationRevision"] = 2
                    if calls == 2:
                        if mode == "account": result["subscriptionGuard"]["account"] = "different"
                        if mode == "credentials": (home / "auth.json").write_text('{"fixture":"changed"}')
                        if mode == "settings": self.paths[1].write_text(json.dumps({**settings, "changed": True}))
                        if mode == "agent": self.relay.agent_path(settings).write_text("changed")
                        if mode == "config": (home / "config.toml").write_text(before + "# concurrent edit\n")
                        if mode == "thread":
                            with sqlite3.connect(home / "state_5.sqlite") as db:
                                db.execute("UPDATE threads SET model_provider='openai'")
                    return result
                self.relay.health = health
                with self.assertRaises((RuntimeError, ValueError, plistlib.InvalidFileException)):
                    self.relay.repair_legacy_provider(args)
                self.assertNotIn(manager.ALIAS_BEGIN, (home / "config.toml").read_text())
        self.assertFalse(list(home.glob("*.bak")))

    def test_legacy_provider_preserves_concurrent_edit_during_backup(self):
        args, home, _ = self.legacy_thread()
        config = home / "config.toml"
        before = config.read_text()
        original = manager.atomic_write
        def write(path, text, **kwargs):
            original(path, text, **kwargs)
            if path.name.endswith(".bak"):
                config.write_text(before + "# user edit during backup\n")
        with patch.object(manager, "atomic_write", side_effect=write):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                self.relay.repair_legacy_provider(args)
        self.assertEqual(config.read_text(), before + "# user edit during backup\n")

    def test_atomic_config_write_rechecks_after_temporary_file_is_complete(self):
        config = Path(self.settings[1]["codex_home"]) / "config.toml"
        before = config.read_text()
        chmod = manager.os.fchmod
        for mode in ("content", "inode", "symlink"):
            with self.subTest(mode=mode):
                config.unlink()
                config.write_text(before)
                other = config.with_name("user-config.toml")
                other.write_text(before)
                def during_write(fd, permissions):
                    chmod(fd, permissions)
                    if mode == "content": config.write_text(before + "# user changed\n")
                    elif mode == "inode": manager.os.replace(other, config)
                    else:
                        config.unlink()
                        config.symlink_to(other)
                with patch.object(manager.os, "fchmod", side_effect=during_write):
                    with self.assertRaisesRegex(RuntimeError, "changed"):
                        manager.atomic_write(config, "replacement", expected=before)
                self.assertEqual(config.read_text(), before + "# user changed\n" if mode == "content" else before)
                self.assertEqual(config.is_symlink(), mode == "symlink")

    def test_waiting_manager_reexecutes_changed_source_before_any_lifecycle_action(self):
        source = self.root / "manage.py"
        source.write_text("old policy\n")
        startup_hash = manager.digest(source)
        arguments = ["repair-legacy-provider", "--codex-home", "/fixture/profile", "--thread-id", "fixture"]
        with patch.object(manager.os, "execv") as execute:
            manager.reload_changed_manager(source, startup_hash, arguments)
            execute.assert_not_called()
            source.write_text("new policy\n")
            with self.assertRaisesRegex(RuntimeError, "did not replace"):
                manager.reload_changed_manager(source, startup_hash, arguments)
            execute.assert_called_once_with(sys.executable, [sys.executable, str(source), *arguments])
        source.unlink()
        other = self.root / "unrelated.py"
        other.write_text("new policy\n")
        source.symlink_to(other)
        with patch.object(manager.os, "execv") as execute:
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                manager.reload_changed_manager(source, startup_hash, arguments)
            execute.assert_not_called()

    def test_disable_keeps_legacy_alias_and_guarded_listener_without_rerouting(self):
        args, home, _ = self.legacy_thread()
        self.relay.repair_legacy_provider(args)
        alias = tomllib.loads((home / "config.toml").read_text())["model_providers"][manager.LEGACY_PROVIDER]
        self.relay.disable()
        parsed = tomllib.loads((home / "config.toml").read_text())
        self.assertNotIn("openai_base_url", parsed)
        self.assertNotIn("model_provider", parsed)
        self.assertEqual(parsed["model_providers"][manager.LEGACY_PROVIDER], alias)
        saved = json.loads(self.paths[1].read_text())
        self.assertEqual(saved["route"]["to"], saved["route"]["from"])
        self.assertFalse(saved["taskSavings"]["enabled"])
        self.assertEqual(self.relay.repair_legacy_provider(args), {"status": "ready", "changed": False})
        with self.drain({"draining": True, "activeRequests": 0}), \
                patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            stopped = self.relay.stop()
        self.assertEqual(len(stopped["retained"]), 1)
        self.assertEqual(stopped["retained"][0]["settings_path"], str(self.paths[1]))
        self.assertEqual(run.call_count, 2)

    def test_retirement_keeps_login_persistence_for_a_historical_provider_alias(self):
        self.write_owned_agents()
        config = Path(self.settings[0]["codex_home"]) / "config.toml"
        config.write_text(manager.legacy_provider_config(config.read_text(), self.relay.endpoint(self.settings[2])))
        result = self.relay.retire()
        self.assertEqual(result["retired_after_logout"], [])
        self.assertEqual(result["retained"][0]["settings_path"], str(self.paths[2]))
        self.assertIn("Historical sessions", result["retained"][0]["reason"])
        self.assertTrue(self.relay.agent_path(self.settings[2]).exists())

    def test_configure_updates_profiles_and_retained_generations(self):
        self.add_unreadable_retired()
        with patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            self.relay.configure(self.arguments)
        self.assertEqual(run.call_count, 3)
        for path in self.paths:
            settings = json.loads(path.read_text())
            self.assertEqual(settings["route"]["to"], "gpt-5.6-terra")
            self.assertEqual(settings["unrelated"], "preserved")
            self.assertFalse(path.with_name("policy-candidate.json").exists())

    def test_configure_skips_unavailable_retired_generation(self):
        def health(settings):
            if settings["label"] == "test.2":
                raise OSError("offline")
            return self.healthy(settings)
        self.relay.health = health
        with patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            self.relay.configure(self.arguments)
        self.assertEqual([json.loads(path.read_text())["route"]["to"] for path in self.paths],
                         ["gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol"])

    def test_failed_live_acknowledgement_rolls_back_every_written_generation(self):
        before = [path.read_text() for path in self.paths]
        def verify(settings):
            if settings["label"] == "test.1":
                raise RuntimeError("reload failed")
            return self.healthy(settings)
        self.relay.wait_healthy = verify
        with patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(RuntimeError, "reload failed"):
                self.relay.configure(self.arguments)
        self.assertEqual([path.read_text() for path in self.paths], before)

    def test_failed_candidate_validation_never_writes_a_generation(self):
        before = [path.read_text() for path in self.paths]
        def validate(command, **kwargs):
            if command[-1] == str(self.paths[1].with_name("policy-candidate.json")):
                raise subprocess.CalledProcessError(1, command)
            return SimpleNamespace(returncode=0)
        with patch.object(manager.subprocess, "run", side_effect=validate):
            with self.assertRaises(subprocess.CalledProcessError):
                self.relay.configure(self.arguments)
        self.assertEqual([path.read_text() for path in self.paths], before)
        self.assertFalse(list(self.root.rglob("policy-candidate.json")))

    def test_unreadable_retired_files_do_not_block_profile_disable_or_stop(self):
        self.add_unreadable_retired()
        connected = self.relay.ensure_profile(SimpleNamespace(codex_home=self.settings[1]["codex_home"]))
        self.assertTrue(connected["relayConnected"])
        self.disable()
        for settings, path in zip(self.settings, self.paths):
            self.assertEqual((Path(settings["codex_home"]) / "config.toml").read_text(),
                             'model = "gpt-6-astra"\n# user setting\n')
            saved = json.loads(path.read_text())
            self.assertEqual(saved["route"]["to"], saved["route"]["from"])
            self.assertFalse(saved["taskSavings"]["enabled"])
        with self.drain({"draining": True, "activeRequests": 0}):
            with patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
                result = self.relay.stop()
        self.assertFalse(result["running"])
        self.assertEqual(run.call_count, 3)

    def test_current_profile_files_remain_required(self):
        self.paths[1].unlink()
        primary_before = self.paths[0].read_text()
        for operation in (self.relay.disable, self.relay.stop, lambda: self.relay.configure(self.arguments)):
            with self.assertRaises(FileNotFoundError):
                operation()
        self.assertEqual(self.paths[0].read_text(), primary_before)

    def test_unverified_health_never_unloads_a_listener(self):
        self.disable()
        for error in (OSError("timeout"), ValueError("invalid JSON"), RuntimeError("route mismatch")):
            with self.subTest(error=type(error).__name__):
                self.relay.health = lambda settings: (_ for _ in ()).throw(error)
                with patch.object(manager.subprocess, "run") as run:
                    result = self.relay.stop()
                run.assert_not_called()
                self.assertTrue(result["running"])
                self.assertEqual(len(result["retained"]), 3)
                self.assertTrue(all(self.relay.agent_path(s).exists() for s in self.settings))

    def test_only_confirmed_idle_drain_can_unload_a_listener(self):
        self.disable()
        responses = ({"draining": True, "activeRequests": 1}, {},
                     {"draining": False, "activeRequests": 0}, {"draining": True, "activeRequests": False},
                     {"draining": True, "activeRequests": -1}, {"draining": True, "activeRequests": "0"}, [])
        for response in responses:
            with self.subTest(response=response), self.drain(response):
                with patch.object(manager.subprocess, "run") as run:
                    result = self.relay.stop()
                run.assert_not_called()
                self.assertEqual(len(result["retained"]), 3)
        with patch.object(manager.urllib.request, "build_opener", side_effect=OSError("timeout")):
            with patch.object(manager.subprocess, "run") as run:
                result = self.relay.stop()
            run.assert_not_called()
            self.assertEqual(len(result["retained"]), 3)

    def test_failed_unload_preserves_the_launch_agent(self):
        self.disable()
        with self.drain({"draining": True, "activeRequests": 0}):
            with patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
                result = self.relay.stop()
        self.assertTrue(result["running"])
        self.assertEqual(len(result["retained"]), 3)
        self.assertTrue(all(self.relay.agent_path(s).exists() for s in self.settings))

    def write_owned_agents(self):
        for path, settings in zip(self.paths, self.settings):
            self.relay.agent_path(settings).write_bytes(plistlib.dumps({
                "Label": settings["label"], "KeepAlive": True, "RunAtLoad": True,
                "ProgramArguments": [settings["bun"], str(path.parent / "relay.js"), str(path)]}))

    def test_owned_agent_rejects_absent_or_invalid_runtime_identity(self):
        self.write_owned_agents()
        for value in (None, "", "  ", 123, []):
            with self.subTest(bun=value):
                settings = {**self.settings[0], "bun": value}
                with self.assertRaisesRegex(RuntimeError, "ownership"):
                    self.relay.owned_agent(self.paths[0], settings)
        settings = dict(self.settings[0])
        settings.pop("bun")
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            self.relay.owned_agent(self.paths[0], settings)

    def test_upgrade_skips_legacy_without_bun_and_stages_other_generations(self):
        self.write_owned_agents()
        legacy = dict(self.settings[0])
        legacy.pop("bun")
        self.paths[0].write_text(json.dumps(legacy))
        before = [path.read_bytes() for path in self.paths]
        args = SimpleNamespace(source=str(self.root), codex_home=None, watch=True)
        with patch.object(self.relay, "stage_runtime") as stage, \
                patch.object(self.relay, "install_upgrade_watcher", return_value={"installed": True}) as watcher, \
                patch.object(manager.subprocess, "run") as run, \
                patch.object(manager.urllib.request, "build_opener") as opener:
            result = self.relay.upgrade(args)
        self.assertEqual(result["staged"], ["1", "2"])
        self.assertEqual(result["deferred"], [{"generation": "0", "reason": "ownership-unverified"}])
        self.assertEqual([call.args[0] for call in stage.call_args_list], self.paths[1:])
        self.assertEqual([path.read_bytes() for path in self.paths], before)
        watcher.assert_called_once_with()
        run.assert_not_called()
        opener.assert_not_called()

    def prepare_upgrade(self, modern=False):
        self.write_owned_agents()
        for path in self.paths:
            (path.parent / "relay.js").write_bytes(b"original relay\n")
        self.relay.health = lambda settings: {**self.healthy(settings), "relayRuntimeRevision": 1 if modern else 0,
            "reloadSupported": modern, "activeRequests": 0}
        self.upgrade_args = SimpleNamespace(source=str(self.root), codex_home=self.settings[1]["codex_home"], watch=False)
        self.binary = self.paths[1].parent / "relay.js"
        self.candidate = self.paths[1].parent / "relay-runtime-candidate.js"
        self.pending = self.paths[1].parent / "pending-upgrade.json"
        self.source_hash = hashlib.sha256(b"candidate runtime\n").hexdigest()

    def upgrade_command(self, command, **kwargs):
        if command[:2] == ["test-bun", "build"]:
            content = b"candidate runtime\n" if command[2].endswith("codex-relay-runtime.ts") else b"candidate bootstrap\n"
            Path(command[command.index("--outfile") + 1]).write_bytes(content)
        else:
            self.assertEqual(command, ["test-bun", str(self.candidate), "--check-policy", str(self.paths[1])])
        self.assertTrue(kwargs["check"])
        return SimpleNamespace(returncode=0)

    def stage(self):
        with patch.object(manager.subprocess, "run", side_effect=self.upgrade_command):
            return self.relay.upgrade(self.upgrade_args)

    def test_legacy_upgrade_never_signals_listener_even_when_request_and_host_counts_are_zero(self):
        self.prepare_upgrade()
        before_settings = [path.read_bytes() for path in self.paths]
        before_configs = {Path(s["codex_home"]) / "config.toml": (Path(s["codex_home"]) / "config.toml").read_bytes() for s in self.settings}
        with patch.object(manager.subprocess, "run", side_effect=self.upgrade_command) as run, patch.object(manager.urllib.request, "build_opener") as opener:
            result = self.relay.repair_idle(self.upgrade_args)
        self.assertEqual(result["applied"], [])
        self.assertEqual(result["deferred"], [{"generation": "1", "reason": "legacy-awaiting-natural-restart"}])
        self.assertEqual(result["staged"], ["1"])
        self.assertTrue(result["endpoints_preserved"])
        self.assertEqual(json.loads(self.pending.read_text())["phase"], "legacy-awaiting-natural-restart")
        self.assertEqual(self.binary.read_bytes(), b"candidate bootstrap\n")
        self.assertTrue(any(p.read_bytes() == b"original relay\n" for p in self.binary.parent.glob("relay-before-upgrade-*.js")))
        self.assertEqual([path.read_bytes() for path in self.paths], before_settings)
        self.assertTrue(all(path.read_bytes() == data for path, data in before_configs.items()))
        self.assertFalse(any(call.args[0][0] in ("launchctl", "/bin/ps") for call in run.call_args_list))
        opener.assert_not_called()

    def test_legacy_active_requests_or_unknown_health_only_stage_next_start(self):
        for active in (7, True, None):
            self.prepare_upgrade()
            self.relay.health = lambda settings: {"activeRequests": active}
            with patch.object(manager.subprocess, "run", side_effect=self.upgrade_command) as run, patch.object(manager.urllib.request, "build_opener") as opener:
                result = self.relay.upgrade(self.upgrade_args)
            self.assertEqual(result["deferred"][0]["reason"], "legacy-awaiting-natural-restart")
            self.assertFalse(any(call.args[0][0] == "launchctl" for call in run.call_args_list))
            opener.assert_not_called()

    def test_pending_becomes_applied_only_after_natural_restart_reports_expected_runtime(self):
        self.prepare_upgrade()
        self.stage()
        with patch.object(manager.subprocess, "run") as run:
            waiting = self.relay.apply_upgrades()
        run.assert_not_called()
        self.assertEqual(waiting["applied"], [])
        self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash, "listenerPolicyVersion": 2}
        with patch.object(manager.subprocess, "run") as run, patch.object(manager.urllib.request, "build_opener") as opener:
            result = self.relay.apply_upgrades()
        self.assertEqual(result["applied"][0]["method"], "natural-restart")
        self.assertTrue(result["applied"][0]["listenerApplied"])
        self.assertFalse((self.binary.parent / "listener-upgrade-pending.json").exists())
        self.assertFalse(self.pending.exists())
        run.assert_not_called()
        opener.assert_not_called()

    def test_archived_owned_launch_job_is_restored_for_next_login_without_starting_it(self):
        self.prepare_upgrade()
        agent = self.relay.agent_path(self.settings[1])
        before = agent.read_bytes()
        agent.rename(self.paths[1].parent / "retired-launch-agent.plist")
        result = self.stage()
        self.assertEqual(agent.read_bytes(), before)
        self.assertEqual(result["deferred"][0]["reason"], "legacy-awaiting-natural-restart")

    def test_modern_reload_preserves_active_requests_without_process_restart(self):
        self.prepare_upgrade(modern=True)
        current = {"hash": "old"}
        self.relay.health = lambda settings: {**self.healthy(settings), "activeRequests": 7, "runtimeSourceHash": current["hash"]}
        requests = []
        def response(request, **kwargs):
            requests.append(request)
            current["hash"] = self.source_hash
            return io.StringIO(json.dumps({"runtimeSourceHash": self.source_hash}))
        with patch.object(manager.subprocess, "run", side_effect=self.upgrade_command) as run, patch.object(manager.urllib.request, "build_opener", return_value=SimpleNamespace(open=response)):
            result = self.relay.upgrade(self.upgrade_args)
        self.assertEqual(result["applied"][0]["method"], "reload")
        self.assertEqual([r.full_url.rsplit("/", 1)[-1] for r in requests], ["quotapie-reload"])
        self.assertFalse(any(call.args[0][0] == "launchctl" for call in run.call_args_list))
        self.assertFalse(self.pending.exists())
        self.assertEqual(result["applied"][0]["handlerApplied"], True)
        self.assertEqual(result["applied"][0]["listenerApplied"], False)
        self.assertEqual(result["deferred"], [{"generation": "1", "reason": "listener-awaiting-natural-restart"}])
        self.assertTrue((self.binary.parent / "listener-upgrade-pending.json").exists())

    def prepare_listener_pending(self):
        self.prepare_upgrade(modern=True)
        self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash,
            "pid": 123, "activeRequests": 0}
        result = self.stage()
        self.listener_marker = self.binary.parent / "listener-upgrade-pending.json"
        self.assertTrue(self.listener_marker.exists())
        self.assertFalse(self.pending.exists())
        return result

    def test_matching_handler_hash_and_idle_connections_do_not_complete_listener_upgrade(self):
        result = self.prepare_listener_pending()
        self.assertEqual(result["applied"][0]["method"], "verified-reload")
        self.assertFalse(result["applied"][0]["listenerApplied"])
        original = self.listener_marker.read_bytes()
        self.assertNotIn(self.settings[1]["token"].encode(), original)
        with patch.object(manager.subprocess, "run") as run, patch.object(manager.urllib.request, "build_opener") as opener:
            for _ in range(2):
                observed = self.relay.apply_upgrades()
                self.assertEqual(observed["applied"], [])
                self.assertEqual(observed["listenerUpgrades"][0]["reason"], "listener-awaiting-natural-restart")
                status = self.relay.status()
                self.assertFalse(status["listenerUpgrades"][0]["listenerApplied"])
        run.assert_not_called()
        opener.assert_not_called()
        self.assertEqual(self.listener_marker.read_bytes(), original)

    def test_status_completes_listener_only_after_version_hash_and_profile_are_verified(self):
        self.prepare_listener_pending()
        original = self.listener_marker.read_bytes()
        for change in ({"listenerPolicyVersion": 1}, {"listenerPolicyVersion": 2, "runtimeSourceHash": "b" * 64},
                       {"listenerPolicyVersion": 2, "subscriptionGuard": {"profileKey": "wrong", "account": "fixture"}},
                       {"listenerPolicyVersion": 2, "subscriptionGuard": {**self.healthy(self.settings[1])["subscriptionGuard"], "account": "other"}},
                       {"listenerPolicyVersion": 2, "subscriptionGuard": {**self.healthy(self.settings[1])["subscriptionGuard"], "reason": "account-identity-changed"}}):
            with self.subTest(change=change):
                self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash, **change}
                status = self.relay.status()
                self.assertFalse(status["listenerUpgrades"][0]["listenerApplied"])
                self.assertEqual(self.listener_marker.read_bytes(), original)
        self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash,
            "listenerPolicyVersion": 2, "pid": 456}
        with patch.object(manager.subprocess, "run") as run:
            status = self.relay.status()
        run.assert_not_called()
        self.assertEqual(status["listenerUpgrades"][0]["reason"], "listener-verified")
        self.assertTrue(status["listenerUpgrades"][0]["listenerApplied"])
        self.assertFalse(self.listener_marker.exists())

    def test_listener_pending_survives_offline_or_changed_settings_launch_job_and_files(self):
        self.prepare_listener_pending()
        original = self.listener_marker.read_bytes()
        self.relay.health = lambda settings: (_ for _ in ()).throw(OSError("offline"))
        self.assertEqual(self.relay.apply_upgrades()["deferred"][0]["reason"], "listener-state-unverified")
        self.assertEqual(self.listener_marker.read_bytes(), original)
        self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash, "listenerPolicyVersion": 2}
        runtime = self.binary.parent / ("relay-runtime-" + self.source_hash + ".js")
        for path, replacement in ((self.paths[1], json.dumps({**self.settings[1], "unrelated": "changed"}).encode()),
                                  (self.relay.agent_path(self.settings[1]), b"changed launch job"),
                                  (self.binary, b"changed bootstrap"), (runtime, b"changed runtime")):
            saved = path.read_bytes()
            try:
                path.write_bytes(replacement)
                state = self.relay.apply_upgrades()["listenerUpgrades"][0]
                self.assertEqual(state["reason"], "listener-state-unverified")
                self.assertFalse(state["listenerApplied"])
                self.assertEqual(self.listener_marker.read_bytes(), original)
            finally:
                path.write_bytes(saved)

    def test_listener_health_race_cannot_erase_changed_binding_or_marker(self):
        self.prepare_listener_pending()
        original = self.listener_marker.read_bytes()
        agent = self.relay.agent_path(self.settings[1])
        before = agent.read_bytes()
        for changed in (agent, self.listener_marker):
            def health(settings):
                changed.write_bytes(b"changed during health")
                return {**self.healthy(settings), "runtimeSourceHash": self.source_hash, "listenerPolicyVersion": 2}
            self.relay.health = health
            state = self.relay.listener_upgrade_status(self.paths[1], self.settings[1])
            self.assertEqual(state["reason"], "listener-state-unverified")
            self.assertFalse(state["listenerApplied"])
            self.assertTrue(self.listener_marker.exists())
            if changed == agent:
                self.assertEqual(self.listener_marker.read_bytes(), original)
                agent.write_bytes(before)
            else:
                self.assertEqual(self.listener_marker.read_bytes(), b"changed during health")

    def test_interrupted_listener_disk_staging_retains_candidate_and_can_be_retried(self):
        self.prepare_upgrade(modern=True)
        self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash}
        copy = manager.shutil.copy2
        def fail(source, destination):
            if source == self.candidate:
                raise OSError("synthetic disk failure")
            return copy(source, destination)
        with patch.object(manager.shutil, "copy2", side_effect=fail):
            result = self.stage()
        self.assertEqual(result["applied"], [])
        self.assertTrue(self.pending.exists())
        self.assertTrue(self.candidate.exists())
        self.assertEqual(self.binary.read_bytes(), b"original relay\n")
        with patch.object(manager.subprocess, "run") as run:
            result = self.relay.apply_upgrades()
        run.assert_not_called()
        self.assertTrue(result["applied"][0]["handlerApplied"])
        self.assertFalse(result["applied"][0]["listenerApplied"])
        self.assertEqual(self.binary.read_bytes(), b"candidate bootstrap\n")
        self.assertFalse(self.pending.exists())

    def test_new_handler_target_can_advance_while_same_listener_remains_pending(self):
        self.prepare_listener_pending()
        before = json.loads(self.listener_marker.read_text())
        self.source_hash = hashlib.sha256(b"newer runtime\n").hexdigest()
        def command(args, **kwargs):
            if args[:2] == ["test-bun", "build"]:
                Path(args[args.index("--outfile") + 1]).write_bytes(
                    b"newer runtime\n" if args[2].endswith("codex-relay-runtime.ts") else b"newer bootstrap\n")
            else:
                self.assertIn("--check-policy", args)
            return SimpleNamespace(returncode=0)
        with patch.object(manager.subprocess, "run", side_effect=command), patch.object(manager.urllib.request, "build_opener") as opener:
            result = self.relay.upgrade(self.upgrade_args)
        opener.assert_not_called()
        self.assertTrue(result["applied"][0]["handlerApplied"])
        self.assertFalse(result["applied"][0]["listenerApplied"])
        after = json.loads(self.listener_marker.read_text())
        self.assertNotEqual(after["sourceHash"], before["sourceHash"])
        self.assertEqual(after["sourceHash"], self.source_hash)
        for key in ("account", "profileKey", "launchAgentHash", "settingsHash"):
            self.assertEqual(after[key], before[key])

    def test_corrupt_listener_marker_is_not_replaced_by_a_repeated_upgrade(self):
        self.prepare_listener_pending()
        self.listener_marker.write_text("[]")
        result = self.stage()
        self.assertEqual(result["applied"], [])
        self.assertEqual(result["deferred"][0]["reason"], "listener-state-unverified")
        self.assertEqual(self.listener_marker.read_text(), "[]")
        self.assertTrue(self.pending.exists())

    def test_failed_reload_acknowledgement_records_uncertainty_without_live_rollback(self):
        self.prepare_upgrade(modern=True)
        with patch.object(manager.subprocess, "run", side_effect=self.upgrade_command), self.drain({"runtimeSourceHash": "wrong"}):
            result = self.relay.upgrade(self.upgrade_args)
        self.assertEqual(result["deferred"][0]["reason"], "reload-unverified")
        self.assertEqual(self.binary.read_bytes(), b"original relay\n")
        self.assertEqual(json.loads(self.pending.read_text())["phase"], "reload-unverified")

    def test_candidate_validation_failure_never_contacts_or_restarts_running_relay(self):
        self.prepare_upgrade()
        def command(arguments, **kwargs):
            if "--check-policy" in arguments:
                raise subprocess.CalledProcessError(1, arguments)
            return self.upgrade_command(arguments, **kwargs)
        with patch.object(manager.subprocess, "run", side_effect=command) as run, patch.object(manager.urllib.request, "build_opener") as opener:
            with self.assertRaises(subprocess.CalledProcessError):
                self.relay.upgrade(self.upgrade_args)
        opener.assert_not_called()
        self.assertFalse(any(call.args[0][0] == "launchctl" for call in run.call_args_list))
        self.assertEqual(self.binary.read_bytes(), b"original relay\n")
        self.assertFalse(self.pending.exists())

    def test_changed_candidate_defers_without_execution(self):
        self.prepare_upgrade()
        self.stage()
        self.candidate.write_bytes(b"changed")
        with patch.object(manager.subprocess, "run") as run:
            result = self.relay.apply_upgrades()
        run.assert_not_called()
        self.assertEqual(result["deferred"][0]["reason"], "upgrade-state-unverified")

    def test_failed_disk_staging_restores_binary_and_descriptor_without_restart(self):
        self.prepare_upgrade()
        original_descriptor = '{"old":true}\n'
        (self.paths[1].parent / "runtime-current.json").write_text(original_descriptor)
        atomic = manager.atomic_write
        def fail(path, text, **kwargs):
            if path == self.pending and "legacy-awaiting-natural-restart" in text:
                raise OSError("synthetic disk failure")
            return atomic(path, text, **kwargs)
        with patch.object(manager, "atomic_write", side_effect=fail), patch.object(manager.subprocess, "run", side_effect=self.upgrade_command) as run:
            result = self.relay.upgrade(self.upgrade_args)
        self.assertEqual(result["deferred"][0]["reason"], "upgrade-staging-rolled-back")
        self.assertFalse(any(call.args[0][0] == "launchctl" for call in run.call_args_list))
        self.assertEqual(self.binary.read_bytes(), b"original relay\n")
        self.assertEqual((self.paths[1].parent / "runtime-current.json").read_text(), original_descriptor)
        self.assertTrue(self.pending.exists())

    def test_install_reuses_registered_profile_endpoint_instead_of_rotating_port(self):
        self.prepare_upgrade()
        args = SimpleNamespace(source=str(self.root), bun="test-bun", codex_home=self.settings[1]["codex_home"], watch=False)
        before = (Path(args.codex_home) / "config.toml").read_bytes()
        with patch.object(manager.sys, "platform", "darwin"), patch.object(self.relay, "install_manager"), patch.object(manager.subprocess, "run", side_effect=self.upgrade_command), patch.object(manager.socket, "socket") as socket:
            result = self.relay.install(args)
        socket.assert_not_called()
        self.assertTrue(result["pending"])
        self.assertTrue(result["endpoints_preserved"])
        self.assertEqual((Path(args.codex_home) / "config.toml").read_bytes(), before)

    def test_install_explicit_model_updates_only_its_profile_without_rotating_endpoint(self):
        self.prepare_upgrade()
        args = SimpleNamespace(source=str(self.root), bun="test-bun", codex_home=self.settings[1]["codex_home"],
                               watch=False, compact_model="gpt-5.6-terra", compact_effort="low")
        before_configs = [(Path(s["codex_home"]) / "config.toml").read_bytes() for s in self.settings]
        def command(arguments, **kwargs):
            if arguments[-1].endswith("policy-candidate.json"):
                return SimpleNamespace(returncode=0)
            return self.upgrade_command(arguments, **kwargs)
        with patch.object(manager.sys, "platform", "darwin"), patch.object(self.relay, "install_manager"), patch.object(manager.subprocess, "run", side_effect=command), patch.object(manager.socket, "socket") as socket:
            result = self.relay.install(args)
        socket.assert_not_called()
        self.assertEqual(json.loads(self.paths[1].read_text())["route"]["to"], "gpt-5.6-terra")
        self.assertEqual([json.loads(p.read_text())["route"]["to"] for p in (self.paths[0], self.paths[2])], ["gpt-5.6-sol", "gpt-5.6-sol"])
        self.assertEqual([(Path(s["codex_home"]) / "config.toml").read_bytes() for s in self.settings], before_configs)
        self.assertTrue(result["endpoints_preserved"])

    def test_upgrade_stages_every_registered_generation_without_cross_profile_changes(self):
        self.prepare_upgrade()
        self.upgrade_args.codex_home = None
        before = [p.read_bytes() for p in self.paths]
        def command(args, **kwargs):
            if args[1] == "build":
                Path(args[args.index("--outfile") + 1]).write_bytes(b"runtime fixture")
            else:
                self.assertIn("--check-policy", args)
            return SimpleNamespace(returncode=0)
        with patch.object(manager.subprocess, "run", side_effect=command):
            result = self.relay.upgrade(self.upgrade_args)
        self.assertEqual(result["staged"], ["0", "1", "2"])
        self.assertEqual(len(result["deferred"]), 3)
        self.assertEqual([p.read_bytes() for p in self.paths], before)
        self.assertTrue(all((p.parent / "pending-upgrade.json").exists() for p in self.paths))

    def test_watcher_enrollment_is_explicit_and_verifies_existing_owner(self):
        self.prepare_upgrade()
        self.stage()
        with patch.object(self.relay, "install_upgrade_watcher") as watcher:
            self.relay.apply_upgrades()
        watcher.assert_not_called()
        manager_path = self.root / "manage.py"
        with patch.object(self.relay, "install_manager", return_value=manager_path), patch.object(manager.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            self.relay.install_upgrade_watcher()
        agent = self.root / "Library/LaunchAgents" / (manager.UPGRADE_LABEL + ".plist")
        job = plistlib.loads(agent.read_bytes())
        self.assertEqual(job["ProgramArguments"][-1], "apply-upgrades")
        self.assertEqual(job["StartInterval"], 30)
        self.assertEqual(run.call_args.args[0][:2], ["launchctl", "print"])
        job["ProgramArguments"] = ["unrelated"]
        agent.write_bytes(plistlib.dumps(job))
        with patch.object(self.relay, "install_manager", return_value=manager_path), patch.object(manager.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                self.relay.install_upgrade_watcher()
        run.assert_not_called()

    def test_retirement_archives_login_job_without_draining_loaded_sessions(self):
        self.write_owned_agents()
        before = self.relay.agent_path(self.settings[2]).read_bytes()
        self.relay.health = lambda settings: {**self.healthy(settings), "activeRequests": 7}
        with patch.object(manager.subprocess, "run") as run:
            result = self.relay.retire()
        run.assert_not_called()
        self.assertEqual(result["retired_after_logout"], [str(self.paths[2])])
        self.assertTrue(result["loaded_listeners_untouched"])
        self.assertEqual((self.paths[2].parent / "retired-launch-agent.plist").read_bytes(), before)
        self.assertFalse(self.relay.agent_path(self.settings[2]).exists())
        self.assertTrue(all(self.relay.agent_path(s).exists() for s in self.settings[:2]))
        self.assertEqual(self.relay.retire()["retired_after_logout"], [])

    def test_retirement_requires_healthy_current_replacement_and_owned_job(self):
        self.write_owned_agents()
        self.relay.health = lambda settings: (_ for _ in ()).throw(OSError("offline"))
        self.assertEqual(len(self.relay.retire()["retained"]), 1)
        self.relay.health = self.healthy
        (Path(self.settings[0]["codex_home"]) / "config.toml").write_text(
            manager.enabled_config("", self.relay.endpoint(self.settings[2])))
        self.assertEqual(len(self.relay.retire()["retained"]), 1)
        (Path(self.settings[0]["codex_home"]) / "config.toml").write_text(
            manager.enabled_config("", self.relay.endpoint(self.settings[0])))
        self.relay.agent_path(self.settings[2]).write_bytes(plistlib.dumps({
            "Label": self.settings[2]["label"], "ProgramArguments": ["bun", "/unrelated", str(self.paths[2])]}))
        self.assertEqual(len(self.relay.retire()["retained"]), 1)
        self.assertTrue(self.relay.agent_path(self.settings[2]).exists())


if __name__ == "__main__":
    unittest.main(testRunner=unittest.TextTestRunner(stream=sys.stdout))
