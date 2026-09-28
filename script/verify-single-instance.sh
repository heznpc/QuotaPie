#!/usr/bin/env bash
# Real NSWorkspace launch notifications and flock, with isolated bundle IDs.
# Neither the installed QuotaPie nor its launch agent is stopped by this test.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d -t quotapie-instance-check)"
IDENTIFIER="local.quotapie.instance-test.$(uuidgen)"

cleanup() {
  local result=$? file pid
  trap - EXIT
  for file in "$STAGE"/*.pid; do
    [ -f "$file" ] || continue
    pid="$(cat "$file")"
    # Recheck the executable, not only a PID which might have been reused.
    case "$(ps -p "$pid" -o comm= 2>/dev/null || true)" in
      "$STAGE"/*.app/Contents/MacOS/Fixture) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done
  for bundle in "$STAGE"/*.app; do
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$bundle" >/dev/null 2>&1 || true
  done
  rm -rf "$STAGE"
  exit "$result"
}
trap cleanup EXIT

cat > "$STAGE/main.swift" <<'SWIFT'
import AppKit
let args = CommandLine.arguments
let role = args[1], marker = args[2], lockDirectory = URL(fileURLWithPath: args[3])
try String(ProcessInfo.processInfo.processIdentifier).write(toFile: marker, atomically: true, encoding: .utf8)
let lock = SingleInstanceLock()
if role == "owner", try !lock.acquire(at: lockDirectory) { exit(0) }
final class Delegate: NSObject, NSApplicationDelegate {
    let marker: String
    init(marker: String) { self.marker = marker }
    func applicationDidFinishLaunching(_ notification: Notification) {
        try! "ready".write(toFile: marker + ".ready", atomically: true, encoding: .utf8)
    }
}
let app = NSApplication.shared
let delegate = Delegate(marker: marker)
app.setActivationPolicy(.accessory)
app.delegate = delegate
let guardInstance = role == "owner" ? MenuBarInstanceGuard(bundleIdentifier: Bundle.main.bundleIdentifier!) : nil
guardInstance?.start()
withExtendedLifetime((lock, guardInstance, delegate)) { app.run() }
SWIFT
swiftc -target "$(uname -m)-apple-macos13.0" "$ROOT/macos/QuotaPie/SingleInstanceLock.swift" "$ROOT/macos/QuotaPie/MenuBarInstanceGuard.swift" "$STAGE/main.swift" -o "$STAGE/Fixture"

make_bundle() {
  local name="$1" identifier="$2" contents="$STAGE/$1.app/Contents"
  mkdir -p "$contents/MacOS"
  cp "$STAGE/Fixture" "$contents/MacOS/Fixture"
  cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>$identifier</string>
<key>CFBundleName</key><string>$name</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
  codesign --force --sign - --timestamp=none "$STAGE/$name.app" >/dev/null 2>&1
}
for name in Owner OwnerCopy Legacy; do make_bundle "$name" "$IDENTIFIER"; done
make_bundle Preview "$IDENTIFIER.preview"

await_file() {
  for _ in {1..100}; do [ ! -f "$1" ] || return 0; sleep 0.05; done
  echo "FAIL: missing lifecycle marker $(basename "$1")" >&2; exit 1
}
await_exit() {
  for _ in {1..100}; do kill -0 "$1" 2>/dev/null || return 0; sleep 0.05; done
  echo "FAIL: duplicate process $1 survived" >&2; exit 1
}
launch() {
  /usr/bin/open -n -g "$STAGE/$1.app" --args "$2" "$STAGE/$3.pid" "$STAGE/lock"
  await_file "$STAGE/$3.pid"
}
assert_owner_and_preview() {
  kill -0 "$(cat "$STAGE/owner.pid")"
  kill -0 "$(cat "$STAGE/preview.pid")"
}

launch Preview legacy preview
await_file "$STAGE/preview.pid.ready"
launch Legacy legacy before
await_file "$STAGE/before.pid.ready"
launch Owner owner owner
await_file "$STAGE/owner.pid.ready"
await_exit "$(cat "$STAGE/before.pid")"
assert_owner_and_preview
echo 'PASS: legacy app already running is retired; owner and separate preview survive'

launch Legacy legacy after
await_exit "$(cat "$STAGE/after.pid")"
assert_owner_and_preview
echo 'PASS: later legacy launch is retired through NSWorkspace notification'

launch OwnerCopy owner rejected
await_exit "$(cat "$STAGE/rejected.pid")"
test ! -f "$STAGE/rejected.pid.ready"
assert_owner_and_preview
echo 'PASS: second lock-aware bundle exits before finishing launch'

kill -TERM "$(cat "$STAGE/owner.pid")"
await_exit "$(cat "$STAGE/owner.pid")"
launch OwnerCopy owner replacement
await_file "$STAGE/replacement.pid.ready"
kill -0 "$(cat "$STAGE/replacement.pid")"
echo 'PASS: lock releases on owner exit and replacement launches'
