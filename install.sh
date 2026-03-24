#!/bin/bash
# PrizePicks Overlay — Auto-start installer

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$APP_DIR/node_modules/.bin/electron"
PLIST_NAME="com.prizepicks.overlay"
PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

# Install dependencies if needed
if [ ! -f "$ELECTRON" ]; then
  echo "Installing dependencies..."
  cd "$APP_DIR" && npm install
fi

# Remove quarantine from the whole folder
xattr -rd com.apple.quarantine "$APP_DIR" 2>/dev/null

# Unload any existing version
launchctl unload "$PLIST" 2>/dev/null
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null

# Write the Launch Agent plist
cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ELECTRON</string>
    <string>$APP_DIR</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$APP_DIR/out.log</string>
  <key>StandardErrorPath</key>
  <string>$APP_DIR/err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

# Load using GUI bootstrap (required for apps that show UI)
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl kickstart -k gui/$(id -u)/$PLIST_NAME

echo ""
echo "✅ PrizePicks overlay installed and starting now."
echo "   It will auto-start on every login. Terminal can be closed."
echo ""
echo "   Quit:        right-click dots in menu bar → Quit"
echo "   Update cookie: bash $APP_DIR/update-cookie.sh"
echo "   Uninstall:   bash $APP_DIR/uninstall.sh"
