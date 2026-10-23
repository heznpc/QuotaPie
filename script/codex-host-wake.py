#!/usr/bin/env python3
"""Send one fixed wake URL to one verified, already-running desktop PID."""
import ctypes as C
import json
import os
from pathlib import Path
import plistlib
import re
import select
import struct
import subprocess
import sys

PROFILE_KEY = "local.quotapie.codex-desktop-profiles.v1"
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)


class Unavailable(Exception):
    pass


def canonical(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or not value.startswith(("/", "~/")):
        raise Unavailable("profile-unavailable")
    return str(Path(value).expanduser().resolve(strict=True))


def process_identity(raw, home):
    if len(raw) < 5:
        raise Unavailable("identity-unavailable")
    argc = struct.unpack_from("=i", raw)[0]
    if not 0 < argc < 10000:
        raise Unavailable("identity-unavailable")
    offset = raw.find(b"\0", 4)
    if offset < 0:
        raise Unavailable("identity-unavailable")
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    values = raw[offset:].split(b"\0")
    if len(values) < argc:
        raise Unavailable("identity-unavailable")
    args = [v.decode("utf-8", "strict") for v in values[:argc]]
    env = {}
    for value in values[argc:]:
        for key in (b"CODEX_HOME", b"CODEX_ELECTRON_USER_DATA_PATH"):
            if value.startswith(key + b"="):
                if key in env:
                    raise Unavailable("identity-unavailable")
                env[key] = value[len(key) + 1:].decode("utf-8", "strict")
    root = canonical(env.get(b"CODEX_HOME") or str(home / ".codex"))
    data = canonical(env.get(b"CODEX_ELECTRON_USER_DATA_PATH") or str(home / "Library/Application Support/Codex"))
    switches = []
    for index, arg in enumerate(args):
        if arg.startswith("--user-data-dir="):
            switches.append(canonical(arg.split("=", 1)[1]))
        elif arg == "--user-data-dir":
            if index + 1 >= len(args):
                raise Unavailable("identity-unavailable")
            switches.append(canonical(args[index + 1]))
    if len(switches) > 1 or switches and switches[0] != data:
        raise Unavailable("identity-unavailable")
    return root, data


def prepare(request, io):
    if (not isinstance(request, dict) or set(request) != {"account", "codexHome", "threadId"}
            or not isinstance(request["threadId"], str) or not UUID.fullmatch(request["threadId"])
            or not isinstance(request["account"], str) or not request["account"]):
        raise Unavailable("request-invalid")
    root = canonical(request["codexHome"])
    profiles = io.profiles()
    if not isinstance(profiles, list) or len(profiles) > 100:
        raise Unavailable("profile-unavailable")
    matching = [p for p in profiles if isinstance(p, dict) and p.get("collectionAccount") == request["account"]]
    if len(matching) != 1 or canonical(matching[0].get("codexHome")) != root:
        raise Unavailable("profile-unavailable")
    profile = matching[0]
    data = canonical(profile.get("appData"))
    for other in profiles:
        if other is profile:
            continue
        if not isinstance(other, dict) or any(canonical(other.get(key)) in (root, data) for key in ("codexHome", "appData")):
            raise Unavailable("profile-ambiguous")
    executable = io.vendor_executable()
    matches = []
    for process in io.processes(executable):
        identity = process_identity(process["args"], io.home)
        if identity == (root, data):
            matches.append((process["pid"], process["start"]))
    if len(matches) != 1:
        raise Unavailable("owner-unavailable" if not matches else "owner-ambiguous")
    return {"pid": matches[0][0], "start": matches[0][1], "profile": dict(profile), "executable": executable,
            "url": "codex://threads/wake/" + request["threadId"]}


def send(plan, request, io):
    def still_current():
        if prepare(request, io) != plan:
            raise Unavailable("identity-changed")
    still_current()
    io.send_url(plan["pid"], plan["url"], still_current)


class BSDInfo(C.Structure):
    _fields_ = [(name, C.c_uint32) for name in ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")] + [
        ("comm", C.c_char * 16), ("name", C.c_char * 32)] + [(name, C.c_uint32) for name in ("nfiles", "pgid", "jobc", "tdev", "tpgid")] + [
        ("nice", C.c_int32), ("start_sec", C.c_uint64), ("start_usec", C.c_uint64)]


class AEDesc(C.Structure):
    _pack_ = 2
    _fields_ = [("descriptorType", C.c_uint32), ("dataHandle", C.c_void_p)]


def fourcc(value):
    return int.from_bytes(value.encode("ascii"), "big")


class NativeIO:
    def __init__(self):
        self.home = Path.home()
        self.libproc = C.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.libc = C.CDLL(None, use_errno=True)

    def profiles(self):
        cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        cf.CFStringCreateWithCString.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32]
        cf.CFStringCreateWithCString.restype = C.c_void_p
        cf.CFPreferencesCopyAppValue.argtypes = [C.c_void_p, C.c_void_p]
        cf.CFPreferencesCopyAppValue.restype = C.c_void_p
        cf.CFGetTypeID.argtypes = [C.c_void_p]; cf.CFGetTypeID.restype = C.c_ulong
        cf.CFDataGetTypeID.restype = C.c_ulong
        cf.CFDataGetLength.argtypes = [C.c_void_p]; cf.CFDataGetLength.restype = C.c_long
        cf.CFDataGetBytePtr.argtypes = [C.c_void_p]; cf.CFDataGetBytePtr.restype = C.c_void_p
        cf.CFRelease.argtypes = [C.c_void_p]
        key = cf.CFStringCreateWithCString(None, PROFILE_KEY.encode(), 0x08000100)
        domain = cf.CFStringCreateWithCString(None, b"local.quotapie.menubar", 0x08000100)
        value = None
        try:
            value = cf.CFPreferencesCopyAppValue(key, domain)
            if not value or cf.CFGetTypeID(value) != cf.CFDataGetTypeID():
                raise Unavailable("profile-unavailable")
            length = cf.CFDataGetLength(value)
            if not 0 < length <= 1024 * 1024:
                raise Unavailable("profile-unavailable")
            return json.loads(C.string_at(cf.CFDataGetBytePtr(value), length))
        finally:
            for item in (value, key, domain):
                if item:
                    cf.CFRelease(item)

    def vendor_executable(self):
        candidates = [Path("/Applications/ChatGPT.app"), Path("/Applications/Codex.app"),
                      self.home / "Applications/ChatGPT.app", self.home / "Applications/Codex.app"]
        for app in candidates:
            if not app.is_dir():
                continue
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            if info.get("CFBundleIdentifier") != "com.openai.codex":
                continue
            name = info.get("CFBundleExecutable")
            if not isinstance(name, str) or Path(name).name != name:
                raise Unavailable("vendor-unverified")
            result = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "-R",
                '=identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', str(app)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if result.returncode:
                raise Unavailable("vendor-unverified")
            return canonical(str(app / "Contents/MacOS" / name))
        raise Unavailable("vendor-unavailable")

    def processes(self, executable):
        lib = self.libproc
        lib.proc_listpids.argtypes = [C.c_uint32, C.c_uint32, C.c_void_p, C.c_int]
        lib.proc_pidpath.argtypes = [C.c_int, C.c_void_p, C.c_uint32]
        lib.proc_pidinfo.argtypes = [C.c_int, C.c_int, C.c_uint64, C.c_void_p, C.c_int]
        pids = (C.c_int * 32768)()
        count = lib.proc_listpids(1, 0, pids, C.sizeof(pids))
        if not 0 < count < C.sizeof(pids) or count % C.sizeof(C.c_int):
            raise Unavailable("identity-unavailable")
        for pid in pids[:count // C.sizeof(C.c_int)]:
            if pid <= 0:
                continue
            path = C.create_string_buffer(4096)
            if lib.proc_pidpath(pid, path, len(path)) <= 0:
                continue
            if str(Path(os.fsdecode(path.value)).resolve()) != executable:
                continue
            info = BSDInfo()
            if lib.proc_pidinfo(pid, 3, 0, C.byref(info), C.sizeof(info)) != C.sizeof(info) or info.uid != os.getuid() or info.flags & 4:
                raise Unavailable("identity-unavailable")
            mib = (C.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
            length = C.c_size_t()
            if self.libc.sysctl(mib, 3, None, C.byref(length), None, 0) != 0 or not 0 < length.value <= 4 * 1024 * 1024:
                raise Unavailable("identity-unavailable")
            raw = C.create_string_buffer(length.value)
            if self.libc.sysctl(mib, 3, raw, C.byref(length), None, 0) != 0:
                raise Unavailable("identity-unavailable")
            yield {"pid": pid, "start": (info.start_sec, info.start_usec), "args": raw.raw[:length.value]}

    def send_url(self, pid, url, still_current):
        ae = C.CDLL("/System/Library/Frameworks/CoreServices.framework/Frameworks/AE.framework/AE")
        ae.AECreateDesc.argtypes = [C.c_uint32, C.c_void_p, C.c_long, C.POINTER(AEDesc)]
        ae.AECreateAppleEvent.argtypes = [C.c_uint32, C.c_uint32, C.POINTER(AEDesc), C.c_int16, C.c_int32, C.POINTER(AEDesc)]
        ae.AEPutParamPtr.argtypes = [C.POINTER(AEDesc), C.c_uint32, C.c_uint32, C.c_void_p, C.c_long]
        ae.AEDeterminePermissionToAutomateTarget.argtypes = [C.POINTER(AEDesc), C.c_uint32, C.c_uint32, C.c_bool]
        ae.AESendMessage.argtypes = [C.POINTER(AEDesc), C.c_void_p, C.c_int32, C.c_long]
        ae.AEDisposeDesc.argtypes = [C.POINTER(AEDesc)]
        for name in ("AECreateDesc", "AECreateAppleEvent", "AEPutParamPtr", "AEDisposeDesc"):
            getattr(ae, name).restype = C.c_int16
        ae.AEDeterminePermissionToAutomateTarget.restype = C.c_int32
        ae.AESendMessage.restype = C.c_int32
        target, event = AEDesc(), AEDesc()
        def check(code):
            if code:
                raise Unavailable("permission-unavailable" if code in (-1743, -1744) else "event-unavailable")
        try:
            value = C.c_int32(pid)
            check(ae.AECreateDesc(fourcc("kpid"), C.byref(value), C.sizeof(value), C.byref(target)))
            check(ae.AEDeterminePermissionToAutomateTarget(C.byref(target), fourcc("GURL"), fourcc("GURL"), False))
            check(ae.AECreateAppleEvent(fourcc("GURL"), fourcc("GURL"), C.byref(target), -1, 0, C.byref(event)))
            encoded = url.encode("utf-8")
            check(ae.AEPutParamPtr(C.byref(event), fourcc("----"), fourcc("utf8"), encoded, len(encoded)))
            still_current()
            # noReply | neverInteract | doNotPromptForUserConsent. PID targets
            # cannot launch an app, and this event never requests activation.
            check(ae.AESendMessage(C.byref(event), None, 0x00000001 | 0x00000010 | 0x00020000, 60))
        finally:
            ae.AEDisposeDesc(C.byref(event)); ae.AEDisposeDesc(C.byref(target))


def main():
    try:
        if sys.platform != "darwin":
            raise Unavailable("platform-unavailable")
        request = json.loads(sys.stdin.readline(16385))
        io = NativeIO()
        plan = prepare(request, io)
        if sys.argv[1:] == ["--inspect-owner"]:
            print(json.dumps({"status": "ready", "pid": plan["pid"],
                              "startedAtMs": plan["start"][0] * 1000 + plan["start"][1] / 1000}), flush=True)
            return
        if sys.argv[1:]:
            raise Unavailable("request-invalid")
        print(json.dumps({"status": "ready"}), flush=True)
        if not select.select([sys.stdin], [], [], 32)[0] or sys.stdin.readline(16) != "send\n":
            raise Unavailable("authorization-changed")
        send(plan, request, io)
        print(json.dumps({"status": "sent"}), flush=True)
    except Exception as error:
        reason = str(error) if isinstance(error, Unavailable) and re.fullmatch(r"[a-z-]{1,60}", str(error)) else "helper-unavailable"
        print(json.dumps({"status": "unavailable", "reason": "host-wake-" + reason}), flush=True)


if __name__ == "__main__":
    main()
