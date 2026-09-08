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

# Every mode assembles the bundle the same way, so the app the packaging script
# signs is laid out exactly like the one a local run produces. A second copy of
# these steps in package-macos.sh would drift the moment Info.plist gains a key
# or Resources gains a file.
build_bundle() {
  cd "$ROOT_DIR"
  swift build -c release --product "$APP_NAME"
  swift build -c release --product QuotaPiePowerHelper
  local build_binary
  build_binary="$(swift build -c release --show-bin-path)/$APP_NAME"

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

pkill -x "$APP_NAME" >/dev/null 2>&1 || true
build_bundle
codesign --force --sign - --timestamp=none "$APP_CONTENTS/Helpers/QuotaPiePowerHelper"
codesign --force --sign - --timestamp=none "$APP_BUNDLE" >/dev/null

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
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
  --verify|verify)
    open_app
    for _ in {1..20}; do
      if pgrep -f "^${APP_BINARY}$" >/dev/null; then
        exit 0
      fi
      sleep 0.1
    done
    echo "$APP_NAME did not remain running" >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify|bundle [dest-dir]]" >&2
    exit 2
    ;;
esac
