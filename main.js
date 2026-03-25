const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');

// ── ACCOUNTS (labels only — cookies loaded from .saved_cookies.json) ─────────
const ACCOUNTS = [
  { label: 'Acc 1' },
  { label: 'Acc 2' },
];

const REFRESH_MS     = 25000;
const COOKIE_FILE    = path.join(__dirname, '.cookie_update');
const SAVED_FILE     = path.join(__dirname, '.saved_cookies.json');
const AUTO_COOKIE_PY = path.join(__dirname, 'auto-cookie.py');

let tray         = null;
let popupWin     = null;
let floatWin     = null;
let floatMode    = false;
let activeAccount = 0;
let reauthing    = false;
let lastReauth   = 0;

let accountEntries = ACCOUNTS.map(() => []);
let accountErrors  = ACCOUNTS.map(() => null);
let accountCookies = ACCOUNTS.map(() => '');

// ── Load saved cookies ────────────────────────────────────────────────────────
function loadSaved() {
  try {
    if (fs.existsSync(SAVED_FILE)) {
      const d = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
      if (Array.isArray(d)) {
        d.forEach((c, i) => { if (c && i < accountCookies.length) accountCookies[i] = c; });
      }
    }
  } catch(e) { console.log('loadSaved error:', e.message); }
}
loadSaved();

// ── Poll for cookie updates from auto-cookie.py ───────────────────────────────
setInterval(() => {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      if (raw) {
        fs.unlinkSync(COOKIE_FILE);
        try {
          const parsed = JSON.parse(raw);
          if (parsed.cookie && parsed.account != null) {
            accountCookies[parsed.account] = parsed.cookie;
            doRefresh(parsed.account);
          }
        } catch(e) {
          accountCookies[0] = raw;
          doRefresh(0);
        }
      }
    }
  } catch(e) {}
}, 2000);

// ── Auto re-extract cookies ───────────────────────────────────────────────────
function runAutoCookie() {
  if (reauthing) return;
  reauthing = true;
  lastReauth = Date.now();
  console.log('[auto-cookie] Running auto-cookie.py...');
  execFile('python3', [AUTO_COOKIE_PY], { timeout: 30000 }, (err, stdout, stderr) => {
    reauthing = false;
    if (err) {
      console.log('[auto-cookie] Error:', err.message);
    } else {
      console.log('[auto-cookie] Success:', stdout.trim());
      loadSaved();
      ACCOUNTS.forEach((_, i) => doRefresh(i));
    }
    updateTray();
  });
}

// Re-extract every 30 minutes proactively
setInterval(() => runAutoCookie(), 30 * 60 * 1000);

