const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');

const ACCOUNTS = [
  { label: 'Acc 1' },
  { label: 'Acc 2' },
];

const REFRESH_MS     = 25000;
const COOKIE_FILE    = path.join(__dirname, '.cookie_update');
const SAVED_FILE     = path.join(__dirname, '.saved_cookies.json');
const UD_TOKEN_FILE  = path.join(__dirname, '.ud_token.json');
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

function loadSaved() {
  try {
    if (fs.existsSync(SAVED_FILE)) {
      const d = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
      if (Array.isArray(d)) {
        d.forEach((c, i) => { if (c && i < accountCookies.length) accountCookies[i] = c; });
      }
    }
  } catch(e) {}
}
loadSaved();

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

setInterval(() => runAutoCookie(), 30 * 60 * 1000);

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
      const hasScores     = (gscore.away != null && gscore.home != null && (gscore.away > 0 || gscore.home > 0));
      const isActuallyLive = proja.in_game || (period && period > 0) || hasScores;
      const startTimeRaw = (game.attributes || {}).start_time || meta.start_time || '';
      let startTimeStr = '';
      if (startTimeRaw) {
        try {
          const d = new Date(startTimeRaw);
          startTimeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
        } catch(e) {}
      }
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
      const inGameFinal = isActuallyLive && !gameFinishedFinal;
      let result = (pa.result || 'pending').toLowerCase();
      if ((result === 'pending' || !result) && cur != null && line != null) {
        const c = parseFloat(cur), l = parseFloat(line);
        if (gameFinishedFinal) {
          result = wagerType === 'over' ? (c > l ? 'won' : 'lost') : (c < l ? 'won' : 'lost');
        } else if (inGame) {
          result = wagerType === 'over' ? (c >= l ? 'winning' : 'pending') : (c <= l ? 'winning' : 'pending');
        }
      }
      return { name, pos, league, imgUrl, statName, line, wagerType, oddsType, current: cur, inGame: inGameFinal, gameFinished: gameFinishedFinal, result, clock, period, punit, awayAbb, homeAbb, awaySc, homeSc, startTime: startTimeStr };
    });

    const won  = picks.filter(p => ['won','correct','win'].includes(p.result)).length;
    const lost = picks.filter(p => ['lost','incorrect','loss'].includes(p.result)).length;
    const open = picks.length - won - lost;
    return { amount: `$${(a.amount_bet_cents||0)/100}`, payout: `$${((a.amount_to_win_cents||0)/100).toFixed(2)}`, picks, won, lost, open };
  });
}

// ── Underdog Fantasy ─────────────────────────────────────────────────────────
let udTokenWin = null;

function extractUdTokenFromBrowser() {
  return new Promise(async (resolve) => {
    if (udTokenWin) { try { udTokenWin.destroy(); } catch(e) {} udTokenWin = null; }

    const { session } = require('electron');
    const os = require('os');
    const udSession = session.fromPartition('persist:underdog', { cache: false });

    const tmpCookieFile = path.join(os.tmpdir(), 'ud_cookies_tmp.json');
    try {
      const { execFileSync } = require('child_process');
      execFileSync('python3', [path.join(__dirname, 'ud-cookies.py'), tmpCookieFile], { timeout: 10000 });
      const cookies = JSON.parse(fs.readFileSync(tmpCookieFile, 'utf8'));
      fs.unlinkSync(tmpCookieFile);
      for (const c of cookies) {
        await udSession.cookies.set({
          url: `https://${c.domain.replace(/^\.+/, '')}`,
          name: c.name, value: c.value,
          domain: c.domain, path: c.path || '/',
          secure: c.secure, httpOnly: c.httpOnly,
        }).catch(() => {});
      }
      console.log('[underdog] Injected', cookies.length, 'cookies');
    } catch(e) {
      console.log('[underdog] Cookie injection error:', e.message);
    }

    udTokenWin = new BrowserWindow({
      show: false, width: 1, height: 1,
      focusable: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: udSession, backgroundThrottling: false },
    });

    udTokenWin.loadURL('https://app.underdogfantasy.com/live/pick-em');

    let resolved = false;
    const done = (token) => {
      if (resolved) return;
      resolved = true;
      if (udTokenWin) { try { udTokenWin.destroy(); } catch(e) {} udTokenWin = null; }
      resolve(token);
    };

    udTokenWin.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const token = await udTokenWin.webContents.executeJavaScript(`
            (function() {
              for (let i = 0; i < localStorage.length; i++) {
                const val = localStorage.getItem(localStorage.key(i));
                if (val && val.startsWith('eyJ') && val.split('.').length === 3) return val;
              }
              return null;
            })()`);
          done(token);
        } catch(e) { done(null); }
      }, 3000);
    });

    udTokenWin.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://api.underdogfantasy.com/*'] },
      (details, callback) => {
        const auth = Object.entries(details.requestHeaders).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
        if (auth && auth.startsWith('eyJ') && auth.length > 800) {
          fs.writeFileSync(UD_TOKEN_FILE, JSON.stringify({ token: auth }));
          console.log('[underdog] Token saved, length:', auth.length);
          done(auth);
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    setTimeout(() => done(null), 15000);
  });
}

