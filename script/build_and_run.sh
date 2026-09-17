#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="QuotaPie"
BUNDLE_ID="local.quotapie.menubar"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `bundle` takes its destination as the second argument so scripts/package-macos.sh
# can assemble into build/ without touching the dist/ copy a local run uses.
DIST_DIR="${2:-$ROOT_DIR/dist}"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_BINARY="$APP_MACOS/$APP_NAME"
AGENT_DOMAIN="gui/$(id -u)"
AGENT_PLIST="$HOME/Library/LaunchAgents/$BUNDLE_ID.plist"
RESTORE_AGENT=0
PREVIOUS_APP=""
APP_STARTED=0
BUILD_CONFIGURATION="${QUOTAPIE_BUILD_CONFIGURATION:-release}"

# Verification owns an isolated debug bundle and loopback fixture. It never
# unloads the installed launch agent or terminates a user's app.
if [[ "$MODE" == "--verify" || "$MODE" == "verify" ]]; then
  exec bun "$ROOT_DIR/script/verify-macos.ts"
fi

# Every mode assembles the bundle the same way, so the app the packaging script
# signs is laid out exactly like the one a local run produces. A second copy of
# these steps in package-macos.sh would drift the moment Info.plist gains a key
# or Resources gains a file.
build_bundle() {
  cd "$ROOT_DIR"
  swift build -c "$BUILD_CONFIGURATION" --product "$APP_NAME"
  swift build -c "$BUILD_CONFIGURATION" --product QuotaPiePowerHelper
  local build_binary
  build_binary="$(swift build -c "$BUILD_CONFIGURATION" --show-bin-path)/$APP_NAME"

  rm -rf "$APP_BUNDLE"
  mkdir -p "$APP_MACOS" "$APP_CONTENTS/Resources"
  cp "$build_binary" "$APP_BINARY"
  cp "$ROOT_DIR/macos/QuotaPie/Info.plist" "$APP_CONTENTS/Info.plist"
  cp "$ROOT_DIR/macos/QuotaPie/QuotaPie.icns" "$APP_CONTENTS/Resources/QuotaPie.icns"
  # Keep localizations in the main app bundle so macOS can apply its system and
  # per-app language preference before QuotaPie renders its first view.
  cp -R "$ROOT_DIR/macos/QuotaPie/Resources/en.lproj" "$APP_CONTENTS/Resources/en.lproj"
  cp -R "$ROOT_DIR/macos/QuotaPie/Resources/ko.lproj" "$APP_CONTENTS/Resources/ko.lproj"
  mkdir -p "$APP_CONTENTS/Helpers"
  cp "$(dirname "$build_binary")/QuotaPiePowerHelper" "$APP_CONTENTS/Helpers/QuotaPiePowerHelper"
  cp "$ROOT_DIR/script/install_power_helper.sh" "$APP_CONTENTS/Resources/"
  chmod +x "$APP_BINARY"
}

# `bundle` stops before the three things the packaging path must not do: kill a
# running copy, ad-hoc sign (package-macos.sh applies the real Developer ID
# signature, and an ad-hoc one would just be overwritten), and launch anything.
if [ "$MODE" = "bundle" ]; then
  build_bundle
  echo "$APP_BUNDLE"
  exit 0
fi

case "$MODE" in
  run|--debug|debug|--logs|logs|--telemetry|telemetry|--verify|verify) ;;
  *) echo "usage: $0 [run|--debug|--logs|--telemetry|--verify|bundle [dest-dir]]" >&2; exit 2 ;;
esac

# Keep the installed app available until its replacement has built successfully.
build_bundle
codesign --force --sign - --timestamp=none "$APP_CONTENTS/Helpers/QuotaPiePowerHelper"
codesign --force --sign - --timestamp=none "$APP_BUNDLE" >/dev/null

development_pids() {
  local pid
  for pid in $(pgrep -x "$APP_NAME" || true); do
    if [ "$(ps -p "$pid" -o comm=)" = "$APP_BINARY" ]; then echo "$pid"; fi
  done
}

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ "$APP_STARTED" = 1 ]; then
    local pid
    for pid in $(development_pids); do kill -TERM "$pid" 2>/dev/null || true; done
    for _ in {1..50}; do
      [ -z "$(development_pids)" ] && break
      sleep 0.1
    done
  fi
  if [ "$RESTORE_AGENT" = 1 ]; then
    launchctl bootstrap "$AGENT_DOMAIN" "$AGENT_PLIST" || result=1
  elif [ -n "$PREVIOUS_APP" ]; then
    /usr/bin/open "$PREVIOUS_APP" || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A SIGTERM alone makes KeepAlive restart the installed copy during verification.
# Temporarily unload its job, then restore it when the development session ends.
if launchctl print "$AGENT_DOMAIN/$BUNDLE_ID" >/dev/null 2>&1; then
  [ -f "$AGENT_PLIST" ] || { echo "Cannot restore the loaded menu bar agent: $AGENT_PLIST is missing" >&2; exit 1; }
  launchctl bootout "$AGENT_DOMAIN/$BUNDLE_ID"
  RESTORE_AGENT=1
else
  for pid in $(pgrep -x "$APP_NAME" || true); do
    previous_binary="$(ps -p "$pid" -o comm=)"
    if [ "$previous_binary" != "$APP_BINARY" ] && [[ "$previous_binary" == *.app/Contents/MacOS/QuotaPie ]]; then
      PREVIOUS_APP="${previous_binary%/Contents/MacOS/QuotaPie}"
      break
    fi
  done
fi
# Terminate only this checkout's app or the exact installed app we will restore.
for pid in $(pgrep -x "$APP_NAME" || true); do
  command="$(ps -p "$pid" -o comm=)"
  if [ "$command" = "$APP_BINARY" ] || { [ -n "$PREVIOUS_APP" ] && [ "$command" = "$PREVIOUS_APP/Contents/MacOS/$APP_NAME" ]; }; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
done
for _ in {1..50}; do
  pgrep -x "$APP_NAME" >/dev/null || break
  sleep 0.1
done

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
  APP_STARTED=1
}

case "$MODE" in
  run)
    open_app
    # Keep ownership of this development session so Quit or Ctrl-C restores the
    # user's installed app instead of leaving a second menu bar meter behind.
    sleep 1
    while [ -n "$(development_pids)" ]; do sleep 1; done
    ;;
  --debug|debug)
    APP_STARTED=1
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify|bundle [dest-dir]]" >&2
    exit 2
    ;;
esac
