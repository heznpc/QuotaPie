#!/usr/bin/env python3
"""Restore managed Codex endpoints without stopping apps, streams or listeners."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import time
import tomllib
import uuid

spec = importlib.util.spec_from_file_location("relay_manager", Path(__file__).with_name("codex-compaction-local.py"))
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


def restore(runtime=None, backup_root=None):
    relay = manager.LocalRelay() if runtime is None else manager.LocalRelay.__new__(manager.LocalRelay)
    if runtime is not None:
        relay.runtime = Path(runtime)
        relay.manifest_path = relay.runtime / "current.json"
        relay.manifest = json.loads(relay.manifest_path.read_text())
        relay.settings_path = Path(relay.manifest.get("settings_path", relay.runtime / "settings.json"))
    if not relay.runtime.exists() or not relay.manifest_path.exists():
        raise RuntimeError("No registered QuotaPie connection was found. No settings were changed.")
    backup = Path(backup_root or Path.home() / "Library/Application Support/QuotaPie/Backups") / ("original-connection-" + time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, mode=0o700)
    # The manager and recovery share one lock. No HTTP service is required.
    with (relay.runtime / "management.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        relay.manifest = json.loads(relay.manifest_path.read_text())
        entries = relay.registered_entries()
        endpoints = {}
        for _, _, settings in entries:
            path = Path(settings["codex_home"]).expanduser().resolve() / "config.toml"
            endpoints.setdefault(path, set()).add(relay.endpoint(settings))
        changes = []
        records = []
        for index, (path, urls) in enumerate(endpoints.items()):
            if not path.exists():
                continue
            before = path.read_text()
            configured = tomllib.loads(before).get("openai_base_url")
            if configured in urls:
                after = manager.strip_managed_config(before)
                if after == before:
                    raise RuntimeError("A relay endpoint has no verified QuotaPie block. No settings were changed.")
            elif manager.BEGIN in before or manager.END in before:
                raise RuntimeError("A managed endpoint was edited. No settings were changed.")
            else:
                after = before
            name = f"config-{index}.toml"
            target = backup / name
            target.write_text(before)
            target.chmod(0o600)
            records.append({"path": str(path), "backup": name, "changed": before != after})
            if before != after:
                changes.append((path, before, after))
        (backup / "manifest.json").write_text(json.dumps({"configs": records}, indent=2))
        applied = []
        try:
            for path, before, after in changes:
                manager.atomic_write(path, after, expected=before)
                applied.append((path, before, after))
        except Exception:
            for path, before, after in reversed(applied):
                try:
                    manager.atomic_write(path, before, expected=after)
                except Exception:
                    pass  # Never replace a concurrent user edit; originals remain in the backup.
            raise RuntimeError(f"Recovery did not complete. Original files are in {backup}")
    return {"restored": True, "changed": len(changes), "backupPath": str(backup), "restartRequired": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime")
    parser.add_argument("--backup-root")
    args = parser.parse_args()
    try:
        print(json.dumps(restore(args.runtime, args.backup_root)))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)
