import copy
import ctypes
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("host_wake", Path(__file__).resolve().parents[1] / "script/codex-host-wake.py")
wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)


def args(executable, home, data, override=None):
    argv = [str(executable), "--user-data-dir=" + str(data)]
    env = ["CODEX_HOME=" + str(home), "CODEX_ELECTRON_USER_DATA_PATH=" + str(override or data), "UNRELATED_SECRET=never-output"]
    return struct.pack("=i", len(argv)) + str(executable).encode() + b"\0\0" + b"\0".join(x.encode() for x in argv + env) + b"\0"


class FakeIO:
    def __init__(self, root):
        self.home = root
        self.profile = {"id": "secondary", "collectionAccount": "plus", "codexHome": str(root / "profile"), "appData": str(root / "data")}
        for key in ("codexHome", "appData"):
            Path(self.profile[key]).mkdir()
        self.executable = str(root / "ChatGPT.app/Contents/MacOS/ChatGPT")
        self.records = [{"pid": 42, "start": (123, 456), "args": args(self.executable, self.profile["codexHome"], self.profile["appData"])}]
        self.registered = [self.profile]
        self.sent = []
    def profiles(self): return copy.deepcopy(self.registered)
    def vendor_executable(self): return self.executable
    def processes(self, _): return copy.deepcopy(self.records)
    def send_url(self, pid, url, current):
        current()
        self.sent.append((pid, url))


class WakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.io = FakeIO(Path(self.temp.name))
        self.request = {"account": "plus", "codexHome": self.io.profile["codexHome"], "threadId": "11111111-1111-4111-8111-111111111111"}

    def test_exact_profile_pid_only(self):
        plan = wake.prepare(self.request, self.io)
        wake.send(plan, self.request, self.io)
        self.assertEqual(self.io.sent, [(42, "codex://threads/wake/" + self.request["threadId"])])
        self.assertNotIn("UNRELATED_SECRET", str(plan))

    def test_no_owner_duplicate_owner_and_wrong_profile_fail(self):
        for records in ([], self.io.records * 2, [{**self.io.records[0], "args": args(self.io.executable, self.io.profile["appData"], self.io.profile["codexHome"])}]):
            with self.subTest(records=len(records)):
                original = self.io.records
                self.io.records = records
                with self.assertRaises(wake.Unavailable): wake.prepare(self.request, self.io)
                self.io.records = original
        self.assertEqual(self.io.sent, [])

    def test_unregistered_account_and_ambiguous_registration_fail(self):
        for profiles in ([], [dict(self.io.profile, collectionAccount="other")], [self.io.profile, self.io.profile]):
            self.io.registered = profiles
            with self.assertRaises(wake.Unavailable): wake.prepare(self.request, self.io)

    def test_dropped_isolation_environment_and_mismatched_argv_fail(self):
        raw = args(self.io.executable, self.io.profile["codexHome"], self.io.profile["appData"], self.io.profile["codexHome"])
        with self.assertRaises(wake.Unavailable): wake.process_identity(raw, self.io.home)
        with self.assertRaises(wake.Unavailable): wake.process_identity(b"invalid", self.io.home)

    def test_pid_reuse_profile_change_and_missing_owner_before_send_fail(self):
        for change in ("pid", "profile", "owner"):
            io = self.io
            plan = wake.prepare(self.request, io)
            records, profiles = copy.deepcopy(io.records), copy.deepcopy(io.registered)
            if change == "pid": io.records[0]["start"] = (999, 1)
            if change == "profile": io.registered[0]["collectionAccount"] = "other"
            if change == "owner": io.records = []
            with self.assertRaises(wake.Unavailable): wake.send(plan, self.request, io)
            self.assertEqual(io.sent, [])
            io.records, io.registered = records, profiles

    def test_url_input_cannot_add_prompt_or_target_other_actions(self):
        for value in ("threads/new", self.request["threadId"] + "?prompt=work", "x", ""):
            with self.assertRaises(wake.Unavailable): wake.prepare({**self.request, "threadId": value}, self.io)

    def test_apple_event_is_pid_addressed_background_nonprompting_and_single_send(self):
        class Call:
            def __init__(self, name, calls, code=0): self.name, self.calls, self.code = name, calls, code
            def __call__(self, *values): self.calls.append((self.name, values)); return self.code
        class AE:
            def __init__(self, permission=0):
                self.calls = []
                for name in ("AECreateDesc", "AECreateAppleEvent", "AEPutParamPtr", "AEDeterminePermissionToAutomateTarget", "AESendMessage", "AEDisposeDesc"):
                    setattr(self, name, Call(name, self.calls, permission if name == "AEDeterminePermissionToAutomateTarget" else 0))
        for permission, changed in ((0, False), (-1744, False), (0, True)):
            ae = AE(permission)
            def current():
                if changed: raise wake.Unavailable("identity-changed")
            io = wake.NativeIO.__new__(wake.NativeIO)
            with patch.object(wake.C, "CDLL", return_value=ae):
                if permission or changed:
                    with self.assertRaises(wake.Unavailable): io.send_url(42, "codex://threads/wake/" + self.request["threadId"], current)
                else: io.send_url(42, "codex://threads/wake/" + self.request["threadId"], current)
            sends = [v for name, v in ae.calls if name == "AESendMessage"]
            self.assertEqual(len(sends), 0 if permission or changed else 1)
            target = next(v for name, v in ae.calls if name == "AECreateDesc")
            self.assertEqual(target[0], wake.fourcc("kpid"))
            self.assertEqual(ctypes.cast(target[1], ctypes.POINTER(ctypes.c_int32)).contents.value, 42)
            check = next(v for name, v in ae.calls if name == "AEDeterminePermissionToAutomateTarget")
            self.assertIs(check[3], False)
            if sends: self.assertEqual(sends[0][2], 0x20011)


if __name__ == "__main__":
    unittest.main()
