#!/usr/bin/env python3
"""Copy idle local Codex stores into one owner, without changing thread IDs.

No inference, process termination, credential copying, or source-store writes.
The source must be fenced by the caller against new launches during apply.
"""
import contextlib
from contextvars import ContextVar
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time

VERSION = 1
RECEIPT_TABLE = "quotapie_session_consolidations"
MAX_THREADS = 20000
MAX_FILE_BYTES = 2 * 1024**3
MAX_TOTAL_BYTES = 32 * 1024**3
DATABASES = ("state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite", "queue_1.sqlite", "memories_1.sqlite")
COPY_TABLES = {
    "state_5.sqlite": ("projects", "project_roots", "project_idempotency_keys", "thread_sections", "threads",
                       "thread_dynamic_tools", "thread_attachments", "thread_read_receipts", "thread_spawn_edges", "guardian_review_feedback"),
    "thread_history_1.sqlite": ("thread_history_projection_state", "thread_turns", "thread_items", "thread_realtime_items"),
    "goals_1.sqlite": ("thread_goals", "thread_goal_continuation_deferrals"),
    "queue_1.sqlite": ("queued_items", "queued_thread_revisions"),
    "memories_1.sqlite": ("stage1_outputs",),
}
SKIP_TABLES = {
    "state_5.sqlite": {"backfill_state", "external_agent_config_imports", "remote_control_enrollments",
                       "rollout_migration_skipped_rollouts", "rollout_migration_state", RECEIPT_TABLE},
    "thread_history_1.sqlite": set(), "goals_1.sqlite": set(), "queue_1.sqlite": set(),
    "memories_1.sqlite": {"jobs", "consolidation_progress"},
}
SOURCE_READS = ContextVar("quotapie_consolidation_source_reads", default=None)


class Refuse(Exception):
    def __init__(self, reason, waiting=False):
        self.reason, self.waiting = reason, waiting
        super().__init__(reason)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def canonical(raw, exists=True):
    if not isinstance(raw, str) or not raw.startswith("/") or len(raw) > 4096:
        raise Refuse("invalid-path")
    path = Path(raw)
    if path != path.resolve(strict=exists):
        raise Refuse("symlink-path")
    return path


def below(path, root):
    return path != root and root in path.parents


def safe_file(path, allow_missing=False):
    canonical(str(path), exists=not allow_missing)
    try:
        info = path.lstat()
    except FileNotFoundError:
        if allow_missing:
            return None
        raise Refuse("file-missing")
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise Refuse("unsafe-file")
    return info


def mkdir(path):
    canonical(str(path), exists=False)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    canonical(str(path))
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise Refuse("unsafe-directory")


def atomic_json(path, value, limit=None):
    data = encode(value)
    if limit and len(data) > limit:
        raise Refuse("report-too-large")
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise


def load_json(path):
    safe_file(path)
    if path.stat().st_size > 64 * 1024 * 1024:
        raise Refuse("journal-too-large")
    return json.loads(path.read_bytes())


def connect(path, readonly=True):
    reads = SOURCE_READS.get()
    if readonly and reads is not None and path.parent == reads.source and path.name in DATABASES:
        return reads.open(path)
    return connect_store(path, readonly)


def connect_store(path, readonly=True):
    safe_file(path)
    for suffix in ("-wal", "-shm"):
        safe_file(Path(str(path) + suffix), allow_missing=True)
    connection = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"), uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    if readonly:
        connection.execute("PRAGMA query_only=ON")
    else:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=FULL")
    return connection


def connect_snapshot(path):
    """Read only QuotaPie's private, standalone SQLite backup files.

    Older backups retained SQLite's WAL header without sidecars. Some system
    SQLite versions cannot reopen those with mode=ro. The backup API copied all
    committed pages, so an immutable reader is valid here, never for live stores.
    """
    if path.parent.name not in ("source-backup", "primary-before", "cold-source-read"):
        raise Refuse("snapshot-location-unverified")
    safe_file(path)
    for suffix in ("-wal", "-shm", "-journal"):
        if safe_file(Path(str(path) + suffix), allow_missing=True) is not None: raise Refuse("snapshot-sidecar-present")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def tables(db):
    return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def columns(db, table):
    if not re.fullmatch(r"[a-z_0-9]+", table):
        raise Refuse("unsafe-table")
    return list(db.execute('PRAGMA table_info("' + table + '")'))


