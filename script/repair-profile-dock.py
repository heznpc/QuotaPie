#!/usr/bin/env python3
"""Replace vendor-only Dock entries with validated QuotaPie profile launchers."""
import argparse
import base64
import copy
import datetime
import json
import os
import pathlib
import plistlib
import subprocess
import urllib.parse


def read_preferences(domain):
    return plistlib.loads(subprocess.check_output(["/usr/bin/defaults", "export", domain, "-"]))


def dock_path(tile):
    value = tile.get("tile-data", {}).get("file-data", {}).get("_CFURLString", "")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        return None
    return pathlib.Path(urllib.parse.unquote(parsed.path)).resolve()


def repair(dock, profiles, vendor, root):
    launchers = []
    for profile in profiles:
        launcher = root / (profile["id"] + ".app")
        info = plistlib.loads((launcher / "Contents/Info.plist").read_bytes())
        descriptor = json.loads(base64.b64decode(info["QuotaPieProfile"]))
        if info.get("CFBundleIdentifier") != "local.quotapie.profile-launcher." + profile["id"]:
            raise ValueError("unrecognized_launcher")
        saved = descriptor["profile"]
        if pathlib.Path(descriptor["targetApp"]).resolve() != vendor or any(
            pathlib.Path(saved[k]).expanduser().resolve() != pathlib.Path(profile[k]).expanduser().resolve()
            for k in ("codexHome", "appData")
        ):
            raise ValueError("launcher_identity_changed")
        # Keep the primary vendor tile: it already has the default identity.
        # Only secondary accounts need a fixed-profile launcher in the Dock.
        launchers.append((vendor if profile["id"] == "primary" else launcher,
                          "ChatGPT" if profile["id"] == "primary" else info["CFBundleName"]))
    result = copy.deepcopy(dock)
    tiles = result.get("persistent-apps", [])
    candidates = [i for i, tile in enumerate(tiles) if dock_path(tile) == vendor
                  or dock_path(tile) in {path.resolve() for path, _ in launchers}]
    if not candidates:
        raise ValueError("no_existing_vendor_dock_entry")
    replacement = []
    for index, (path, label) in enumerate(launchers):
        tile = copy.deepcopy(tiles[candidates[min(index, len(candidates) - 1)]])
        if index >= len(candidates):
            tile["GUID"] = max((item.get("GUID", 0) for item in tiles), default=0) + index + 1
        data = tile.setdefault("tile-data", {})
        data["file-data"] = {"_CFURLString": path.as_uri() + "/", "_CFURLStringType": 15}
        data["file-label"] = label
        data["bundle-identifier"] = "com.openai.codex" if profiles[index]["id"] == "primary" else "local.quotapie.profile-launcher." + profiles[index]["id"]
        data.pop("book", None)  # Old vendor bookmark must not override the new URL.
        data.pop("file-mod-date", None)
        replacement.append(tile)
    first = candidates[0]
    result["persistent-apps"] = [tile for i, tile in enumerate(tiles[:first]) if i not in candidates] + replacement + [
        tile for i, tile in enumerate(tiles[first:], first) if i not in candidates
    ]
    return result, len(candidates), len(replacement)


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--vendor-app", required=True)
    args.add_argument("--apply", action="store_true")
    options = args.parse_args()
    home = pathlib.Path.home()
    vendor = pathlib.Path(options.vendor_app).resolve()
    info = plistlib.loads((vendor / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.openai.codex":
        raise ValueError("unrecognized_vendor_app")
    preferences = read_preferences("local.quotapie.menubar")
    profiles = json.loads(preferences["local.quotapie.codex-desktop-profiles.v1"])
    if any(not p["id"] or not all(c.isalnum() or c == "-" for c in p["id"]) for p in profiles):
        raise ValueError("invalid_profile_id")
    dock = read_preferences("com.apple.dock")
    result, before, after = repair(dock, profiles, vendor, home / "Applications/QuotaPie Profiles")
    changed = result["persistent-apps"] != dock.get("persistent-apps", [])
    receipt = {"changed": changed, "previousEntries": before, "profileEntries": after, "applied": False}
    if options.apply and changed:
        if read_preferences("com.apple.dock").get("persistent-apps", []) != dock.get("persistent-apps", []):
            raise ValueError("dock_changed_during_repair")
        folder = home / ".local/share/quotapie/dock-backups"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = folder / (datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".plist")
        with backup.open("xb") as file:
            os.chmod(backup, 0o600)
            plistlib.dump(dock, file)
        # Send property-list bytes over stdin, never through shell interpolation.
        subprocess.run(["/usr/bin/defaults", "import", "com.apple.dock", "-"],
                       input=plistlib.dumps(result), check=True)
        service = "gui/" + str(os.getuid()) + "/com.apple.Dock.agent"
        subprocess.run(["/bin/launchctl", "print", service], stdout=subprocess.DEVNULL, check=True)
        subprocess.run(["/bin/launchctl", "kickstart", "-k", service], check=True)
        receipt.update(applied=True, backup=str(backup))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
