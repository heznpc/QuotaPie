#!/usr/bin/env python3
"""Bound native Codex history without changing models or rewriting conversations."""
import argparse
import datetime
import os
from pathlib import Path
import re
import tempfile
import tomllib


def configure(home: Path, compact: int = 96000, output: int = 2000):
    if not 64000 <= compact <= 200000 or not 1000 <= output <= 8000:
        raise ValueError("Context limits outside supported range")
    path = home / "config.toml"
    original = path.read_bytes() if path.exists() else b""
    before = tomllib.loads(original.decode())
    values = {"model_auto_compact_token_limit": compact,
              "model_auto_compact_token_limit_scope": "total",
              "tool_output_token_limit": output}
    text = original.decode()
    boundary = re.search(r"(?m)^\s*\[", text)
    head, tail = (text[:boundary.start()], text[boundary.start():]) if boundary else (text, "")
    for key, value in values.items():
        line = f'{key} = "{value}"' if isinstance(value, str) else f"{key} = {value}"
        pattern = rf"(?m)^{key}\s*=.*$"
        head = re.sub(pattern, line, head) if re.search(pattern, head) else line + "\n" + head
    updated = (head + tail).encode()
    after = tomllib.loads(updated.decode())
    assert after == {**before, **values}, "Unrelated configuration changed"
    if updated == original:
        return {"changed": False, **values}
    home.mkdir(parents=True, exist_ok=True)
    backup = home / ("config.toml.before-context-budget-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    with backup.open("xb") as f:
        os.chmod(backup, 0o600)
        f.write(original)
    fd, staged = tempfile.mkstemp(prefix=".context-budget-", dir=home)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(updated)
            f.flush()
            os.fsync(f.fileno())
        # Do not overwrite a concurrent preferences update.
        if (path.read_bytes() if path.exists() else b"") != original:
            raise RuntimeError("Codex settings changed concurrently; retry")
        os.replace(staged, path)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    return {"changed": True, "backup": str(backup), **values}


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(configure(args.codex_home.expanduser())))
