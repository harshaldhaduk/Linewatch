#!/bin/bash
# PrizePicks — Update Cookie

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
COOKIE_FILE="$APP_DIR/.cookie_update"
SAVED_FILE="$APP_DIR/.saved_cookie"
TEMP_FILE="$APP_DIR/.cookie_paste.txt"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PrizePicks Cookie Updater"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. Open prizepicks.com → log in"
echo "  2. DevTools (Cmd+Option+I) → Network"
echo "  3. Check 'Disable cache', hard refresh (Cmd+Shift+R)"
echo "  4. Filter 'entries' → click request → Request Headers"
echo "  5. Right-click 'cookie:' → Copy value"
echo ""
echo "  TextEdit will open. Paste your cookie, save (Cmd+S), close it."
echo ""
read -p "  Press Enter to open TextEdit..."

echo "" > "$TEMP_FILE"
open -a TextEdit "$TEMP_FILE"

echo ""
read -p "  Done pasting and saving? Press Enter..."

if [ ! -f "$TEMP_FILE" ]; then
  echo "❌ File not found. Cancelled."
  exit 1
fi

NEW_COOKIE="$(cat "$TEMP_FILE" | tr -d '\n\r' | xargs)"
rm -f "$TEMP_FILE"

if [ -z "$NEW_COOKIE" ]; then
  echo "❌ Nothing was pasted. Cancelled."
  exit 1
fi

# Save permanently to file
echo "$NEW_COOKIE" > "$SAVED_FILE"

# Also signal running app to pick it up immediately
echo "$NEW_COOKIE" > "$COOKIE_FILE"

echo ""
echo "✅ Cookie saved and sent to app!"
echo "   It will persist across restarts automatically."
echo ""
