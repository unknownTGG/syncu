#!/bin/bash
# Installs Syncu: the helper (starts automatically at login) and the panel.
# Run once from the downloaded folder:  bash install-mac.command
# Later updates happen from inside the panel (the "Update" button).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Syncu"
PLIST="$HOME/Library/LaunchAgents/com.syncu.helper.plist"
UPDATE=0
[ "$1" = "--update" ] && UPDATE=1

if ! command -v ffmpeg >/dev/null && [ ! -x /opt/homebrew/bin/ffmpeg ] && [ ! -x /usr/local/bin/ffmpeg ]; then
  echo "FFmpeg not found. Install it first:  brew install ffmpeg   (https://brew.sh)"
  exit 1
fi

# ---- Helper ----
mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
# Copy next to it and rename: replaces the binary even while it's running.
cp "$HERE/helper/syncu-engine" "$DEST/syncu-engine.new"
chmod +x "$DEST/syncu-engine.new"
# Downloaded files are quarantined by macOS; this one is ours, so clear it.
xattr -dr com.apple.quarantine "$DEST/syncu-engine.new" 2>/dev/null || true
mv -f "$DEST/syncu-engine.new" "$DEST/syncu-engine"
echo "Helper installed in $DEST"

# ---- Panel (.ccx, installed through Adobe's plugin installer) ----
CCX="$HERE/syncu.ccx"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"
if [ -f "$CCX" ]; then
  xattr -d com.apple.quarantine "$CCX" 2>/dev/null || true
  if [ -x "$UPIA" ] && "$UPIA" --install "$CCX"; then
    echo "Panel installed. Restart Premiere Pro, then open Window > UXP Plugins > Syncu."
  else
    echo "Adobe's command-line installer didn't take it; opening the .ccx with Creative Cloud instead."
    open "$CCX" || echo "Couldn't open $CCX — double-click it in Finder, or load plugin/manifest.json in the UXP Developer Tool."
  fi
else
  echo "No syncu.ccx in this folder; load plugin/manifest.json in the UXP Developer Tool."
fi

# In update mode the running helper exits after this and launchd restarts it.
[ $UPDATE = 1 ] && exit 0

# ---- Start at login ----
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
sleep 2
if curl -s -H 'X-Syncu: 1' http://127.0.0.1:47800/health | grep -q '"ok":true'; then
  echo "Syncu helper is running."
else
  echo "Helper didn't answer; see $DEST/helper.log"
fi
echo "Done. If you loaded Syncu in the UXP Developer Tool before, remove it there so only the installed copy runs."
