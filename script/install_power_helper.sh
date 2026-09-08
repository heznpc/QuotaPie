#!/bin/bash
set -euo pipefail
# Called from the built app via macOS's administrator prompt, or via sudo.
# Only a compiled fixed-function helper is installed, never a writable script.
if [[ $(/usr/bin/id -u) != 0 ]]; then echo 'Administrator authorization is required.' >&2; exit 1; fi
MODE=${1:-}
USER_ID=${2:-}
[[ "$USER_ID" =~ ^[0-9]+$ && "$USER_ID" -ge 501 ]] || exit 64
LABEL=local.quotapie.power
DEST=/Library/PrivilegedHelperTools/$LABEL
PLIST=/Library/LaunchDaemons/$LABEL.plist
case "$MODE" in
  install)
    SOURCE=${3:-}
    [[ -f "$SOURCE" && ! -L "$SOURCE" ]] || exit 64
    /usr/bin/codesign --verify --strict "$SOURCE"
    /bin/launchctl bootout system/$LABEL 2>/dev/null || true
    if [[ -x "$DEST" ]]; then "$DEST" --restore; fi
    /usr/bin/install -d -o root -g wheel -m 755 /Library/PrivilegedHelperTools
    /usr/bin/install -o root -g wheel -m 755 "$SOURCE" "$DEST"
    /bin/cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$DEST</string><string>$USER_ID</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>
EOF
    /usr/sbin/chown root:wheel "$PLIST"
    /bin/chmod 644 "$PLIST"
    /bin/launchctl bootstrap system "$PLIST"
    ;;
  uninstall)
    /bin/launchctl bootout system/$LABEL 2>/dev/null || true
    if [[ -x "$DEST" ]]; then "$DEST" --restore; fi
    /bin/rm -f "$PLIST" "$DEST" /var/run/$LABEL.json
    ;;
  *) exit 64 ;;
esac
