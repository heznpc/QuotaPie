"""Relay lifecycle regressions using temporary files and mocked launchd/HTTP."""
import importlib.util
import io
import json
import hashlib
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile
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
        self.relay.health = lambda settings: {**self.healthy(settings), "runtimeSourceHash": self.source_hash}
        with patch.object(manager.subprocess, "run") as run, patch.object(manager.urllib.request, "build_opener") as opener:
            result = self.relay.apply_upgrades()
        self.assertEqual(result["applied"][0]["method"], "natural-restart")
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
