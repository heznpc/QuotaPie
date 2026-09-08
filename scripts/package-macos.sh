#!/usr/bin/env bash
# Build, sign, notarize, and staple QuotaPie.app plus its DMG.
#
# script/build_and_run.sh ad-hoc signs for local use. An ad-hoc designated
# requirement is a bare cdhash with no team anchor, so Gatekeeper on any other
# Mac refuses it outright — that build launches on the machine that made it and
# nowhere else. Developer ID signing plus notarization is what makes a
# downloaded copy open, and this script is the only path that produces one.
#
# The bundle includes the menu bar client and its fixed-function power helper. QuotaPie is two processes: this
# SwiftUI app, and a Bun backend run separately from bin/quotapie. The backend is
# the half that reads ~/.claude/.credentials.json, queries the keychain, and
# binds 127.0.0.1:47831; none of it is inside the bundle. The app is a plain HTTP
# client of that port and holds no credentials of its own.
#
# QuotaPie is therefore not sandboxed. The app's "Open config" action hands
# ~/.config/quotapie/config.json to NSWorkspace, an arbitrary home-directory path
# with no file-picker behind it to grant access, and a container would break it
# for nothing: the sandbox cannot protect credentials that live in another
# process. The hardened runtime, which notarization does require, is applied by
# the shared sign step below.
#
# Environment:
#   SIGN_IDENTITY       — codesign identity. Default: the Developer ID
#                         Application identity found in the keychain.
#   NOTARY_PROFILE      — notarytool keychain profile. Default: AC_API.
#   SKIP_BUILD=1        — package whatever is already in build/Release.
#   SKIP_NOTARIZATION=1 — sign and package without contacting Apple. Useful
#                         offline; the result still will not pass Gatekeeper on
#                         another Mac, because notarization is what Gatekeeper
#                         checks.
#
# Exit codes:
#   0  success
#   1  build/packaging/signing failure
#   2  Apple rejected notarization
#   3  Gatekeeper assessment failed after notarization

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Repo-specific ────────────────────────────────────────────────────
# Everything below the closing marker is shared verbatim with the other
# Heznpc macOS repos; keep edits above it so the shared half stays diffable.
PRODUCTS_DIR="${ROOT}/build/Release"
ENTITLEMENTS="${ROOT}/macos/QuotaPie/QuotaPie.entitlements"

build_app() {
  # There is no .xcodeproj here — the app is a SwiftPM executable target that
  # script/build_and_run.sh copies into a hand-assembled bundle. Reuse that
  # script's `bundle` mode rather than restating the layout: it is the same code
  # path a local run takes, so the bundle signed here cannot drift from the one
  # developers actually test.
  #
  # `bundle` deliberately skips the pkill, the ad-hoc signature, and the launch
  # that the other modes perform, and writes to the directory named here instead
  # of dist/ — so packaging never disturbs a running copy or the local build.
  ( cd "${ROOT}" && ./script/build_and_run.sh bundle "${PRODUCTS_DIR}" >/dev/null )
}
# ── End repo-specific ────────────────────────────────────────────────

DIST_DIR="${ROOT}/build/dist"
STAGE_DIR="${ROOT}/build/dmg-stage"
NOTARY_PROFILE="${NOTARY_PROFILE:-AC_API}"

log() { printf 'package-macos: %s\n' "$*"; }
die() { printf 'package-macos: %s\n' "$*" >&2; exit 1; }

# ── Resolve the signing identity ─────────────────────────────────────
# Unlike a local-only tool, there is no useful ad-hoc fallback here: the whole
# point of this script is producing something another Mac will open. Fail loudly
# rather than emitting a bundle that looks packaged and is not distributable.
if [ -z "${SIGN_IDENTITY:-}" ]; then
  SIGN_IDENTITY="$(
    security find-identity -v -p codesigning 2>/dev/null \
      | grep "Developer ID Application" \
      | head -n 1 \
      | sed -n 's/.*"\(.*\)".*/\1/p'
  )"
fi
[ -n "${SIGN_IDENTITY}" ] \
  || die "no Developer ID Application identity in the keychain — cannot produce a distributable build"

[ -f "${ENTITLEMENTS}" ] || die "missing entitlements file: ${ENTITLEMENTS}"

