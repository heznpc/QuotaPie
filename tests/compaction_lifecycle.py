"""Relay lifecycle regressions using temporary files and mocked launchd/HTTP."""
import importlib.util
import io
import json
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
        return {"service": "quotapie-compaction", "schemaVersion": 3, "route": settings["route"]}

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
