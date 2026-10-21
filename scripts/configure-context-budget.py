#!/usr/bin/env python3
"""Bound native Codex history without changing models or rewriting conversations."""
import argparse
import datetime
import os
from pathlib import Path
import re
import tempfile
import tomllib

POLICY_START = "<!-- quotapie-agent-coordination:start -->"
POLICY_END = "<!-- quotapie-agent-coordination:end -->"
AGENT_POLICY = """- `followup_task`로 상태를 묻거나 완료를 재확인하지 않는다. 실제 추가 작업이 생겼을 때만 새 목표와 완료 기준을 지정한다. 기다릴 때는 `wait_agent`를 사용하며, 변경이나 미해결 실패가 없는 검토·테스트를 다시 시키지 않는다.
"""


def write_with_backup(path: Path, original: bytes, updated: bytes, label: str):
    """Preserve symlinks (global AGENTS.md can share another tool's rules)."""
    path = path.resolve()
    if updated == original:
        return {"changed": False}
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_name(path.name + ".before-" + label + "-" +
                            datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    with backup.open("xb") as f:
        os.chmod(backup, 0o600)
        f.write(original)
    fd, staged = tempfile.mkstemp(prefix=".context-budget-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(updated)
            f.flush()
            os.fsync(f.fileno())
        if (path.read_bytes() if path.exists() else b"") != original:
            raise RuntimeError("Codex settings changed concurrently; retry")
        os.replace(staged, path)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)
    return {"changed": True, "backup": str(backup)}


def configure_agent_policy(home: Path):
    path = home / "AGENTS.md"
    original = path.read_bytes() if path.exists() else b""
    text = original.decode()
    block = POLICY_START + "\n" + AGENT_POLICY + POLICY_END
    if POLICY_START in text or POLICY_END in text:
        if text.count(POLICY_START) != 1 or text.count(POLICY_END) != 1 or text.index(POLICY_START) > text.index(POLICY_END):
            raise ValueError("Malformed agent coordination policy; left unchanged")
        text = text[:text.index(POLICY_START)] + block + text[text.index(POLICY_END) + len(POLICY_END):]
    else:
        text += ("\n" if text.endswith("\n") else "\n\n") + block + "\n"
    return write_with_backup(path, original, text.encode(), "agent-coordination")


def target_homes(homes, profiles_root=None):
    targets = list(homes)
    if profiles_root is not None:
        # Do not recreate retired or uninitialized profiles.
        targets += [p.parent for p in profiles_root.expanduser().glob("*/home/config.toml")]
    return sorted({p.expanduser().resolve() for p in targets})


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
    return {**write_with_backup(path, original, updated, "context-budget"), **values}


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, action="append", required=True)
    parser.add_argument("--include-quotapie-profiles", action="store_true",
                        help="Also update existing managed profile homes")
    parser.add_argument("--agent-policy", action="store_true",
                        help="Install no-status-followup and no-repeat-review rules")
    args = parser.parse_args()
    profiles = Path.home() / "Library/Application Support/QuotaPie/CodexProfiles" if args.include_quotapie_profiles else None
    results = []
    for home in target_homes(args.codex_home, profiles):
        result = {"home": str(home), **configure(home)}
        if args.agent_policy:
            result["agent_policy"] = configure_agent_policy(home)
        results.append(result)
    print(json.dumps(results[0] if len(results) == 1 else results))