# ── Build ────────────────────────────────────────────────────────────
if [ "${SKIP_BUILD:-}" != "1" ]; then
  build_app
fi

APP_SRC="$(find "${PRODUCTS_DIR}" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
[ -n "${APP_SRC}" ] || die "no .app in ${PRODUCTS_DIR} — run without SKIP_BUILD=1"

APP_NAME="$(basename "${APP_SRC}")"
APP="${DIST_DIR}/${APP_NAME}"
BASE="${APP_NAME%.app}"
ZIP_PATH="${DIST_DIR}/${BASE}-notarize.zip"

rm -rf "${DIST_DIR}" "${STAGE_DIR}"
mkdir -p "${DIST_DIR}"
ditto "${APP_SRC}" "${APP}"

plist_get() { /usr/libexec/PlistBuddy -c "Print :$1" "${APP}/Contents/Info.plist" 2>/dev/null; }

VERSION="$(plist_get CFBundleShortVersionString || true)"
[ -n "${VERSION}" ] || VERSION="0.0.0"
BUNDLE_ID="$(plist_get CFBundleIdentifier || true)"
# Take the executable name from the bundle rather than assuming it matches the
# bundle name — PRODUCT_NAME and EXECUTABLE_NAME are separate settings.
EXECUTABLE="$(plist_get CFBundleExecutable || true)"
[ -n "${EXECUTABLE}" ] || die "no CFBundleExecutable in ${APP}/Contents/Info.plist"
DMG_PATH="${DIST_DIR}/${BASE}-${VERSION}.dmg"

log "bundle ${BUNDLE_ID} version ${VERSION} executable ${EXECUTABLE}"

# ── Sign ─────────────────────────────────────────────────────────────
# Sign inside-out — nested Mach-O first, the wrapper last — instead of --deep.
# --deep is deprecated, applies the outer entitlements to nested code, and picks
# its own opinion about what counts as code; a Flutter bundle carries a dozen
# plugin frameworks and gets that wrong in ways that only surface at notarization.
#
# --options runtime enables the hardened runtime and --timestamp embeds a
# trusted timestamp. Notarization rejects a submission missing either.
#
# Entitlements go on the app bundle only. Nested frameworks must not carry the
# sandbox entitlement: an entitled framework inside a sandboxed app is an
# invalid signature, not a stronger one.
sign() {
  codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp "$@"
}

# Extended attributes and resource forks copied along with the build products
# make codesign fail with "resource fork, Finder information, or similar
# detritus not allowed". Clear them before signing, not after a failure.
xattr -cr "${APP}"

log "signing as ${SIGN_IDENTITY}"

# Loose Mach-O payloads first (dylibs, .so plugins).
while IFS= read -r -d '' f; do
  sign "${f}"
done < <(find "${APP}/Contents" -type f \( -name '*.dylib' -o -name '*.so' \) -print0)

# Then nested bundles, deepest first, so a framework is signed only after
# everything it contains already is.
while IFS= read -r -d '' b; do
  if [ "${b}" = "${APP}" ]; then
    continue
  fi
  sign "${b}"
done < <(find "${APP}" -depth \( -name '*.framework' -o -name '*.xpc' -o -name '*.app' \) -print0)

# Fixed-function privileged helper must carry the same release signature.
sign "${APP}/Contents/Helpers/QuotaPiePowerHelper"

# Then the main executable, then the wrapper with the app's entitlements.
sign "${APP}/Contents/MacOS/${EXECUTABLE}"
sign --entitlements "${ENTITLEMENTS}" "${APP}"

log "verifying signature"
codesign --verify --deep --strict --verbose=2 "${APP}"
codesign --display --verbose=4 "${APP}" 2>&1 \
  | grep -E 'Identifier|Authority|TeamIdentifier|Timestamp|flags' || true
# ":-" is the form that writes a plain XML plist to stdout. A bare "-" writes
# the raw entitlement blob, magic header and all, which plutil cannot parse.
log "entitlements as signed"
codesign --display --entitlements :- "${APP}" 2>/dev/null | plutil -p - || true

