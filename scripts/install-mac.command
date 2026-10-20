#!/bin/bash
# Installs the Syncu helper so it starts automatically at login.
# Double-click this file in Finder (or run it in Terminal).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Syncu"
PLIST="$HOME/Library/LaunchAgents/com.syncu.helper.plist"

if ! command -v ffmpeg >/dev/null && [ ! -x /opt/homebrew/bin/ffmpeg ] && [ ! -x /usr/local/bin/ffmpeg ]; then
  echo "FFmpeg not found. Install it first:  brew install ffmpeg   (https://brew.sh)"
  exit 1
fi

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
cp "$HERE/helper/syncu-engine" "$DEST/"
chmod +x "$DEST/syncu-engine"
# Downloaded files are quarantined by macOS; this one is ours, so clear it.
xattr -dr com.apple.quarantine "$DEST/syncu-engine" 2>/dev/null || true

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.syncu.helper</string>
  <key>ProgramArguments</key><array><string>$DEST/syncu-engine</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DEST/helper.log</string>
</dict></plist>
PL

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1
if curl -s -H 'X-Syncu: 1' http://127.0.0.1:47800/health | grep -q '"ok":true'; then
  echo "Syncu helper is running. Now load plugin/manifest.json in the UXP Developer Tool."
else
  echo "Helper didn't answer; see $DEST/helper.log"
fi
