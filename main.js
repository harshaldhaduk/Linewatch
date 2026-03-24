const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');

// ── PASTE YOUR FULL COOKIE STRING HERE ──────────────────────────────────────
const COOKIE_STRING = `PASTE_ENTIRE_COOKIE_STRING_HERE`;
// ────────────────────────────────────────────────────────────────────────────

const REFRESH_MS = 25000;
const COOKIE_FILE = path.join(__dirname, '.cookie_update');

let tray      = null;
let popupWin  = null;  // dropdown from tray click
let floatWin  = null;  // always-on-top draggable window
let entries   = [];
let floatMode = false;

// ── Cookie ─────────────────────────────────────────────────────────────────
const SAVED_COOKIE_FILE = path.join(__dirname, '.saved_cookie');

// Load saved cookie from disk on startup (persists across restarts)
function loadSavedCookie() {
  try {
    if (fs.existsSync(SAVED_COOKIE_FILE)) {
      const c = fs.readFileSync(SAVED_COOKIE_FILE, 'utf8').trim();
      if (c) { global.LIVE_COOKIE = c; }
    }
  } catch(e) {}
}
loadSavedCookie();

function cookieStr() {
  return (global.LIVE_COOKIE || COOKIE_STRING).trim();
}

// Poll for cookie updates from update-cookie.sh
setInterval(() => {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const c = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      if (c) {
        global.LIVE_COOKIE = c;
        // Also persist to saved file
        fs.writeFileSync(SAVED_COOKIE_FILE, c);
        fs.unlinkSync(COOKIE_FILE);
        doRefresh();
      }
    }
  } catch(e) {}
}, 2000);