build_dmg() {
  rm -rf "${STAGE_DIR}" "${DMG_PATH}"
  mkdir -p "${STAGE_DIR}"
  ditto "${APP}" "${STAGE_DIR}/${APP_NAME}"
  ln -s /Applications "${STAGE_DIR}/Applications"
  hdiutil create \
    -volname "${BASE}" \
    -srcfolder "${STAGE_DIR}" \
    -ov \
    -format UDZO \
    "${DMG_PATH}" >/dev/null

  # Sign the disk image itself, not just the app inside it. Gatekeeper assesses
  # the DMG when the user opens the download, and an unsigned image is judged
  # "no usable signature" even after it has been notarized and stapled — the
  # ticket has nothing to attach a verdict to.
  #
  # Name the identifier explicitly. codesign otherwise derives it from the file
  # name and truncates at the first dot, so "Fyle-0.1.0.dmg" would be signed as
  # "Fyle-0" — harmless but meaningless in a signature dump.
  codesign --force --sign "${SIGN_IDENTITY}" --timestamp \
    --identifier "${BUNDLE_ID}.dmg" "${DMG_PATH}"
}

notarize() {
  # $1 = path to submit. notarytool takes a .zip, .dmg, or .pkg — never a bare
  # .app directory.
  local target="$1"
  local raw status
  # Keep stderr out of the parse. notarytool interleaves human-readable
  # progress on stderr, and folding it into stdout turns the JSON document into
  # a stream the parser rejects — which reads as "no status" and would hide a
  # submission Apple actually accepted.
  raw="$(
    xcrun notarytool submit "${target}" \
      --keychain-profile "${NOTARY_PROFILE}" \
      --wait \
      --output-format json 2>/dev/null
  )"
  status="$(
    printf '%s' "${raw}" \
      | /usr/bin/python3 -c 'import json,sys
try:
    print(json.loads(sys.stdin.read().strip()).get("status", ""))
except Exception:
    print("")' 2>/dev/null
  )"
  if [ "${status}" != "Accepted" ]; then
    echo "package-macos: notarization of $(basename "${target}") returned '${status:-no status}'" >&2
    echo "package-macos: raw notarytool response: ${raw:-<empty>}" >&2
    echo "package-macos: inspect the log with: xcrun notarytool log <id> --keychain-profile \"${NOTARY_PROFILE}\"" >&2
    return 1
  fi
}

if [ "${SKIP_NOTARIZATION:-}" = "1" ]; then
  build_dmg
  log "packaged WITHOUT notarization — Gatekeeper will reject this on another Mac"
  echo "${APP}"
  echo "${DMG_PATH}"
  exit 0
fi

# ── Notarize and staple ──────────────────────────────────────────────
# Both artifacts get their own ticket. Stapling the .app before it goes into the
# image means the copy the user drags to /Applications is already self-sufficient,
# even if the DMG's own ticket never reaches them.
log "notarizing the app (2-10 minutes) …"
ditto -c -k --keepParent "${APP}" "${ZIP_PATH}"
notarize "${ZIP_PATH}" || exit 2
xcrun stapler staple "${APP}"

build_dmg

log "notarizing the disk image …"
notarize "${DMG_PATH}" || exit 2
xcrun stapler staple "${DMG_PATH}"

# ── Prove it ─────────────────────────────────────────────────────────
# spctl is the same assessment Gatekeeper runs on first launch. Passing here
# means it passes on a Mac that has never seen the app. Assert explicitly
# instead of trusting the exit code alone, because a "rejected" verdict with a
# source of "Unnotarized Developer ID" is the exact failure this script exists
# to prevent and it should never be reported as a success.
assert_accepted() {
  local label="$1"; shift
  local out
  if ! out="$(spctl "$@" 2>&1)"; then
    echo "package-macos: Gatekeeper REJECTED ${label}:" >&2
    echo "${out}" >&2
    return 1
  fi
  printf '%s\n' "${out}"
  case "${out}" in
    *accepted*) ;;
    *) echo "package-macos: Gatekeeper verdict for ${label} was not 'accepted'" >&2; return 1 ;;
  esac
}

log "Gatekeeper assessment"
assert_accepted "the app" --assess --type execute --verbose=2 "${APP}" || exit 3
assert_accepted "the disk image" --assess --type open \
  --context context:primary-signature --verbose=2 "${DMG_PATH}" || exit 3

log "stapled ticket check"
xcrun stapler validate "${APP}"
xcrun stapler validate "${DMG_PATH}"

echo "${APP}"
echo "${DMG_PATH}"
