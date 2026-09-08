#!/usr/bin/env python3
"""QuotaPie lifecycle bridge. Never persists hook bodies or conversation text."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

START = {'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostCompact'}
STOP = {'Stop', 'SessionEnd', 'Interrupt', 'PermissionRequest', 'StopFailure', 'QuotaPause'}
WAIT_TOOLS = {'AskUserQuestion', 'request_user_input', 'request_user_input_async'}
MAX_AGE = 1800


def owner_pid():
    pid = os.getppid()
    for _ in range(12):
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'ppid=', '-o', 'comm='],
                                capture_output=True, text=True, timeout=1)
        fields = result.stdout.strip().split(None, 1)
        if len(fields) != 2:
            return None
        parent, executable = fields
        if Path(executable).name in {'codex', 'claude', 'ChatGPT', 'Claude'}:
            return pid
        pid = int(parent)
        if pid <= 1:
            return None
    return None


def event_record(provider, profile, payload, pid, now):
    session = payload.get('session_id') or payload.get('thread_id')
    if not isinstance(session, str) or not session or len(session) > 256:
        return None
    event = payload.get('hook_event_name')
    working = event in START
    if event == 'PreToolUse' and payload.get('tool_name', '').split('__')[-1] in WAIT_TOOLS:
        working = False
    elif event not in START | STOP:
        return None
    if working and (pid is None or pid <= 1):
        return None
    key = hashlib.sha256((provider + '\0' + profile + '\0' + session).encode()).hexdigest()
    return key, {'version': 1, 'provider': provider, 'working': working,
                 'event': event, 'pid': pid or 0, 'updatedAt': now, 'expiresAt': now + MAX_AGE}


def write_event(provider, profile, payload):
    pid = owner_pid() if payload.get('hook_event_name') in START else None
    record = event_record(provider, profile, payload, pid, time.time())
    if not record:
        return
    key, value = record
    directory = Path.home() / 'Library/Application Support/QuotaPie/awake-events'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        return
    os.chmod(directory, 0o700)
    path = directory / (key + '.json')
    lock = os.open(directory / '.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists() and not path.is_symlink():
            previous = json.loads(path.read_text())
            if previous.get('updatedAt', 0) > value['updatedAt']:
                return
            if previous.get('event') in {'Stop', 'SessionEnd', 'Interrupt', 'QuotaPause', 'StopFailure'} and value['event'] in {'PostToolUse', 'PostCompact'}:
                return
        temp = directory / (key + '.' + str(uuid.uuid4()) + '.tmp')
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
        os.replace(temp, path)
    finally:
        os.close(lock)
    # Bounded retained metadata. Never inspect transcripts.
    for old in list(directory.glob('*.json'))[:2048]:
        if old.stat().st_mtime < time.time() - MAX_AGE * 2:
            old.unlink(missing_ok=True)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {'codex', 'claude'}:
        return
    raw = sys.stdin.buffer.read(2_097_153)
    if len(raw) > 2_097_152:
        return
    payload = json.loads(raw)
    if isinstance(payload, dict):
        write_event(sys.argv[1], sys.argv[2], payload)


if __name__ == '__main__':
    # Hooks must not block agent work, even if the local app is unavailable.
    try:
        main()
    except Exception:
        pass
