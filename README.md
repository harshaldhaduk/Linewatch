# PrizePicks Overlay

A native macOS menu bar app showing your active PrizePicks picks.
Shows W/L/O count in the menu bar. Click for a popup, or toggle a floating window.

---

## Files

- main.js       — app logic
- popup.html    — tray click dropdown
- float.html    — draggable always-on-top window
- demo.html     — preview with fake picks (open in browser)
- install.sh    — sets up auto-start
- uninstall.sh  — removes auto-start
- update-cookie.sh — updates your session cookie

---

## First-Time Setup

### 1. Paste your cookie string
Open main.js in TextEdit, find COOKIE_STRING, replace PASTE_ENTIRE_COOKIE_STRING_HERE
with your full cookie string from PrizePicks DevTools (see Updating Cookies below).

### 2. Install dependencies
cd ~/Projects/prizepicks-overlay
npm install

### 3. Start the app
~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown

### 4. Set up auto-start (run once)
This makes it start automatically every time you open Terminal:
echo 'pgrep -qf "electron.*prizepicks" || (~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown)' >> ~/.zprofile

---

## Commands
Run these from anywhere.

### Start the app manually
~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown

### Quit the app
Right-click the menu bar text → Quit

Or from Terminal:
pkill -f "electron.*prizepicks"

### Update cookies (when you see "update cookie" in menu bar)
bash ~/Projects/prizepicks-overlay/update-cookie.sh

### Uninstall auto-start
bash ~/Projects/prizepicks-overlay/uninstall.sh
Then remove the line from ~/.zprofile:
sed -i '' '/prizepicks/d' ~/.zprofile

---

## Updating Cookies

When the menu bar shows "⚠ update cookie", your session has expired.

1. Open prizepicks.com in your browser and log in
2. Open DevTools: Cmd + Option + I → Network tab
3. Check "Disable cache" at the top
4. Hard refresh: Cmd + Shift + R
5. Filter by "entries", click the request
6. Under Request Headers, find the cookie: row
7. Right-click → Copy value
8. Run: bash ~/Projects/prizepicks-overlay/update-cookie.sh
9. A TextEdit window opens — paste your cookie, save (Cmd+S), close it
10. Go back to Terminal and press Enter

The app updates live without restarting.

---

## Using the App

### Menu bar
Shows: 2W  1L  3O  (wins, losses, open/live picks)
Shows nothing when you have no picks.
Shows "⚠ update cookie" when session is expired.

### Left-click → Popup
A dropdown shows all your picks with:
- Player photo with colored ring (green = won, red = lost, white = live)
- Live game score and clock
- Progress bar showing current stat vs line
- ↑/↓ direction with line number and stat type

Click ⧉ in the top right of the popup to toggle the floating window.

### Right-click → Menu
- Floating Window — toggle the always-on-top draggable window
- Refresh — force refresh now
- Quit

### Floating Window
An always-on-top panel that stays visible over all your other windows.
- Drag by the title bar to reposition
- Resize from any edge or corner
- Click the red dot (top left) to close it
- Shows the same pick info as the popup

---

## Dot Colors (popup header)
- Bright green dot = won
- Red dot          = lost
- Yellow pulsing   = live game in progress
- Grey             = not started

---

## Demo
Preview the UI without active picks — double-click demo.html in Finder
or open it in your browser.

---

## Notes
- The PrizePicks browser tab does NOT need to be open
- Refreshes automatically every 25 seconds
- Cookies typically last a few weeks
