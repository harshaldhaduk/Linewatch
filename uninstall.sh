#!/bin/bash
# PrizePicks Overlay — Uninstaller

PLIST="$HOME/Library/LaunchAgents/com.prizepicks.overlay.plist"

launchctl unload "$PLIST" 2>/dev/null
rm -f "$PLIST"

echo "✅ PrizePicks overlay removed from auto-start."
echo "   The app files are still in place — just delete the folder to fully remove."
