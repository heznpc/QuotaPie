#!/usr/bin/env python3
"""Real launchd/HTTP retirement check, isolated from installed profiles and jobs."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

sys.dont_write_bytecode = True

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("relay_manager", root / "scripts/codex-compaction-local.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if sys.platform != "darwin":
    raise SystemExit("macOS launchd required; not verified")
bun = shutil.which("bun")
assert bun, "Existing Bun required"
stage = Path(tempfile.mkdtemp(prefix="quotapie-retirement-check-"))
domain = f"gui/{os.getuid()}"
relay = object.__new__(module.LocalRelay)
relay.home = stage
relay.domain = domain
profile = stage / "profile"
profile.mkdir()
entries = []
jobs = []
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def get(url):
    with opener.open(url, timeout=10) as response:
        return json.load(response)

def wait_health(settings, active=None):
    for _ in range(100):
        try:
            value = relay.health(settings)
            if active is None or value["activeRequests"] == active:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(.05)
    raise AssertionError("Fixture relay did not reach expected state")

try:
    for role in ("old", "current"):
        directory = stage / role
        directory.mkdir()
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        settings = {"port": port, "token": uuid.uuid4().hex, "codex_home": str(profile), "bun": bun,
                    "route": {"from": "gpt-6-astra", "to": "gpt-5.6-sol", "effort": "low"},
                    "label": "local.quotapie.retirement-check." + uuid.uuid4().hex}
        path = directory / "settings.json"
        path.write_text(json.dumps(settings))
        (directory / "relay.js").write_text('''
import {existsSync,readFileSync} from "node:fs";
const s=JSON.parse(readFileSync(process.argv[2],"utf8"));
let activeRequests=0;
Bun.serve({hostname:"127.0.0.1",port:s.port,async fetch(req){
 const p=new URL(req.url).pathname;
 if(p.endsWith("/quotapie-health")) return Response.json({service:"quotapie-compaction",schemaVersion:3,route:s.route,pid:process.pid,activeRequests});
 if(p.endsWith("/hold")) {activeRequests++;while(!existsSync(process.argv[2]+".release")) await Bun.sleep(10);activeRequests--;return Response.json({completed:true});}
 return new Response("fixture only",{status:404});
}});
''')
        agent = relay.agent_path(settings)
        agent.parent.mkdir(parents=True, exist_ok=True)
        agent.write_bytes(plistlib.dumps({"Label": settings["label"], "KeepAlive": True, "RunAtLoad": True,
            "ProgramArguments": [bun, str(directory / "relay.js"), str(path)],
            "StandardOutPath": str(directory / "output.log"), "StandardErrorPath": str(directory / "error.log")}))
        subprocess.run(["launchctl", "bootstrap", domain, str(agent)], check=True, capture_output=True)
        jobs.append(settings["label"])
        entries.append((path, settings))
        wait_health(settings)
    old_path, old = entries[0]
    current_path, current = entries[1]
    relay.manifest = {"settings_path": str(current_path), "retired_settings": [str(old_path)]}
    (profile / "config.toml").write_text(module.enabled_config("", relay.endpoint(current)))
    before_config = (profile / "config.toml").read_bytes()
    with concurrent.futures.ThreadPoolExecutor() as executor:
        response = executor.submit(get, relay.endpoint(old) + "/hold")
        before = wait_health(old, active=1)
        result = relay.retire()
        after = wait_health(old, active=1)
        assert before["pid"] == after["pid"]
        assert result["retired_after_logout"] == [str(old_path)]
        assert not relay.agent_path(old).exists()
        assert (old_path.parent / "retired-launch-agent.plist").exists()
        assert relay.agent_path(current).exists()
        assert (profile / "config.toml").read_bytes() == before_config
        subprocess.run(["launchctl", "print", domain + "/" + old["label"]], check=True, capture_output=True)
        old_path.with_name("settings.json.release").touch()
        assert response.result(timeout=5)["completed"]
        assert wait_health(old, active=0)["pid"] == before["pid"]
    print(json.dumps({"result": "pass", "inflightCompleted": True, "sameLoadedPID": True,
        "retiredLoginJobArchived": True, "currentJobPreserved": True, "profileUnchanged": True,
        "logoutRebootPerformed": False}))
finally:
    # Only randomly named fixture jobs created above are unloaded.
    for label in jobs:
        subprocess.run(["launchctl", "bootout", domain + "/" + label], capture_output=True)
    shutil.rmtree(stage)