// ── Fetch ───────────────────────────────────────────────────────────────────
function fetchPicks() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.prizepicks.com',
      path: '/v1/entries?filter=pending',
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'cookie': cookieStr(),
        'origin': 'https://app.prizepicks.com',
        'referer': 'https://app.prizepicks.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
        'x-device-info': 'name=,os=mac,platform=web,stateCode=TX',
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Session expired'));
        if (res.statusCode === 403) return reject(new Error('Blocked (403)'));
        if (res.statusCode !== 200) return reject(new Error(`Error ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parsePicks(data) {
  const included = data.included || [];
  const inc = {};
  included.forEach(i => { inc[`${i.type}:${i.id}`] = i; });
  const get = (t, id) => inc[`${t}:${id}`] || {};

  return (data.data || []).map(entry => {
    const a = entry.attributes || {};
    const rels = entry.relationships || {};
    const predRefs = (rels.predictions || {}).data || [];

    const picks = predRefs.map(ref => {
      const pred = get('prediction', ref.id);
      const pa = pred.attributes || {};
      const pr = pred.relationships || {};

      const line      = pa.line_score;
      const wagerType = pa.wager_type || 'over';
      const oddsType  = pa.odds_type || '';

      const playerRef = (pr.new_player || {}).data || {};
      const player    = get('new_player', playerRef.id);
      const pla       = player.attributes || {};
      const name      = pla.display_name || pla.name || 'Player';
      const team      = pla.team || '';
      const pos       = pla.position || '';
      const league    = pla.league || '';
      const imgUrl    = pla.image_url || '';

      const projRef   = (pr.projection || {}).data || {};
      const proj      = get('projection', projRef.id);
      const proja     = proj.attributes || {};
      const statName  = proja.stat_type || proja.stat_display_name || 'Stat';
      const inGame    = proja.in_game || false;

      const gameRef   = ((proj.relationships || {}).game || {}).data || {};
      const game      = get('game', gameRef.id);
      const meta      = (game.attributes || {}).metadata || {};
      const gi        = meta.game_info || {};
      const clock     = gi.clock || '';
      const period    = gi.period || '';
      const punit     = ((gi.current_period || {}).unit) || 'quarter';
      const gscore    = gi.score || {};
      const teams     = gi.teams || {};
      const awayAbb   = (teams.away || {}).abbreviation || '';
      const homeAbb   = (teams.home || {}).abbreviation || '';
      const awaySc    = gscore.away ?? '';
      const homeSc    = gscore.home ?? '';
      const gameStatus   = meta.status || '';
      const gameFinished = ['complete','closed','final','finished','ended'].includes(gameStatus);

      const scoreRef  = (pr.score || {}).data || {};
      const scoreObj  = get('score', scoreRef.id);
      const totals    = ((scoreObj.attributes || {}).details || {}).Totals || {};
      const statMap   = {
        'Points':'Points','Assists':'Assists','Rebounds':'Rebounds',
        '3-PT Made':'ThreePointersMade','Blocked Shots':'BlockedShots',
        'Steals':'Steals','Turnovers':'Turnovers','Fantasy Score':'FantasyScore',
      };
      let cur = totals[statMap[statName]];
      if (cur == null) cur = pa.initial_score;

      let result = (pa.result || 'pending').toLowerCase();
      if ((result === 'pending' || !result) && cur != null && line != null) {
        const c = parseFloat(cur), l = parseFloat(line);
        if (gameFinished) {
          result = wagerType === 'over' ? (c > l ? 'won' : 'lost') : (c < l ? 'won' : 'lost');
        } else if (inGame) {
          result = wagerType === 'over' ? (c >= l ? 'winning' : 'pending') : (c <= l ? 'winning' : 'pending');
        }
      }

      return { name, team, pos, league, imgUrl, statName, line, wagerType, oddsType,
               current: cur, inGame, gameFinished, result, clock, period, punit,
               awayAbb, homeAbb, awaySc, homeSc };
    });

    const won  = picks.filter(p => ['won','correct','win'].includes(p.result)).length;
    const lost = picks.filter(p => ['lost','incorrect','loss'].includes(p.result)).length;
    const open = picks.length - won - lost;

    return {
      amount: `$${(a.amount_bet_cents || 0) / 100}`,
      payout: `$${((a.amount_to_win_cents || 0) / 100).toFixed(2)}`,
      picks, won, lost, open
    };
  });
}

// ── Tray title ──────────────────────────────────────────────────────────────
function updateTray(err) {
  if (!tray) return;
  const allPicks = entries.flatMap(e => e.picks);
  const totalWon  = entries.reduce((s,e) => s + e.won,  0);
  const totalLost = entries.reduce((s,e) => s + e.lost, 0);
  const totalOpen = entries.reduce((s,e) => s + e.open, 0);

  if (err) {
    tray.setTitle(' ⚠ update cookie');
    tray.setToolTip('PrizePicks — session expired');
  } else if (!allPicks.length) {
    tray.setTitle('');
    tray.setToolTip('PrizePicks');
  } else {
    tray.setTitle(` ${totalWon}W  ${totalLost}L  ${totalOpen}O`);
    tray.setToolTip(`PrizePicks — ${allPicks.length} picks`);
  }
}

// ── Popup window (tray dropdown) ────────────────────────────────────────────
function createPopup() {
  popupWin = new BrowserWindow({
    width: 380, height: 520,
    show: false, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  popupWin.loadFile('popup.html');
  popupWin.on('blur', () => popupWin && popupWin.hide());
}

function showPopup() {
  if (!popupWin) createPopup();
  const tb = tray.getBounds();
  const d  = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const W  = 380;
  const allPicks = entries.flatMap(e => e.picks);
  const H  = Math.min(allPicks.length * 100 + entries.length * 48 + 24, 520);
  let x = Math.round(tb.x + tb.width / 2 - W / 2);
  let y = Math.round(tb.y + tb.height + 4);
  x = Math.max(d.workArea.x, Math.min(x, d.workArea.x + d.workArea.width - W));
  popupWin.setBounds({ x, y, width: W, height: Math.max(H, 120) });
  popupWin.webContents.send('picks-data', { entries, error: null });
  popupWin.show();
  popupWin.focus();
}

// ── Float window (always-on-top draggable) ──────────────────────────────────
function createFloat() {
  const d  = screen.getPrimaryDisplay().workArea;
  floatWin = new BrowserWindow({
    width: 380, height: 480,
    x: d.x + d.width - 400, y: d.y + 60,
    frame: false, transparent: true,
    resizable: true, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  floatWin.setAlwaysOnTop(true, 'floating');
  floatWin.setVisibleOnAllWorkspaces(true);
  floatWin.loadFile('float.html');
  floatWin.on('closed', () => {
    floatWin  = null;
    floatMode = false;
    updateTrayMenu();
  });
}

function toggleFloat() {
  floatMode = !floatMode;
  if (floatMode) {
    if (popupWin) popupWin.hide();
    if (!floatWin) createFloat();
    else floatWin.show();
    floatWin.webContents.send('picks-data', { entries, error: null });
  } else {
    if (floatWin) floatWin.hide();
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: floatMode ? '✓ Floating Window' : 'Floating Window', click: toggleFloat },
    { type: 'separator' },
    { label: '↻ Refresh', click: doRefresh },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

// ── App init ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.dock.hide();

  const img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setTitle('');
  tray.setToolTip('PrizePicks');

  tray.on('click', showPopup);
  updateTrayMenu();
  tray.on('right-click', () => tray.popUpContextMenu());

  createPopup();
  doRefresh();
  setInterval(doRefresh, REFRESH_MS);
});

app.on('window-all-closed', e => e.preventDefault());

// ── Refresh ─────────────────────────────────────────────────────────────────
async function doRefresh() {
  try {
    const data = await fetchPicks();
    entries = parsePicks(data);
    updateTray(null);
    const payload = { entries, error: null };
    if (popupWin && popupWin.isVisible()) popupWin.webContents.send('picks-data', payload);
    if (floatWin  && floatWin.isVisible())  floatWin.webContents.send('picks-data', payload);
  } catch(e) {
    updateTray(e.message);
    const payload = { entries: [], error: e.message };
    if (popupWin && popupWin.isVisible()) popupWin.webContents.send('picks-data', payload);
    if (floatWin  && floatWin.isVisible())  floatWin.webContents.send('picks-data', payload);
  }
}

ipcMain.on('refresh', doRefresh);
ipcMain.on('hide',    () => popupWin && popupWin.hide());
ipcMain.on('toggle-float', toggleFloat);