def value_for_hash(value):
    return {"blob": value.hex()} if isinstance(value, bytes) else value


def row_hash(row):
    value = encode({key: value_for_hash(value) for key, value in dict(row).items()})
    if len(value) > 32 * 1024**2: raise Refuse("row-too-large")
    return hashlib.sha256(value).hexdigest()


def table_summary(db, table):
    cols = columns(db, table)
    order = [c[1] for c in sorted(cols, key=lambda c: c[5]) if c[5]] or [c[1] for c in cols]
    h, count = hashlib.sha256(), 0
    for row in db.execute('SELECT * FROM "' + table + '" ORDER BY ' + ','.join('"' + c + '"' for c in order)):
        h.update(row_hash(row).encode()); count += 1
        if count > 2000000: raise Refuse("table-too-large")
    return {"rows": count, "sha256": h.hexdigest()}


def validate_schema(source, target, name):
    st, tt = tables(source), tables(target)
    known = set(COPY_TABLES[name]) | SKIP_TABLES[name] | {"_sqlx_migrations"}
    for table in st - known:
        if source.execute('SELECT 1 FROM "' + table.replace('"', '""') + '" LIMIT 1').fetchone():
            raise Refuse("unknown-nonempty-table")
    for table in st & set(COPY_TABLES[name]):
        if table not in tt or [tuple(x)[1:] for x in columns(source, table)] != [tuple(x)[1:] for x in columns(target, table)]:
            raise Refuse("schema-mismatch")
    if "_sqlx_migrations" in st and "_sqlx_migrations" in tt:
        for a, b in zip(source.execute("SELECT version,checksum,success FROM _sqlx_migrations ORDER BY version"),
                        target.execute("SELECT version,checksum,success FROM _sqlx_migrations ORDER BY version")):
            if tuple(a) != tuple(b):
                raise Refuse("migration-version-mismatch")
        if source.execute("SELECT count(*) FROM _sqlx_migrations").fetchone()[0] != target.execute("SELECT count(*) FROM _sqlx_migrations").fetchone()[0]:
            raise Refuse("migration-version-mismatch")
    triggers = "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
    if [tuple(r) for r in source.execute(triggers)] != [tuple(r) for r in target.execute(triggers)]:
        raise Refuse("trigger-schema-mismatch")


def request_paths(request):
    if not isinstance(request, dict) or set(request) != {"version", "source", "primary", "journalDirectory"} or request["version"] != VERSION:
        raise Refuse("invalid-request")
    for key in ("source", "primary"):
        if not isinstance(request[key], dict) or set(request[key]) != {"codexHome", "appData"}:
            raise Refuse("invalid-request")
        for value in request[key].values():
            if not canonical(value).is_dir():
                raise Refuse("directory-missing")
    source, primary = (Path(request[k]["codexHome"]) for k in ("source", "primary"))
    for left in request["source"].values():
        for right in request["primary"].values():
            a, b = Path(left), Path(right)
            if a == b or below(a, b) or below(b, a): raise Refuse("overlapping-profiles")
    journal = canonical(request["journalDirectory"], exists=False)
    if journal in (source, primary) or below(journal, source) or below(journal, primary):
        raise Refuse("unsafe-journal-location")
    return source, primary, journal / digest({"source": request["source"], "primary": request["primary"]})[:32]


