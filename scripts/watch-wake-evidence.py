#!/usr/bin/env python3
"""Notify about passive wake evidence without starting an AI turn or querying APIs."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


TERMINAL = {"cycle-observed", "expired-after-seven-days", "iokit-registration-failed"}


def consume(path, state):
    """Incrementally consume complete JSONL lines; keep an unfinished tail for next run."""
    stat = path.stat()
    identity = [stat.st_dev, stat.st_ino]
    if state.get("file") != identity or stat.st_size < state.get("offset", 0):
        state.clear()
        state.update(file=identity, offset=0)
    with path.open("rb") as stream:
        stream.seek(state["offset"])
        while line := stream.readline():
            if not line.endswith(b"\n"):
                break
            state["offset"] = stream.tell()
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("kind", "")
            if kind == "observer-started":
                state["observer"] = {k: event.get(k) for k in ("pid", "atMs", "expiresAtMs")}
                state.pop("event", None)
            elif kind in TERMINAL or kind.startswith("cycle-interrupted-"):
                state["event"] = {k: event.get(k) for k in ("kind", "atMs", "cycleID")}
    return state


def alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        # A recycled PID must not make a stopped observer look healthy.
        result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "comm="],
                                capture_output=True, text=True, timeout=5)
        return result.returncode == 0 and Path(result.stdout.strip()).name == "wake-observer"
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def notice(state, now_ms, is_alive=alive):
    observer = state.get("observer", {})
    event = state.get("event")
    if event and event.get("kind") in TERMINAL:
        kind = event["kind"]
    elif observer.get("expiresAtMs") and now_ms >= observer["expiresAtMs"]:
        event = {"kind": "observer-expired", "atMs": observer.get("atMs")}
        kind = event["kind"]
    elif not is_alive(observer.get("pid")):
        event = {"kind": "observer-stopped", "atMs": observer.get("atMs")}
        kind = event["kind"]
    elif event:
        kind = event["kind"]
    else:
        return None
    key = json.dumps(event, sort_keys=True)
    if key == state.get("notified"):
        return None
    message = ("새 잠자기 복귀 증거가 수집됐습니다. QuotaPie 복귀 검증 대화에서 확인하세요."
               if kind == "cycle-observed" else
               "잠자기 복귀 관측에 확인이 필요합니다: " + kind)
    return key, message


def notify(message):
    # Pass text as argv, never interpolate event data into AppleScript source.
    subprocess.run(["/usr/bin/osascript", "-e",
                    'on run argv\ndisplay notification (item 1 of argv) with title "QuotaPie 복귀 검증"\nend run',
                    message], check=True, capture_output=True, timeout=15)


def save(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".wake-notice-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--notify", action="store_true")
    args = parser.parse_args()
    path = args.directory / "wake-notice-state.json"
    with (args.directory / "wake-notice.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(path.read_text()) if path.exists() else {}
        try:
            consume(args.directory / "events.jsonl", state)
            pending = notice(state, time.time() * 1000)
        except FileNotFoundError:
            pending = ("events-missing", "잠자기 복귀 관측 기록을 찾을 수 없습니다.")
            if state.get("notified") == pending[0]:
                pending = None
        if pending:
            if args.notify:
                notify(pending[1])
                state["notified"] = pending[0]
            print(json.dumps({"notice": pending[1], "submitted": args.notify}, ensure_ascii=False))
        save(path, state)


if __name__ == "__main__":
    main()
