#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_root="$(mktemp -d -t quotapie-profile-fixture)"
fixture_app="$fixture_root/Fixture.app"
mkdir -p "$fixture_app/Contents/MacOS"
cat > "$fixture_root/main.swift" <<'SWIFT'
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if let home = ProcessInfo.processInfo.environment["CODEX_HOME"] {
    try? Data("ready".utf8).write(to: URL(fileURLWithPath: home).appendingPathComponent("ready"))
}
app.run()
SWIFT
cat > "$fixture_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.quotapie.profile-fixture</string>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
swiftc -target "$(uname -m)-apple-macos13.0" "$fixture_root/main.swift" -o "$fixture_app/Contents/MacOS/Fixture"
codesign --force --sign - "$fixture_app"
QUOTAPIE_TEST_PROFILE_APP="$fixture_app" swift test --filter CodexProfilesTests