async function refreshUdToken() {
  const token = await extractUdTokenFromBrowser();
  if (token) { console.log('[underdog] Token refreshed via browser'); return token; }
  console.log('[underdog] Failed to extract token');
  return null;
}

function getUdToken() {
  try {
    if (fs.existsSync(UD_TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(UD_TOKEN_FILE, 'utf8'));
      return d.token || null;
    }
  } catch(e) {}
  return null;
}

async function fetchUnderdogPicks() {
  let token = getUdToken();
  if (!token) {
    token = await refreshUdToken();
    if (!token) return Promise.reject(new Error('no_ud_token'));
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.underdogfantasy.com',
      path: '/v9/user/active_entry_slips?product=fantasy&product_experience_id=018e1234-5678-9abc-def0-123456789002',
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'authorization': token,
        'origin': 'https://app.underdogfantasy.com',
        'referer': 'https://app.underdogfantasy.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
        'client-type': 'web',
        'client-version': '20260326152314',
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('auth_expired'));
        if (res.statusCode !== 200) return reject(new Error(`UD HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('ud_parse_error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function parseUnderdogPicks(data) {
  const d = data.data || {};
  const players = {}, games = {}, ouLines = {}, ouOptions = {};
  (d.players || []).forEach(p => players[p.id] = p);
  (d.games || []).forEach(g => games[g.id] = g);
  (d.over_under_lines || []).forEach(l => ouLines[l.id] = l);
  (d.over_under_options || []).forEach(o => { ouOptions[o.id] = o; });

  const lineToOU = {};
  (d.over_unders || []).forEach(ou => {
    (d.over_under_lines || []).filter(l => l.over_under_id === ou.id).forEach(l => { lineToOU[l.id] = ou; });
  });

  const appToPlayer = {};
  (d.appearances || []).forEach(a => { appToPlayer[a.id] = a; });

  return (d.entry_slips || []).map(slip => {
    const fee = parseFloat(slip.fee || 0);
    const multiplier = parseFloat(slip.current_max_payout_multiplier || 0);
    const payout = (fee * multiplier).toFixed(2);

    const picks = (slip.selection_groups || []).flatMap(sg => {
      return (sg.selections || []).map(sel => {
        const opt = ouOptions[sel.option_id] || {};
        const line = ouLines[opt.over_under_line_id] || {};
        const ou = lineToOU[opt.over_under_line_id] || {};
        const appStat = ou.appearance_stat || {};
        const app = appToPlayer[appStat.appearance_id] || {};
        const player = players[app.player_id] || {};
        const game = games[sg.match_id] || {};

        const name = `${player.first_name || ''} ${player.last_name || ''}`.trim() || opt.selection_header || 'Player';
        const pos = player.position_name || '';
        const league = player.sport_id || game.sport_id || '';
        const imgUrl = player.image_url || '';
        const statName = appStat.display_stat || ou.title?.replace(/ O\/U$/, '').replace(/^.* /, '') || 'Stat';
        const lineVal = parseFloat(line.stat_value || 0);
        const wagerType = opt.choice === 'higher' ? 'over' : 'under';
        const cur = sel.actual_stat_value != null ? parseFloat(sel.actual_stat_value) : null;
        const result = sel.result || 'pending';
        const inPlay = sel.in_play || line.live_event || false;
        const gameStatus = (game.status || '').toLowerCase();
        const gameFinished = ['complete','closed','final','finished','ended','settled'].includes(gameStatus);
        const period = game.period || 0;
        const sportId = (player.sport_id || game.sport_id || '').toUpperCase();
        const punit = sportId === 'MLB' ? 'inning' : sportId === 'NHL' ? 'period' : 'quarter';
        const scheduled = game.scheduled_at || '';
        let startTime = '';
        if (scheduled) {
          try { startTime = new Date(scheduled).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }); } catch(e) {}
        }
        const titleParts = (game.abbreviated_title || '').split(' @ ');
        const awayAbb = titleParts[0] || '';
        const homeAbb = titleParts[1] || '';
        const matchTitle = game.short_title || game.abbreviated_title || '';
        const awaySc = game.away_team_score ?? '';
        const homeSc = game.home_team_score ?? '';
        const isActuallyLive = inPlay || (period > 0 && !gameFinished) || (!gameFinished && gameStatus === 'in_progress');

        return { name, pos, league, imgUrl, statName, line: lineVal, wagerType, oddsType: '', current: cur, inGame: isActuallyLive, gameFinished, result, clock: '', period, punit, awayAbb, homeAbb, awaySc, homeSc, startTime, matchTitle: matchTitle || '', source: 'underdog' };
      });
    });

    const won  = picks.filter(p => p.result === 'won').length;
    const lost = picks.filter(p => p.result === 'lost').length;
    const open = picks.length - won - lost;
    return { amount: `$${fee.toFixed(2)}`, payout: `$${payout}`, picks, won, lost, open, source: 'underdog' };
  });
}

// ── ESPN player status ────────────────────────────────────────────────────────
const espnGameCache = {};
const ESPN_SPORT_MAP = {
  'NBA': { sport: 'basketball', league: 'nba' },
  'NFL': { sport: 'football',   league: 'nfl' },
  'MLB': { sport: 'baseball',   league: 'mlb' },
  'NHL': { sport: 'hockey',     league: 'nhl' },
  'WNBA':{ sport: 'basketball', league: 'wnba' },
  'MLS': { sport: 'soccer',     league: 'usa.1' },
  'EPL': { sport: 'soccer',     league: 'eng.1' },
};

function espnFetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchEspnPlayerStatus(leagueUpper, awayAbb, homeAbb) {
  const key = `${awayAbb}-${homeAbb}-${leagueUpper}`;
  const cached = espnGameCache[key];
  if (cached && Date.now() - cached.ts < 90000) return cached.players;
  const sport = ESPN_SPORT_MAP[leagueUpper];
  if (!sport) return null;
  try {
    const sb = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.sport}/${sport.league}/scoreboard`);
    let eventId = null;
    for (const ev of (sb.events || [])) {
      const abbs = ((ev.competitions || [])[0]?.competitors || []).map(c => (c.team?.abbreviation || '').toUpperCase());
      if (abbs.includes(awayAbb.toUpperCase()) && abbs.includes(homeAbb.toUpperCase())) { eventId = ev.id; break; }
    }
    if (!eventId) return null;
    const bs = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.sport}/${sport.league}/summary?event=${eventId}`);
    const players = {};
    for (const team of (bs.boxscore?.players || [])) {
      for (const sg of (team.statistics || [])) {
        for (const athlete of (sg.athletes || [])) {
          const a = athlete.athlete || {};
          const lastName = (a.displayName || '').split(' ').slice(-1)[0].toLowerCase();
          const fullName = (a.displayName || '').toLowerCase();
          const active = athlete.active !== false;
          players[lastName] = active;
          players[fullName] = active;
        }
      }
    }
    espnGameCache[key] = { ts: Date.now(), players };
    return players;
  } catch(e) { return null; }
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
  else if (!allPicks.length) { tray.setTitle(''); tray.setToolTip('Linewatch'); }
  else { tray.setTitle(` ${tw}W  ${tl}L  ${to}O`); tray.setToolTip(`${ACCOUNTS[activeAccount].label} — ${allPicks.length} picks`); }
}

function sendPicksData(win) {
  if (!win) return;
  try {
    win.webContents.send('picks-data', {
      entries: accountEntries[activeAccount],
      error:   accountErrors[activeAccount],
      accounts: ACCOUNTS.map(a => a.label),
      activeAccount,
    });
  } catch(e) {}
}

// ── Windows ───────────────────────────────────────────────────────────────────
function createPopup() {
  popupWin = new BrowserWindow({
    width: 400, height: 560, show: false, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  popupWin.loadFile('popup.html');
  popupWin.webContents.on('did-finish-load', () => {
    if (popupWin && popupWin.isVisible()) sendPicksData(popupWin);
  });
  popupWin.on('blur', () => {
    // Delay hide to avoid hiding when Underdog window briefly steals focus
    setTimeout(() => {
      if (udTokenWin) return;
      if (popupWin && !popupWin.isFocused()) popupWin.hide();
    }, 200);
  });
}

function showPopup() {
  if (!popupWin) createPopup();
  const tb = tray.getBounds();
  const d  = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const W  = 400;
  const allPicks = accountEntries[activeAccount].flatMap(e => e.picks);
  const HEADER_H = 48, ENTRY_H = 40, PICK_H = 108, MAX_PICKS = 3;
  const visiblePicks = Math.min(allPicks.length, MAX_PICKS);
  const numEntries = accountEntries[activeAccount].length;
  const H = HEADER_H + (numEntries * ENTRY_H) + (visiblePicks * PICK_H);
  let x = Math.round(tb.x + tb.width / 2 - W / 2);
  let y = Math.round(tb.y + tb.height + 4);
  x = Math.max(d.workArea.x, Math.min(x, d.workArea.x + d.workArea.width - W));
  popupWin.setBounds({ x, y, width: W, height: Math.max(H, 100) });
  sendPicksData(popupWin);
  popupWin.show();
  popupWin.focus();
}

function createFloat() {
  const d = screen.getPrimaryDisplay().workArea;
  floatWin = new BrowserWindow({
    width: 400, height: 300, x: d.x + d.width - 420, y: d.y + 60,
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
  tray.setToolTip('Linewatch');
  tray.on('click', () => {
    if (popupWin && popupWin.isVisible()) { popupWin.hide(); } else { showPopup(); }
  });
  tray.on('right-click', () => {
    Menu.buildFromTemplate([{ label: 'Quit', click: () => app.quit() }]).popup();
  });
  setTimeout(() => refreshUdToken(), 5000);
  setInterval(() => refreshUdToken(), 8 * 60 * 1000);
  createPopup();
  ACCOUNTS.forEach((_, i) => doRefresh(i));
  setInterval(() => ACCOUNTS.forEach((_, i) => doRefresh(i)), REFRESH_MS);
  setInterval(() => runAutoCookie(), 30 * 60 * 1000);
});

app.on('window-all-closed', e => e.preventDefault());

// ── Refresh ───────────────────────────────────────────────────────────────────
async function doRefresh(idx) {
  let entries = [];
  let ppError = null;

  try {
    const data = await fetchPicks(idx);
    entries = parsePicks(data);
  } catch(e) {
    ppError = e.message;
  }

  if (idx === 0) {
    try {
      const udData = await fetchUnderdogPicks();
      const udEntries = parseUnderdogPicks(udData);
      entries = [...entries, ...udEntries];
    } catch(e) {
      if (e.message !== 'no_ud_token') console.log('[underdog]', e.message);
    }
  }

  accountErrors[idx] = (ppError && entries.length === 0) ? ppError : null;

  const SUPPORTED = ['NBA','NFL','MLB','NHL','WNBA','MLS','EPL'];
  const livePickGroups = entries.flatMap(e => e.picks).filter(p =>
    p.inGame && !p.gameFinished && SUPPORTED.includes(p.league?.toUpperCase()) && p.awayAbb && p.homeAbb
  );
  const gameKeys = [...new Set(livePickGroups.map(p => `${p.awayAbb}-${p.homeAbb}-${p.league?.toUpperCase()}`))];
  await Promise.all(gameKeys.map(async key => {
    const [away, home, league] = key.split('-');
    const status = await fetchEspnPlayerStatus(league, away, home);
    if (!status) return;
    for (const entry of entries) {
      for (const pick of entry.picks) {
        if (`${pick.awayAbb}-${pick.homeAbb}-${pick.league?.toUpperCase()}` === key) {
          const active = status[pick.name.split(' ').slice(-1)[0].toLowerCase()] ?? status[pick.name.toLowerCase()] ?? null;
          if (active === false) pick.playerOut = true;
        }
      }
    }
  }));

  accountEntries[idx] = entries;

  if (idx === activeAccount) {
    updateTray();
    if (popupWin && popupWin.isVisible()) sendPicksData(popupWin);
    if (floatWin  && floatWin.isVisible())  sendPicksData(floatWin);
  }
}

ipcMain.on('popup-height', (_, h) => {
  if (!popupWin) return;
  const b = popupWin.getBounds();
  const MAX_H = 40 + 90 * 3 + 14; // header + up to 6 entries + 3 picks + padding
  popupWin.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.min(h, MAX_H) });
});

ipcMain.on('float-height', (_, h) => {
  if (!floatWin) return;
  const b = floatWin.getBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  floatWin.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.min(h, d.workArea.height - 40) });
});

ipcMain.on('refresh',        () => ACCOUNTS.forEach((_, i) => doRefresh(i)));
ipcMain.on('hide',           () => popupWin && popupWin.hide());
ipcMain.on('toggle-float',   toggleFloat);
ipcMain.on('re-extract',     () => runAutoCookie());
ipcMain.on('switch-account', (_, idx) => switchAccount(idx));
