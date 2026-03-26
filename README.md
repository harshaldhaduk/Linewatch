# Linewatch

macOS menu bar app that shows your active PrizePicks picks as live text (`2W 1L 3O`).
Click to see a popup with player photos, live scores, and progress bars. Supports 2 accounts.

---

## How It Works

- Reads cookies directly from your Edge browser profiles (no manual copy-paste)
- Re-extracts cookies automatically every 30 minutes in the background
- Auto-starts every time you open a Terminal window
- Hidden from menu bar when you have no active picks

---

## First-Time Setup

### 1. Log into PrizePicks in Edge
- **Default Edge profile** → log into Account 1 at prizepicks.com
- **Second Edge profile** (Edge → click profile pic → Add profile) → log into Account 2

### 2. Extract cookies and start the app
```
python3 ~/Projects/prizepicks-overlay/auto-cookie.py
~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown
```

### 3. Set up auto-start (one time)
```
echo 'pgrep -qf "electron.*prizepicks" || (~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown)' >> ~/.zprofile
```

After this, the app starts automatically every time you open Terminal.

---

## Common Commands

### Restart the app
```
pkill -f "electron.*prizepicks" 2>/dev/null
~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown
```

### Start the app (if not running)
```
~/Projects/prizepicks-overlay/node_modules/.bin/electron ~/Projects/prizepicks-overlay & disown
```

### Quit the app
```
pkill -f "electron.*prizepicks"
```

### Check if it's running
```
pgrep -a electron
```

### Refresh cookies only (without restarting)
```
python3 ~/Projects/prizepicks-overlay/auto-cookie.py
```

### Remove auto-start
```
sed -i '' '/prizepicks/d' ~/.zprofile
```

---

## Using the App

**Menu bar** shows `2W 1L 3O` (wins / losses / open picks) when you have active picks. Nothing shows when you have no picks.

**Left click** the text → opens the popup dropdown

**Click again** → closes the popup

**Right click** → Quit

**Inside the popup:**
- `‹ Acc 1 ›` — switch between accounts
- `⧉` button — toggle the floating window
- `↻` button — force refresh
- Pick rows show player photo, live score, progress bar, line

**Floating window** — always on top, draggable, resizable. Same info as popup but stays visible while you do other things.

---

## Pick Colors

| Avatar ring | Progress bar | Meaning |
|-------------|--------------|---------|
| Green       | Green        | Game live, currently beating the line |
| Green       | Green        | Game over — won |
| White pulse | White        | Game live, currently under the line |
| Red         | Red          | Game over — lost |
| None        | Grey         | Game not started yet |

---

## Two Accounts

Account 1 = Default Edge profile
Account 2 = Profile 1 (second Edge profile)

To set up Account 2: open Edge → click your profile picture → Add profile → log into your second PrizePicks account there → run the cookie script.

Switch between accounts using the `‹ Acc 1 ›` switcher in the popup.

---

## When Cookies Expire

Cookies last several weeks. When they expire you'll see "⚠ cookie" in the menu bar.

Fix: make sure you're still logged into prizepicks.com in each Edge profile, then run:
```
python3 ~/Projects/prizepicks-overlay/auto-cookie.py
```

The app picks up new cookies within 2 seconds without restarting.

---

## Files

| File | Purpose |
|------|---------|
| `main.js` | App logic, API calls, tray |
| `popup.html` | Dropdown from menu bar click |
| `float.html` | Draggable always-on-top window |
| `auto-cookie.py` | Reads cookies from Edge profiles |
| `update-cookie.sh` | Wrapper script for auto-cookie.py |
| `.saved_cookies.json` | Saved cookies (auto-managed, don't edit) |
| `demo.html` | Preview with fake picks — open in browser |

---

## Project Location

```
~/Projects/prizepicks-overlay/
```

Do not move this folder — the auto-start line in `~/.zprofile` points to this path.
