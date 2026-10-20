#!/bin/bash
PLIST="$HOME/Library/LaunchAgents/com.syncu.helper.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/Library/Application Support/Syncu"
echo "Syncu helper removed."