// ── Fetch picks ───────────────────────────────────────────────────────────────
function fetchPicks(idx) {
  const cookie = accountCookies[idx];
  if (!cookie) return Promise.reject(new Error('no_cookie'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.prizepicks.com',
      path: '/v1/entries?filter=pending',
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'cookie': cookie,
        'origin': 'https://app.prizepicks.com',
        'referer': 'https://app.prizepicks.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
        'x-device-info': 'name=,os=mac,platform=web,stateCode=TX',
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('auth_expired'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('parse_error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
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
      const gameStatus    = meta.status || '';
      const gameFinished  = ['complete','closed','final','finished','ended'].includes(gameStatus);
      const scoreRef   = (pr.score || {}).data || {};
      const scoreObj   = get('score', scoreRef.id);
      const scoreAttrs = scoreObj.attributes || {};
      const totals     = (scoreAttrs.details || {}).Totals || {};
      const isFinal    = scoreAttrs.is_final || false;
      const statMap    = { 'Points':'Points','Assists':'Assists','Rebounds':'Rebounds','3-PT Made':'ThreePointersMade','Blocked Shots':'BlockedShots','Steals':'Steals','Turnovers':'Turnovers','Fantasy Score':'FantasyScore' };
      let cur = totals[statMap[statName]];
      if (cur == null && scoreAttrs.score != null) cur = scoreAttrs.score;
      if (cur == null) cur = pa.initial_score;
      const gameFinishedFinal = gameFinished || isFinal;
      let result = (pa.result || 'pending').toLowerCase();
      if ((result === 'pending' || !result) && cur != null && line != null) {
        const c = parseFloat(cur), l = parseFloat(line);
        if (gameFinishedFinal) {
          result = wagerType === 'over' ? (c > l ? 'won' : 'lost') : (c < l ? 'won' : 'lost');
        } else if (inGame) {
          result = wagerType === 'over' ? (c >= l ? 'winning' : 'pending') : (c <= l ? 'winning' : 'pending');
        }
      }
      return { name, pos, league, imgUrl, statName, line, wagerType, oddsType, current: cur, inGame, gameFinished: gameFinishedFinal, result, clock, period, punit, awayAbb, homeAbb, awaySc, homeSc };
    });

    const won  = picks.filter(p => ['won','correct','win'].includes(p.result)).length;
    const lost = picks.filter(p => ['lost','incorrect','loss'].includes(p.result)).length;
    const open = picks.length - won - lost;
    return { amount: `$${(a.amount_bet_cents||0)/100}`, payout: `$${((a.amount_to_win_cents||0)/100).toFixed(2)}`, picks, won, lost, open };
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function updateTray() {
  if (!tray) return;
  const entries  = accountEntries[activeAccount];
  const error    = accountErrors[activeAccount];
  const allPicks = entries.flatMap(e => e.picks);
  const tw = entries.reduce((s,e) => s+e.won,  0);
  const tl = entries.reduce((s,e) => s+e.lost, 0);
  const to = entries.reduce((s,e) => s+e.open, 0);
  if (reauthing) { tray.setTitle(' ↻ loading...'); return; }
  if (error) { tray.setTitle(' ⚠ cookie'); tray.setToolTip('Session expired'); }
  else if (!allPicks.length) { tray.setTitle(''); tray.setToolTip('PrizePicks'); }
  else { tray.setTitle(` ${tw}W  ${tl}L  ${to}O`); tray.setToolTip(`${ACCOUNTS[activeAccount].label} — ${allPicks.length} picks`); }
}

function sendPicksData(win) {
  if (!win) return;
  win.webContents.send('picks-data', {
    entries: accountEntries[activeAccount],
    error:   accountErrors[activeAccount],
    accounts: ACCOUNTS.map(a => a.label),
    activeAccount,
  });
}

// ── Windows ───────────────────────────────────────────────────────────────────
function createPopup() {
  popupWin = new BrowserWindow({
    width: 400, height: 560, show: false, frame: false, transparent: true,
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
  const W  = 400;
  const allPicks = accountEntries[activeAccount].flatMap(e => e.picks);
  const HEADER_H = 48;
  const ENTRY_H  = 40;
  const PICK_H   = 108;
  const MAX_PICKS = 3;
  const visiblePicks = Math.min(allPicks.length, MAX_PICKS);
  const numEntries = accountEntries[activeAccount].length;
  const H = HEADER_H + (numEntries * ENTRY_H) + (visiblePicks * PICK_H);
  let x = Math.round(tb.x + tb.width / 2 - W / 2);
  let y = Math.round(tb.y + tb.height + 4);
  x = Math.max(d.workArea.x, Math.min(x, d.workArea.x + d.workArea.width - W));
  // Set initial size, popup will report exact height via popup-height IPC
  popupWin.setBounds({ x, y, width: W, height: Math.max(H, 100) });
  // Store position for popup-height resizing
  popupWin._x = x; popupWin._y = y;
  sendPicksData(popupWin);
  popupWin.show();
  popupWin.focus();
}

function createFloat() {
  const d = screen.getPrimaryDisplay().workArea;
  floatWin = new BrowserWindow({
    width: 400, height: 500, x: d.x + d.width - 420, y: d.y + 60,
    frame: false, transparent: true, resizable: true, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  floatWin.setAlwaysOnTop(true, 'floating');
  floatWin.setVisibleOnAllWorkspaces(true);
  floatWin.loadFile('float.html');
  floatWin.on('closed', () => { floatWin = null; floatMode = false; });
}

function toggleFloat() {
  floatMode = !floatMode;
  if (floatMode) {
    if (popupWin) popupWin.hide();
    if (!floatWin) createFloat();
    else floatWin.show();
    setTimeout(() => { if (floatWin) sendPicksData(floatWin); }, 500);
  } else {
    if (floatWin) floatWin.hide();
  }
}

function switchAccount(idx) {
  if (idx < 0 || idx >= ACCOUNTS.length) return;
  activeAccount = idx;
  updateTray();
  if (popupWin && popupWin.isVisible()) {
    // Reset to a safe height first, then let popup report actual height
    const b = popupWin.getBounds();
    popupWin.setBounds({ ...b, height: 400 });
    sendPicksData(popupWin);
  }
  if (floatWin && floatWin.isVisible()) sendPicksData(floatWin);
}


// ── App init ──────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.dock.hide();
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(' ↻');
  tray.setToolTip('PrizePicks');
  tray.on('click', () => {
    if (popupWin && popupWin.isVisible()) {
      popupWin.hide();
    } else {
      showPopup();
    }
  });
  tray.on('right-click', () => {
    const m = Menu.buildFromTemplate([
      { label: 'Quit', click: () => app.quit() },
    ]);
    m.popup();
  });
  createPopup();
  ACCOUNTS.forEach((_, i) => doRefresh(i));
  setInterval(() => ACCOUNTS.forEach((_, i) => doRefresh(i)), REFRESH_MS);
  setInterval(() => runAutoCookie(), 30 * 60 * 1000);
});

app.on('window-all-closed', e => e.preventDefault());

// ── Refresh ───────────────────────────────────────────────────────────────────
async function doRefresh(idx) {
  try {
    const data = await fetchPicks(idx);
    accountEntries[idx] = parsePicks(data);
    accountErrors[idx]  = null;
  } catch(e) {
    accountErrors[idx] = e.message;
  }
  if (idx === activeAccount) {
    updateTray();
    if (popupWin && popupWin.isVisible()) sendPicksData(popupWin);
    if (floatWin  && floatWin.isVisible())  sendPicksData(floatWin);
  }
}

ipcMain.on('popup-height', (_, h) => {
  if (!popupWin) return;
  const b = popupWin.getBounds();
  popupWin.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.min(h, 560) });
});

ipcMain.on('float-height', (_, h) => {
  if (!floatWin) return;
  const b = floatWin.getBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const maxH = d.workArea.height - 40;
  floatWin.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.min(h, maxH) });
});
ipcMain.on('refresh',        () => ACCOUNTS.forEach((_, i) => doRefresh(i)));
ipcMain.on('hide',           () => popupWin && popupWin.hide());
ipcMain.on('toggle-float',   toggleFloat);
ipcMain.on('re-extract',     () => runAutoCookie());
ipcMain.on('switch-account', (_, idx) => switchAccount(idx));
