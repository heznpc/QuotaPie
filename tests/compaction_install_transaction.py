"""Fault-injected installer transactions; no launchd, login, or real config access."""
import importlib.util
from pathlib import Path
import tempfile
import tomllib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("relay", Path("scripts/codex-compaction-local.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


def exercise(failure):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        config, manifest = root / "config.toml", root / "current.json"
        old = relay.enabled_config('model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n', "http://127.0.0.1:1234/old")
        new = relay.enabled_config(old, "http://127.0.0.1:2345/new")
        config.write_text(old)
        manifest.write_text('{"settings_path":"old"}\n')
        previous_binary = root / "old-relay.js"
        previous_binary.write_text("old running generation")
        calls = []
        write = relay.atomic_write

        def start():
            calls.append("start-new")
            if failure == "bootstrap":
                raise RuntimeError("synthetic bootstrap failure")

        def verify():
            calls.append("verify-new")
            if failure == "health":
                raise RuntimeError("synthetic health failure")
            if failure == "concurrent-edit":
                config.write_text(old + "# concurrent user edit\n")

        def atomic(path, text, **kwargs):
            if path == manifest and failure == "manifest":
                config.write_text(config.read_text() + "# concurrent user edit\n")
                raise OSError("synthetic manifest failure")
            return write(path, text, **kwargs)

        failed = False
        with patch.object(relay, "atomic_write", atomic):
            try:
                relay.activate_generation(config, old, new, manifest, {"settings_path": "new", "retired_settings": ["old"]},
                                          start, verify, lambda: calls.append("stop-new"))
            except (RuntimeError, OSError):
                failed = True
        assert failed == bool(failure), (failure, calls)
        parsed = tomllib.loads(config.read_text())
        assert parsed["model"] == "gpt-6-astra"
        assert parsed["model_reasoning_effort"] == "xhigh"
        assert parsed["openai_base_url"] == ("http://127.0.0.1:1234/old" if failure else "http://127.0.0.1:2345/new")
        assert previous_binary.read_text() == "old running generation"
        if failure:
            assert manifest.read_text() == '{"settings_path":"old"}\n'
            assert calls[-1] == "stop-new"
        if failure in ["manifest", "concurrent-edit"]:
            assert "# concurrent user edit" in config.read_text()


for failure in [None, "bootstrap", "health", "manifest", "concurrent-edit"]:
    exercise(failure)
print("5 activation/rollback scenarios passed")