def source_absent(request):
    """Read native process identities and open write descriptors; never kill."""
    if sys.platform != "darwin":
        raise Refuse("source-owner-unverified", True)
    spec = importlib.util.spec_from_file_location("qp_host_wake", Path(__file__).with_name("codex-host-wake.py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    io = module.NativeIO()
    try:
        executable = io.vendor_executable()
        candidates = [(executable, "source-host-running")]
        bundle = Path(executable).parents[2]
        for suffix in ("Contents/Resources/codex-cli/bin/codex", "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "Contents/Resources/codex"):
            candidate = bundle / suffix
            if candidate.exists(): candidates.append((str(candidate.resolve()), "source-client-running"))
        def quick_process_check():
            for executable, reason in candidates:
                for process in io.processes(executable):
                    root, data = module.process_identity(process["args"], io.home)
                    if root == request["source"]["codexHome"] or data == request["source"]["appData"]:
                        raise Refuse(reason, True)
        quick_process_check()
        result = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-u", str(os.getuid()), "-F", "pafn"],
                                capture_output=True, timeout=12)
        if result.returncode != 0 or len(result.stdout) > 32 * 1024**2:
            raise Refuse("source-writer-unverified", True)
        access, pid = None, None
        root = request["source"]["codexHome"] + "/"
        for line in result.stdout.decode("utf-8", "replace").splitlines():
            if line.startswith("p"): pid, access = line[1:], None
            elif line.startswith("f"): access = None
            elif line.startswith("a"): access = line[1:]
            elif line.startswith("n") and line[1:].startswith(root) and access in ("w", "u") and pid != str(os.getpid()):
                raise Refuse("source-writer-running", True)
        return quick_process_check
    except Refuse:
        raise
    except Exception:
        raise Refuse("source-owner-unverified", True)


def inspect(request):
    source, primary, directory = request_paths(request)
    summaries, thread_count = {}, 0
    for name in DATABASES:
        if name == "memories_1.sqlite" and not (source / name).exists(): continue
        with contextlib.closing(connect(source / name)) as src, contextlib.closing(connect(primary / name)) as dst:
            validate_schema(src, dst, name)
            summaries[name] = {table: table_summary(src, table) for table in COPY_TABLES[name] if table in tables(src)}
            if name == "state_5.sqlite":
                thread_count = summaries[name].get("threads", {}).get("rows", 0)
                if not 0 < thread_count <= MAX_THREADS: raise Refuse("thread-count-out-of-range")
            if name == "queue_1.sqlite" and summaries[name].get("queued_items", {}).get("rows", 0):
                raise Refuse("source-queue-not-empty", True)
            if name == "thread_history_1.sqlite" and src.execute("SELECT 1 FROM thread_turns WHERE status='inProgress' LIMIT 1").fetchone():
                raise Refuse("source-turn-in-progress", True)
            if name == "goals_1.sqlite" and src.execute("SELECT 1 FROM thread_goals WHERE status='active' LIMIT 1").fetchone():
                raise Refuse("source-goal-active", True)
    return source, primary, directory, summaries, thread_count


def backup(path, destination):
    safe_file(destination, allow_missing=True)
    if destination.exists(): raise Refuse("backup-already-exists")
    partial = destination.with_name(destination.name + ".partial")
    # Only this helper's unfinished private output is replaced. A completed
    # backup is never overwritten, and retries cannot create unbounded copies.
    for suffix in ("-wal", "-shm", "-journal", ""):
        leftover = Path(str(partial) + suffix)
        if safe_file(leftover, allow_missing=True) is not None: leftover.unlink()
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    with contextlib.closing(connect(path)) as src, contextlib.closing(sqlite3.connect(partial)) as dst:
        src.backup(dst)
        if dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
            raise Refuse("snapshot-not-standalone")
    os.chmod(partial, 0o600)
    with partial.open("rb") as stream: os.fsync(stream.fileno())
    publish_file(partial, destination)
    parent = os.open(destination.parent, os.O_RDONLY | os.O_NOFOLLOW)
    try: os.fsync(parent)
    finally: os.close(parent)


def ensure_backup(path, destination, name, expected=None):
    if not destination.exists(): backup(path, destination)
    before = file_identity(safe_file(destination))
    with contextlib.closing(connect_snapshot(destination)) as snapshot, contextlib.closing(connect(path)) as live:
        if [tuple(row) for row in snapshot.execute("PRAGMA quick_check")] != [("ok",)]:
            raise Refuse("snapshot-integrity-failed")
        if tables(snapshot) != tables(live): raise Refuse("snapshot-schema-mismatch")
        validate_schema(snapshot, live, name)
        if expected is not None:
            actual = {table: table_summary(snapshot, table) for table in COPY_TABLES[name] if table in tables(snapshot)}
            if actual != expected: raise Refuse("source-changed-since-plan", True)
    if before != file_identity(safe_file(destination)): raise Refuse("snapshot-changed-during-read")


def copy_file(source, destination):
    before = safe_file(source)
    if before.st_size > MAX_FILE_BYTES: raise Refuse("rollout-too-large")
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    h = hashlib.sha256()
    mkdir(destination.parent)
    safe_file(destination, allow_missing=True)
    if destination.exists(): raise Refuse("staging-file-conflict")
    partial = destination.with_name(destination.name + ".partial")
    if safe_file(partial, allow_missing=True) is not None: partial.unlink()
    out = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "rb") as reader, os.fdopen(out, "wb") as writer:
        opened = os.fstat(reader.fileno())
        if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (opened.st_ino, opened.st_dev, opened.st_size, opened.st_mtime_ns):
            raise Refuse("source-file-changed", True)
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            h.update(chunk); writer.write(chunk)
        after = os.fstat(reader.fileno())
        if (opened.st_ino, opened.st_size, opened.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise Refuse("source-file-changed", True)
        writer.flush(); os.fsync(writer.fileno())
    os.utime(partial, ns=(before.st_atime_ns, before.st_mtime_ns))
    publish_file(partial, destination)
    parent = os.open(destination.parent, os.O_RDONLY | os.O_NOFOLLOW)
    try: os.fsync(parent)
    finally: os.close(parent)
    return {"bytes": before.st_size, "sha256": h.hexdigest()}


def file_hash(path):
    safe_file(path)
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = file_identity(os.fstat(stream.fileno()))
        for chunk in iter(lambda: stream.read(1024 * 1024), b""): h.update(chunk)
        if before != file_identity(os.fstat(stream.fileno())) or before != file_identity(path.lstat()):
            raise Refuse("file-changed-during-read", True)
    return h.hexdigest()


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)


def cannot_open(error):
    code = getattr(error, "sqlite_errorcode", None)
    return (isinstance(code, int) and code & 255 == 14) or str(error).casefold() == "unable to open database file"


class ColdSourceReads:
    """Stable private reads for an idle source's cold, sidecar-free WAL files.

    Live stores never use immutable or read/write fallback. Only the verified
    source can be copied, while a primary remains on ordinary SQLite locking.
    """
    def __init__(self, request, source, directory, guard):
        self.request, self.source, self.directory, self.guard = request, source, directory, guard
        self.proofs, self.lock = {}, None

    def sidecars_absent(self, path):
        for suffix in ("-wal", "-shm", "-journal"):
            if safe_file(Path(str(path) + suffix), allow_missing=True) is not None:
                raise Refuse("cold-source-sidecar-present", True)

    def assert_unchanged(self):
        for path, (identity, _) in self.proofs.items():
            self.sidecars_absent(path)
            if file_identity(safe_file(path)) != identity:
                raise Refuse("cold-source-changed", True)

    def open(self, path):
        if path in self.proofs:
            self.assert_unchanged()
            return connect_snapshot(self.proofs[path][1])
        db = None
        try:
            db = connect_store(path)
            # SQLite defers its WAL open until the first schema read.
            db.execute("PRAGMA schema_version").fetchone()
            return db
        except sqlite3.Error as error:
            if db is not None: db.close()
            if not cannot_open(error): raise
        self.guard(self.request)
        self.sidecars_absent(path)
        before = file_identity(safe_file(path))
        if self.lock is None:
            mkdir(self.directory)
            self.lock = os.open(self.directory / ".cold-source-read.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snapshots = self.directory / "cold-source-read"
        mkdir(snapshots)
        snapshot = snapshots / path.name
        if snapshot.exists():
            if file_hash(snapshot) != file_hash(path): raise Refuse("cold-source-snapshot-conflict")
        else:
            evidence = copy_file(path, snapshot)
            if file_hash(path) != evidence["sha256"]: raise Refuse("cold-source-changed", True)
        self.sidecars_absent(path)
        if file_identity(safe_file(path)) != before: raise Refuse("cold-source-changed", True)
        self.guard(self.request)
        self.sidecars_absent(path)
        if file_identity(safe_file(path)) != before: raise Refuse("cold-source-changed", True)
        self.proofs[path] = (before, snapshot)
        db = connect_snapshot(snapshot)
        try:
            if [tuple(row) for row in db.execute("PRAGMA quick_check")] != [("ok",)]:
                raise Refuse("snapshot-integrity-failed")
        except BaseException:
            db.close(); raise
        return db

    def close(self):
        if self.lock is not None: os.close(self.lock); self.lock = None


def publish_file(source, target):
    """Atomic same-volume rename that refuses an existing destination."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        fn = libc.renamex_np
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = fn(os.fsencode(source), os.fsencode(target), 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        fn = libc.renameat2
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = fn(-100, os.fsencode(source), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    else: raise Refuse("atomic-publication-unavailable")
    if result:
        if ctypes.get_errno() == errno.EEXIST: raise Refuse("target-file-conflict")
        raise Refuse("atomic-publication-failed")


def prepare(request, source, primary, directory, summaries, count):
    mkdir(directory / "source-backup"); mkdir(directory / "primary-before")
    for name in summaries:
        ensure_backup(source / name, directory / "source-backup" / name, name, summaries[name])
        ensure_backup(primary / name, directory / "primary-before" / name, name)
    records, total = [], 0
    with contextlib.closing(connect_snapshot(directory / "source-backup/state_5.sqlite")) as state_db, contextlib.closing(connect_snapshot(directory / "source-backup/thread_history_1.sqlite")) as history:
        for row in state_db.execute("SELECT * FROM threads ORDER BY id"):
            tid, path = row["id"], Path(row["rollout_path"])
            if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", tid): raise Refuse("invalid-thread-id")
            if not (below(path, source / "sessions") or below(path, source / "archived_sessions")):
                raise Refuse("rollout-outside-source")
            canonical(str(path), exists=False)
            relative = str(path.relative_to(source))
            record = {"threadId": tid, "sourcePath": str(path), "targetPath": str(primary / relative), "relativePath": relative, "stateSha256": row_hash(row), "history": {}}
            for table in COPY_TABLES["thread_history_1.sqlite"]:
                if table in tables(history):
                    h, n = hashlib.sha256(), 0
                    for entry in history.execute('SELECT * FROM "' + table + '" WHERE thread_id=? ORDER BY rowid', (tid,)):
                        h.update(row_hash(entry).encode()); n += 1
                    record["history"][table] = {"rows": n, "sha256": h.hexdigest()}
            if path.exists():
                staged = directory / "files" / relative
                if staged.exists():
                    source_hash = file_hash(path)
                    if file_hash(staged) != source_hash: raise Refuse("staging-file-conflict")
                    record.update({"bytes": safe_file(path).st_size, "sha256": source_hash})
                else: record.update(copy_file(path, staged))
                total += record["bytes"]
                if total > MAX_TOTAL_BYTES: raise Refuse("rollout-total-too-large")
            elif row["history_mode"] == "paginated" and record["history"].get("thread_turns", {}).get("rows", 0) and record["history"].get("thread_items", {}).get("rows", 0):
                record["missingPaginatedRollout"] = True
            else: raise Refuse("rollout-missing-without-history")
            records.append(record)
    report = {"version": VERSION, "source": request["source"], "primary": request["primary"], "threadCount": count,
              "sourceTables": summaries, "threads": records, "queueRevisions": [], "createdAtMs": int(time.time() * 1000)}
    atomic_json(directory / "report.json", report)
    atomic_json(directory / "manifest.json", {"version": VERSION, "sourceHome": str(source), "primaryHome": str(primary),
                                              "threadIds": [entry["threadId"] for entry in records]})
    atomic_json(directory / "journal.json", {"version": VERSION, "state": "prepared", "request": request,
                "sourceTables": summaries, "reportSHA256": file_hash(directory / "report.json"),
                "manifestSHA256": file_hash(directory / "manifest.json")})
    return report


def transformed(row, table, source, primary):
    result = dict(row)
    if table == "threads": result["rollout_path"] = str(primary / Path(row["rollout_path"]).relative_to(source))
    return result


def merge_table(src, dst, table, source, primary, insert=False, revisions=None):
    cols = columns(src, table)
    names, keys = [c[1] for c in cols], [c[1] for c in sorted(cols, key=lambda c: c[5]) if c[5]]
    if not keys: raise Refuse("table-without-primary-key")
    for row in src.execute('SELECT * FROM "' + table + '"'):
        data = transformed(row, table, source, primary)
        if table == "queued_thread_revisions":
            existing = dst.execute("SELECT * FROM queued_thread_revisions WHERE thread_id=?", (data["thread_id"],)).fetchone()
            if existing is None and insert:
                dst.execute("INSERT INTO queued_thread_revisions(thread_id) VALUES (?)", (data["thread_id"],))
                existing = dst.execute("SELECT * FROM queued_thread_revisions WHERE thread_id=?", (data["thread_id"],)).fetchone()
            if insert: revisions.append({"threadId": data["thread_id"], "sourceRevision": data["revision"], "targetRevision": existing["revision"]})
            continue
        where = " AND ".join('"' + key + '"=?' for key in keys)
        existing = dst.execute('SELECT * FROM "' + table + '" WHERE ' + where, tuple(data[k] for k in keys)).fetchone()
        if existing is not None:
            if dict(existing) != data: raise Refuse("target-row-conflict")
        elif insert:
            dst.execute('INSERT INTO "' + table + '" (' + ','.join('"' + n + '"' for n in names) + ') VALUES (' + ','.join('?' for _ in names) + ')', tuple(data[n] for n in names))


def committed_receipt(primary, directory, request):
    with contextlib.closing(connect(primary / "state_5.sqlite")) as db:
        if RECEIPT_TABLE not in tables(db): return None
        if [c[1] for c in columns(db, RECEIPT_TABLE)] != ["id", "receipt_json"]: raise Refuse("receipt-schema-conflict")
        row = db.execute("SELECT receipt_json FROM " + RECEIPT_TABLE + " WHERE id=?", (directory.name,)).fetchone()
    if row is None: return None
    receipt = json.loads(row[0])
    saved = load_json(directory / "journal.json")
    if (receipt.get("requestSHA256") != digest(request) or saved.get("request") != request
            or receipt.get("reportSHA256") != file_hash(directory / "report.json")
            or receipt.get("manifestSHA256") != file_hash(directory / "manifest.json")):
        raise Refuse("committed-receipt-integrity-failed")
    result = receipt.get("result", {})
    if result.get("state") != "complete" or result.get("source") != request["source"] or result.get("primary") != request["primary"]:
        raise Refuse("committed-receipt-conflict")
    revisions_path = directory / "queue-revisions.json"
    if not revisions_path.exists():
        atomic_json(revisions_path, {"version": VERSION, "revisions": receipt.get("queueRevisions", [])})
    return result


def run(request, action, guard=source_absent, failpoint=lambda _: None):
    source, primary, directory = request_paths(request)
    if action not in ("plan", "apply"): raise Refuse("invalid-action")
    # In particular, a cold state DB must not be copied merely to count threads
    # before the host/writer absence check has granted this read-only scope.
    try: guard(request)
    except Refuse as error:
        if action != "plan": raise
        result = {"version": VERSION, "state": "waiting", "reason": error.reason,
                  "source": request["source"], "primary": request["primary"]}
        with contextlib.suppress(sqlite3.Error, Refuse):
            with contextlib.closing(connect_store(source / "state_5.sqlite")) as db:
                result["threadCount"] = db.execute("SELECT count(*) FROM threads").fetchone()[0]
        return result
    reads = ColdSourceReads(request, source, directory, guard)
    token = SOURCE_READS.set(reads)
    try: return run_guarded(request, action, guard, failpoint)
    finally: SOURCE_READS.reset(token); reads.close()


def run_guarded(request, action, guard, failpoint):
    source, primary, directory = request_paths(request)
    with contextlib.closing(connect(source / "state_5.sqlite")) as db:
        count = db.execute("SELECT count(*) FROM threads").fetchone()[0]
    if not 0 < count <= MAX_THREADS: raise Refuse("thread-count-out-of-range")
    result = {"version": VERSION, "source": request["source"], "primary": request["primary"], "threadCount": count,
              "journalPath": str(directory / "journal.json"), "reportPath": str(directory / "report.json"), "markerPath": str(directory / "marker.json")}
    source, primary, directory, summaries, count = inspect(request)
    if action == "plan": return dict(result, state="ready")
    mkdir(directory)
    lock = os.open(directory / ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        marker = directory / "marker.json"
        committed = committed_receipt(primary, directory, request)
        if marker.exists():
            completed = load_json(marker)
            if completed != committed:
                raise Refuse("marker-conflict")
            return completed
        journal = directory / "journal.json"
        if committed is not None:
            # State and this receipt committed atomically. The primary is now
            # allowed to advance these threads; never replay the old snapshot.
            atomic_json(marker, committed, 64 * 1024)
            saved = load_json(journal); saved["state"] = "complete"; atomic_json(journal, saved)
            return committed
        if journal.exists():
            saved = load_json(journal)
            if saved.get("request") != request or saved.get("sourceTables") != summaries: raise Refuse("source-changed-since-plan", True)
            if saved.get("reportSHA256") != file_hash(directory / "report.json"): raise Refuse("report-integrity-failed")
            if saved.get("manifestSHA256") != file_hash(directory / "manifest.json"): raise Refuse("manifest-integrity-failed")
            report = load_json(directory / "report.json")
        else:
            # No target mutation is possible until the prepared journal exists.
            # Validate and reuse completed private snapshots. A transient read
            # failure must not archive several GiB and make another full copy.
            report = prepare(request, source, primary, directory, summaries, count)
        for name in summaries:
            with contextlib.closing(connect_snapshot(directory / "source-backup" / name)) as src:
                actual = {table: table_summary(src, table) for table in COPY_TABLES[name] if table in tables(src)}
                if actual != summaries[name]: raise Refuse("backup-integrity-failed")
        for entry in report["threads"]:
            if entry.get("missingPaginatedRollout"): continue
            if file_hash(Path(entry["sourcePath"])) != entry["sha256"]: raise Refuse("source-file-changed", True)
            if file_hash(directory / "files" / entry["relativePath"]) != entry["sha256"]: raise Refuse("staging-file-changed")
            target = Path(entry["targetPath"])
            if target.exists() and file_hash(target) != entry["sha256"]: raise Refuse("target-file-conflict")
        for name in summaries:
            with contextlib.closing(connect_snapshot(directory / "source-backup" / name)) as src, contextlib.closing(connect(primary / name)) as dst:
                validate_schema(src, dst, name)
                for table in COPY_TABLES[name]:
                    if table in tables(src): merge_table(src, dst, table, source, primary)
        failpoint("after-preflight")
        # Copy bytes outside the state writer transaction. The app does not scan
        # this private directory. Publication later only links/renames inodes.
        publication_stage = primary / ".quotapie-session-staging" / directory.name
        for entry in report["threads"]:
            if entry.get("missingPaginatedRollout"): continue
            target = Path(entry["targetPath"])
            if target.exists(): continue
            pending = publication_stage / entry["relativePath"]
            if pending.exists():
                if file_hash(pending) != entry["sha256"]: raise Refuse("publication-stage-conflict")
            else: copy_file(directory / "files" / entry["relativePath"], pending)
        revisions = []
        for name in summaries:
            if name == "state_5.sqlite": continue
            guard(request)
            with contextlib.closing(connect_snapshot(directory / "source-backup" / name)) as src, contextlib.closing(connect(primary / name, False)) as dst:
                dst.execute("BEGIN IMMEDIATE")
                try:
                    for table in COPY_TABLES[name]:
                        if table in tables(src): merge_table(src, dst, table, source, primary, True, revisions)
                    dst.commit()
                except BaseException: dst.rollback(); raise
            failpoint("after-" + name)
        SOURCE_READS.get().assert_unchanged()
        if inspect(request)[3] != summaries: raise Refuse("source-changed-before-publication", True)
        quick_process_check = guard(request)
        manifest_path = directory / "manifest.json"
        completed = dict(result, state="complete", completedAtMs=int(time.time() * 1000),
                         manifestPath=str(manifest_path), manifestSHA256=file_hash(manifest_path))
        receipt = {"version": VERSION, "requestSHA256": digest(request), "reportSHA256": file_hash(directory / "report.json"),
                   "manifestSHA256": completed["manifestSHA256"], "result": completed, "queueRevisions": revisions}
        # Existing rollout verification is potentially expensive. Finish it
        # before the primary writer lock; inside the lock verify only the exact
        # same inode/metadata and atomically publish any new rollout.
        published_files = {}
        for entry in report["threads"]:
            if entry.get("missingPaginatedRollout"): continue
            target = Path(entry["targetPath"])
            mkdir(target.parent)
            if target.exists():
                before = file_identity(target.lstat())
                if file_hash(target) != entry["sha256"] or before != file_identity(target.lstat()):
                    raise Refuse("target-file-conflict")
                published_files[str(target)] = before
        with contextlib.ExitStack() as stack:
            source_reads = [stack.enter_context(contextlib.closing(connect(source / name))) for name in summaries]
            versions = [(db.execute("PRAGMA data_version").fetchone()[0], db.execute("PRAGMA schema_version").fetchone()[0]) for db in source_reads]
            src = stack.enter_context(contextlib.closing(connect_snapshot(directory / "source-backup/state_5.sqlite")))
            dst = stack.enter_context(contextlib.closing(connect(primary / "state_5.sqlite", False)))
            dst.execute("BEGIN IMMEDIATE")
            try:
                published_directories = set()
                for entry in report["threads"]:
                    if entry.get("missingPaginatedRollout"): continue
                    target = Path(entry["targetPath"])
                    previous = published_files.get(str(target))
                    if previous is None:
                        pending = publication_stage / entry["relativePath"]
                        publish_file(pending, target)
                        published_directories.add(target.parent)
                    elif previous != file_identity(target.lstat()): raise Refuse("target-file-conflict")
                for parent in published_directories:
                    parent_fd = os.open(parent, os.O_RDONLY | os.O_NOFOLLOW)
                    try: os.fsync(parent_fd)
                    finally: os.close(parent_fd)
                # No codesign or lsof under the primary writer lock. The heavy
                # owner check finished above; only generation/database fences
                # run in this short publication transaction.
                if callable(quick_process_check): quick_process_check()
                # Snapshot data_version cannot detect changes in its origin.
                # Recheck cold source inodes and sidecar absence explicitly.
                SOURCE_READS.get().assert_unchanged()
                if versions != [(db.execute("PRAGMA data_version").fetchone()[0], db.execute("PRAGMA schema_version").fetchone()[0]) for db in source_reads]:
                    raise Refuse("source-changed-before-publication", True)
                for table in COPY_TABLES["state_5.sqlite"]:
                    if table in tables(src): merge_table(src, dst, table, source, primary, True, revisions)
                dst.execute("CREATE TABLE IF NOT EXISTS " + RECEIPT_TABLE + "(id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL)")
                if [c[1] for c in columns(dst, RECEIPT_TABLE)] != ["id", "receipt_json"]: raise Refuse("receipt-schema-conflict")
                dst.execute("INSERT INTO " + RECEIPT_TABLE + "(id,receipt_json) VALUES (?,?)", (directory.name, encode(receipt).decode()))
                failpoint("before-state-commit")
                if callable(quick_process_check): quick_process_check()
                SOURCE_READS.get().assert_unchanged()
                if versions != [(db.execute("PRAGMA data_version").fetchone()[0], db.execute("PRAGMA schema_version").fetchone()[0]) for db in source_reads]:
                    raise Refuse("source-changed-before-publication", True)
                dst.commit()
            except BaseException: dst.rollback(); raise
        failpoint("after-state-commit")
        atomic_json(directory / "queue-revisions.json", {"version": VERSION, "revisions": revisions})
        atomic_json(marker, completed, 64 * 1024)
        saved = load_json(journal); saved["state"] = "complete"; atomic_json(journal, saved)
        return completed
    finally:
        os.close(lock)


def database_failure(error):
    # A missing/invalid store is not a lock. Treat only SQLite's BUSY/LOCKED
    # classes (including extended codes) as transient; never expose SQL or paths.
    code = getattr(error, "sqlite_errorcode", None)
    message = str(error).casefold()
    busy = (isinstance(code, int) and code & 255 in (5, 6)) or message in (
        "database is locked", "database table is locked", "database schema is locked") or message.startswith((
        "database table is locked:", "database schema is locked:"))
    reason = "store-busy" if busy else "store-open-failed" if message == "unable to open database file" else "store-read-failed"
    return {"version": VERSION, "state": "waiting" if busy else "blocked", "reason": reason}


def main():
    try:
        raw = sys.stdin.buffer.readline(65537)
        if len(raw) > 65536: raise Refuse("request-too-large")
        request = json.loads(raw)
        result = run(request, sys.argv[1] if len(sys.argv) == 2 else "invalid")
    except Refuse as error:
        result = {"version": VERSION, "state": "waiting" if error.waiting else "blocked", "reason": error.reason}
    except sqlite3.Error as error:
        result = database_failure(error)
    except BlockingIOError:
        result = {"version": VERSION, "state": "waiting", "reason": "store-busy"}
    except Exception:
        result = {"version": VERSION, "state": "blocked", "reason": "consolidation-unavailable"}
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__": main()
