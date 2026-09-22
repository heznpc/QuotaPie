#!/bin/sh
set -eu
INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_BUN=${BUN_BIN:-}
if [ -z "$INSTALL_BUN" ]; then
  INSTALL_BUN=$(command -v bun 2>/dev/null || true)
fi
if [ -z "$INSTALL_BUN" ]; then
  for candidate in "$HOME/.bun/bin/bun" "$HOME/.local/share/mise/shims/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then INSTALL_BUN=$candidate; break; fi
  done
fi
if [ -z "$INSTALL_BUN" ] || [ ! -x "$INSTALL_BUN" ]; then
  echo "QuotaPie needs Bun 1.3 or newer. Install Bun, then rerun this installer." >&2
  exit 1
fi
exec "$INSTALL_BUN" "$INSTALL_DIR/install-macos.ts" "$@"
