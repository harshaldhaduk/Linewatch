# Linewatch

macOS menu bar app that tracks your active PrizePicks and Underdog Fantasy picks in real time as live text (`2W 1L 3O`). Click to see a popup with player photos, live scores, and progress bars. Supports 2 PrizePicks accounts and auto-fetches Underdog picks.

---

## How It Works

- Reads cookies directly from your Edge browser profiles (no manual copy-paste)
- Fetches Underdog Fantasy picks automatically using a hidden browser session
- Re-extracts cookies and tokens every 30 minutes in the background
- Auto-starts every time you open a Terminal window
- Hidden from menu bar when you have no active picks

---

## First-Time Setup

### 1. Log into PrizePicks in Edge
- **Default Edge profile** → log into Account 1 at prizepicks.com
- **Second Edge profile** (Edge → click profile pic → Add profile) → log into Account 2

### 2. Log into Underdog Fantasy in Edge
- In your **Default Edge profile** → log into underdogfantasy.com
- Underdog token is extracted automatically when the app starts

### 3. Extract cookies and start the app
```
python3 ~/Projects/linewatch/auto-cookie.py
~/Projects/linewatch/node_modules/.bin/electron ~/Projects/linewatch >> ~/Projects/linewatch/err.log 2>&1 & disown
```

### 4. Set up auto-start (one time)
```
echo 'pgrep -qf "electron.*linewatch" || (~/Projects/linewatch/node_modules/.bin/electron ~/Projects/linewatch >> ~/Projects/linewatch/err.log 2>&1 & disown)' >> ~/.zprofile
```

After this, the app starts automatically every time you open Terminal.

---

## Common Commands

### Restart the app + refresh cookies (use to fix Auth Expired)
```
python3 ~/Projects/linewatch/auto-cookie.py && pkill -f "electron.*linewatch" 2>/dev/null; ~/Projects/linewatch/node_modules/.bin/electron ~/Projects/linewatch >> ~/Projects/linewatch/err.log 2>&1 & disown
```

### Start the app (if not running)
```
~/Projects/linewatch/node_modules/.bin/electron ~/Projects/linewatch >> ~/Projects/linewatch/err.log 2>&1 & disown
```

### Quit the app
```
pkill -f "electron.*linewatch"
```

### Check if it's running
```
pgrep -a electron
```

### Refresh cookies only (without restarting)
```
python3 ~/Projects/linewatch/auto-cookie.py
```

### Remove auto-start
```
sed -i '' '/linewatch/d' ~/.zprofile
```

---

## Using the App

**Menu bar** shows `2W 1L 3O` (wins / losses / open picks) when you have active picks. Nothing shows when you have no picks.

**Left click** the text → opens the popup dropdown

**Click again** → closes the popup

**Right click** → Quit

**Inside the popup:**
- `‹ Acc 1 ›` — switch between PrizePicks accounts
- `⧉` button — toggle the floating window
- `↻` button — force refresh
- Pick rows show player photo, live score, progress bar, line
- Click any pick → opens ESPN (NBA/MLB etc.) or GosuGamers (esports) for that game

**Floating window** — always on top, draggable, resizable. Same info as popup but stays visible while you do other things.

---

## Pick Colors

| Avatar ring | Progress bar | Meaning |
|-------------|--------------|---------|
| Green       | Green        | Game live, currently beating the line (over) |
| Green       | Green        | Game over — won |
| White pulse | White        | Game live, under pick in progress |
| Red         | Red          | Game over — lost, or under pick mathematically busted |
| None        | Grey         | Game not started yet |

---

## Sportsbooks

**PrizePicks** — Acc 1 = Default Edge profile, Acc 2 = Profile 1 (second Edge profile). Switch between accounts using the `‹ Acc 1 ›` switcher.

**Underdog Fantasy** — automatically combined with Acc 1 picks. Logs in using the same Default Edge profile session. No separate setup needed beyond being logged into underdogfantasy.com in Edge.

---

## When Cookies/Tokens Expire

You'll see `⚠ cookie` in the menu bar when PrizePicks auth expires (every few weeks).

For Underdog, the token refreshes automatically every 8 minutes in the background.

Fix for PrizePicks: make sure you're still logged into prizepicks.com in each Edge profile, then run the restart command above.

---

## Files

| File | Purpose |
|------|---------|
| `main.js` | App logic, API calls, tray |
| `popup.html` | Dropdown from menu bar click |
| `float.html` | Draggable always-on-top window |
| `auto-cookie.py` | Reads PrizePicks cookies from Edge profiles |
| `ud-cookies.py` | Reads Underdog cookies from Edge for token injection |
| `.saved_cookies.json` | Saved PrizePicks cookies (auto-managed, don't edit) |
| `.ud_token.json` | Saved Underdog Bearer token (auto-managed, don't edit) |
| `.ud_creds.json` | Underdog credentials if using password auth (gitignored) |
| `err.log` | App logs for debugging |

---

## Project Location

```
~/Projects/linewatch/
```

Do not move this folder — the auto-start line in `~/.zprofile` points to this path.
