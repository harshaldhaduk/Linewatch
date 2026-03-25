#!/bin/bash
# PrizePicks — Update Cookies (auto-extracts from Edge)
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
python3 "$APP_DIR/auto-cookie.py"
