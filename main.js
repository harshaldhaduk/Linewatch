const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
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
const UD_AUTH_STATE_FILE = path.join(__dirname, '.ud_auth_state.json');
const ONYX_TOKEN_FILE = path.join(__dirname, '.onyx_token.json');
const CHALKBOARD_TOKEN_FILE = path.join(__dirname, '.chalkboard_token.json');
const AUTO_COOKIE_PY = path.join(__dirname, 'auto-cookie.py');
const LIVE_API_PORT  = 37119;

let tray         = null;
let popupWin     = null;
let floatWin     = null;
let tooltipWin   = null;
let onyxBetsWin  = null;
let onyxBetsCache = { ts: 0, entries: [] };
let liveApiServer = null;
let floatMode    = false;
let activeAccount = 0;
let reauthing    = false;
let lastReauth   = 0;

let accountEntries = ACCOUNTS.map(() => []);
let accountErrors  = ACCOUNTS.map(() => null);
let accountCookies = ACCOUNTS.map(() => '');
let historyCache = { ts: 0, entries: [], error: null };

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

function fetchPicks(idx, filter = 'pending') {
  const cookie = accountCookies[idx];
  if (!cookie) return Promise.reject(new Error('no_cookie'));
  const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.prizepicks.com',
      path: `/v1/entries${qs}`,
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
  const topPrizePicksMultiplier = attrs => {
    const direct = attrs.payout_multipliers && Object.values(attrs.payout_multipliers)[0];
    if (direct != null && Number.isFinite(Number(direct)) && Number(direct) > 0) return Number(direct);
    const nested = attrs.full_payout_multipliers?.[0]?.[0];
    if (nested != null && Number.isFinite(Number(nested)) && Number(nested) > 0) return Number(nested);
    return null;
  };

  return (data.data || []).map(entry => {
    const a = entry.attributes || {};
    const rels = entry.relationships || {};
    const predRefs = (rels.predictions || rels.picks || rels.pick_entries || rels.legs || rels.selections || {}).data || [];
    const inlinePicks = Array.isArray(a.picks) ? a.picks
      : Array.isArray(a.legs) ? a.legs
      : Array.isArray(a.selections) ? a.selections
      : null;

    const mapInlinePick = (p) => {
      const name = p.player_name || p.playerName || p.player?.name || p.name || p.team_name || p.teamName
        || p.team?.name || p.team || 'Team';
      const statName = p.stat_type || p.statType || p.stat_display_name || p.statDisplayName
        || p.stat || p.market || p.projection_type || p.projectionType || 'Stat';
      const line = p.line_score ?? p.line ?? p.value ?? p.total ?? p.projection ?? '';
      let wagerType = p.wager_type || p.wagerType || p.pick_type || p.pickType || p.direction || '';
      if (!wagerType) {
        const sel = String(p.selection || p.pick || p.choice || '').toLowerCase();
        if (/under|lower|less/.test(sel)) wagerType = 'under';
        else if (/over|higher|more/.test(sel)) wagerType = 'over';
        else wagerType = 'over';
      }
      const league = p.league || p.sport || p.sport_id || '';
      const imgUrl = p.image_url || p.imageUrl || p.photo || '';
      const result = String(p.result || p.status || '').toLowerCase() || 'pending';
      return {
        name,
        pos: p.position || p.pos || '',
        league,
        imgUrl,
        statName,
        line,
        wagerType,
        oddsType: p.odds_type || p.oddsType || '',
        current: p.score ?? p.current ?? null,
        inGame: !!p.in_game,
        gameFinished: !!p.game_finished,
        result,
        clock: p.clock || '',
        period: p.period || '',
        punit: p.period_unit || p.punit || 'quarter',
        awayAbb: p.away_abbr || p.awayAbb || '',
        homeAbb: p.home_abbr || p.homeAbb || '',
        awaySc: p.away_score ?? p.awaySc ?? '',
        homeSc: p.home_score ?? p.homeSc ?? '',
        startTime: p.start_time || p.startTime || '',
      };
    };

    const picks = predRefs.length ? predRefs.map(ref => {
      const pred = get(ref.type || 'prediction', ref.id) || get('prediction', ref.id);
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
    }) : (inlinePicks || []).map(mapInlinePick);

    const won  = picks.filter(p => ['won','correct','win'].includes(p.result)).length;
    const lost = picks.filter(p => ['lost','incorrect','loss'].includes(p.result)).length;
    const open = picks.length - won - lost;
    const stakeCents = a.amount_bet_cents ?? a.entry_fee_cents ?? a.entryFeeCents ?? a.amount_cents ?? 0;
    const freeFlag = !!(
      a.free_entry || a.free_bet || a.risk_free || a.is_free_entry || a.is_free ||
      a.promo_tag || a.f2p
    );
    const isFreeBet = stakeCents === 0 || freeFlag;
    const possiblePayoutCents = a.amount_to_win_cents || 0;
    const rawEntryResult = `${a.result || ''} ${a.status || ''} ${a.display_result || ''} ${a.settled_message || ''}`.toLowerCase();
    const cancelledEntry = /cancel/.test(rawEntryResult);
    const cashedOutEntry = /cash/.test(rawEntryResult);
    const refundedEntry = /refund|void|reboot|push/.test(rawEntryResult) || cancelledEntry;
    const refundPayoutCents = a.refund_amount_cents ?? a.refunded_amount_cents;
    const amountWonCents = a.amount_won_cents ?? a.winnings_cents ?? a.net_winnings_cents ?? a.profit_cents;
    const promoStakeCents = stakeCents === 0 && a.promo_tag
      ? Math.round(((a.amount_to_win_cents || 0) / (topPrizePicksMultiplier(a) || 1)))
      : 0;
    const computedPayoutCents = amountWonCents != null ? amountWonCents : null;
    const rawActualPayoutCents = refundedEntry
      ? (refundPayoutCents ?? stakeCents)
      : a.payout_cents ?? a.paid_out_amount_cents ?? a.total_payout_cents
        ?? a.payout_amount_cents ?? a.cashout_amount_cents ?? a.cash_out_amount_cents
        ?? computedPayoutCents ?? amountWonCents ?? refundPayoutCents;
    const lostEntry = !refundedEntry && !cashedOutEntry && (/\b(lost|loss)\b/.test(rawEntryResult) || lost > 0);
    const wonEntry = !refundedEntry && !cashedOutEntry && !lostEntry && (/\b(won|win)\b/.test(rawEntryResult) || won > 0);
    const actualPayoutCents = rawActualPayoutCents != null
      ? (promoStakeCents > 0 && rawActualPayoutCents > 0 ? rawActualPayoutCents + promoStakeCents : rawActualPayoutCents)
      : open > 0
        ? null
        : lostEntry
          ? 0
          : refundedEntry
            ? stakeCents
          : wonEntry
            ? possiblePayoutCents
            : stakeCents;
    const derivedResult = refundedEntry
      ? 'refund'
      : cashedOutEntry
        ? 'cash out'
        : wonEntry
          ? 'won'
          : lostEntry
            ? 'lost'
            : open > 0
              ? 'pending'
              : '';
    const derivedDisplay = refundedEntry
      ? 'Refunded'
      : cashedOutEntry
        ? 'Cashed Out'
        : wonEntry
          ? 'Won'
          : lostEntry
            ? 'Lost'
            : open > 0
              ? 'Pending'
              : '';
    const rawDate = a.settled_at || a.resolved_at || a.updated_at || a.created_at || a.createdAt || '';
    const date = rawDate ? String(rawDate).slice(0, 10) : '';
    const entryId = entry.id || '';
    return {
      id: `prizepicks-${entryId}`,
      date,
      amount: `$${((isFreeBet ? 0 : stakeCents)/100).toFixed(2)}`,
      originalAmount: `$${(stakeCents/100).toFixed(2)}`,
      payout: `$${((a.amount_to_win_cents||0)/100).toFixed(2)}`,
      actualPayout: actualPayoutCents == null ? '' : `$${(actualPayoutCents/100).toFixed(2)}`,
      status: a.status || '',
      result: a.result || derivedResult || '',
      displayResult: a.display_result || derivedDisplay || '',
      settledMessage: a.settled_message || '',
      freeBet: isFreeBet,
      hiddenPromoStake: promoStakeCents > 0 ? `$${(promoStakeCents/100).toFixed(2)}` : '',
      promoTag: !!a.promo_tag,
      isGift: !!a.is_gift,
      f2p: !!a.f2p,
      picks, won, lost, open, source: 'prizepicks',
    };
  });
}

// ── Underdog Fantasy ─────────────────────────────────────────────────────────
let udTokenWin = null;

function underdogLoggedOutInBrowser() {
  try {
    if (!fs.existsSync(UD_AUTH_STATE_FILE)) return false;
    const state = JSON.parse(fs.readFileSync(UD_AUTH_STATE_FILE, 'utf8'));
    return state && state.loggedIn === false;
  } catch(e) {
    return false;
  }
}

function extractUdTokenFromBrowser() {
  return new Promise(async (resolve) => {
    if (underdogLoggedOutInBrowser()) {
      clearUdToken();
      console.log('[underdog] Browser logged out; skipping token capture');
      resolve(null);
      return;
    }
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
  if (underdogLoggedOutInBrowser()) {
    clearUdToken();
    return null;
  }
  const token = await extractUdTokenFromBrowser();
  if (token) { console.log('[underdog] Token refreshed via browser'); return token; }
  console.log('[underdog] Failed to extract token');
  return null;
}

function getUdToken() {
  if (underdogLoggedOutInBrowser()) {
    clearUdToken();
    return null;
  }
  try {
    if (fs.existsSync(UD_TOKEN_FILE)) {
      const d = JSON.parse(fs.readFileSync(UD_TOKEN_FILE, 'utf8'));
      return d.token || null;
    }
  } catch(e) {}
  return null;
}

function clearUdToken() {
  try {
    if (fs.existsSync(UD_TOKEN_FILE)) fs.unlinkSync(UD_TOKEN_FILE);
  } catch(e) {}
}

async function fetchUnderdogPicks() {
  return fetchUnderdogEntrySlips('/v9/user/active_entry_slips?product=fantasy&product_experience_id=018e1234-5678-9abc-def0-123456789002');
}

async function fetchUnderdogEntrySlips(pathname, retried = false) {
  let token = getUdToken();
  if (!token) {
    token = await refreshUdToken();
    if (!token) return Promise.reject(new Error('no_ud_token'));
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.underdogfantasy.com',
      path: pathname,
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
        if (res.statusCode === 401 || res.statusCode === 403) {
          clearUdToken();
          if (!retried) {
            fetchUnderdogEntrySlips(pathname, true).then(resolve).catch(reject);
            return;
          }
          return reject(new Error('auth_expired'));
        }
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

function parseMoneyAmount(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw || /^free$/i.test(raw)) return null;
  const parsed = parseFloat(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function centsToMoney(value) {
  const parsed = parseMoneyAmount(value);
  return parsed == null ? null : parsed / 100;
}

function firstMoneyAmount(...values) {
  for (const value of values) {
    const parsed = parseMoneyAmount(value);
    if (parsed != null && parsed > 0) return parsed;
  }
  return null;
}

function firstMoneyAmountIncludingZero(...values) {
  for (const value of values) {
    const parsed = parseMoneyAmount(value);
    if (parsed != null && parsed >= 0) return parsed;
  }
  return null;
}

function underdogEntryIsFree(slip) {
  const powerUpType = String(slip.power_up?.type || '').toLowerCase();
  const powerUpTag = String(slip.power_up?.display_tag || '').toLowerCase();
  const powerUpTitle = String(slip.power_up?.title || '').toLowerCase();
  const promoText = `${powerUpType} ${powerUpTag} ${powerUpTitle}`;
  const isBoostPromo = /\bboost\b|incremental_boost/.test(promoText);
  const isFreeFlagged = !!(slip.free_entry || slip.state_free_entry || slip.free_bet);
  const isBonusEntry = powerUpType === 'bonus_entry' || /bonus entry|free entry|gimme/.test(promoText);
  if ((isFreeFlagged || isBonusEntry) && !isBoostPromo) {
    return true;
  }

  const freeTextFields = [
    slip.entry, slip.entry_label, slip.entryLabel, slip.entry_display, slip.entryDisplay,
    slip.entry_type, slip.entryType, slip.entry_fee_label, slip.entryFeeLabel,
    slip.entry_fee_display, slip.entryFeeDisplay, slip.fee_label, slip.feeLabel,
    slip.fee_display, slip.feeDisplay, slip.display_fee, slip.displayFee,
  ];
  return freeTextFields.some(value => {
    if (value && typeof value === 'object') {
      return ['label', 'display', 'title', 'name', 'value'].some(k =>
        typeof value[k] === 'string' && /^\s*(entry\s*:?\s*)?free\s*$/i.test(value[k].trim())
      );
    }
    if (typeof value !== 'string') return false;
    return /^\s*(entry\s*:?\s*)?free\s*$/i.test(value.trim());
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

  const slips = d.entry_slips || d.user_entry_slips || d.slips || d.entries || [];
  return slips.map(slip => {
    const multiplier = parseMoneyAmount(slip.current_max_payout_multiplier) || 0;
    const maxPayoutRaw = firstMoneyAmount(
      slip.payout, slip.prize_max_payout, slip.boost_payout, slip.payout_amount,
      slip.payoutAmount, slip.max_payout, slip.maxPayout,
    );
    const maxPayout = maxPayoutRaw ?? 0;
    const explicitFee = firstMoneyAmount(
      slip.aggregate_fee, slip.aggregateFee,
      slip.fee, slip.entry_fee, slip.entryFee, slip.amount, slip.stake,
      slip.buy_in, slip.buyIn, slip.entry_amount, slip.entryAmount,
      slip.wager_amount, slip.wagerAmount, slip.risk, slip.risk_amount, slip.riskAmount,
      slip.paid_amount, slip.paidAmount, slip.amount_paid, slip.amountPaid,
      slip.original_fee, slip.originalFee, slip.original_entry_fee, slip.originalEntryFee,
      slip.entry_fee_before_promo, slip.entryFeeBeforePromo,
      slip.non_discounted_entry_fee, slip.nonDiscountedEntryFee,
      slip.base_entry_fee, slip.baseEntryFee,
      centsToMoney(slip.entry_fee_cents), centsToMoney(slip.entryFeeCents),
      centsToMoney(slip.fee_cents), centsToMoney(slip.feeCents),
      centsToMoney(slip.amount_cents), centsToMoney(slip.amountCents),
      centsToMoney(slip.stake_cents), centsToMoney(slip.stakeCents),
      centsToMoney(slip.original_entry_fee_cents), centsToMoney(slip.originalEntryFeeCents),
    );
    const inferredFee = explicitFee == null && maxPayout > 0 && multiplier > 0
      ? maxPayout / multiplier
      : null;
    const fee = explicitFee ?? inferredFee ?? 0;
    const freeLabel = underdogEntryIsFree(slip);
    const isFreeBet = freeLabel;
    if (isFreeBet && !slip.__loggedFree) {
      try {
        console.log('[underdog] free slip raw fields:', {
          id: slip.id,
          fee: slip.fee,
          entry_fee: slip.entry_fee,
          entry_fee_cents: slip.entry_fee_cents,
          entryFee: slip.entryFee,
          entryFeeCents: slip.entryFeeCents,
          fee_cents: slip.fee_cents,
          feeCents: slip.feeCents,
          amount: slip.amount,
          stake: slip.stake,
          free_entry: slip.free_entry,
          state_free_entry: slip.state_free_entry,
          free_bet: slip.free_bet,
          promo: slip.promo,
          power_up: slip.power_up,
        });
        slip.__loggedFree = true;
      } catch (e) {}
    }
    const displayPayout = maxPayout || (fee * multiplier) || 0;
    const displayResult = String(slip.display_result || slip.result || slip.status || '').toLowerCase();
    const isSettledSlip = displayResult.includes('settled') || displayResult.includes('won') || displayResult.includes('lost') ||
      displayResult.includes('refund') || displayResult.includes('void') || displayResult.includes('reboot') ||
      displayResult.includes('cancel') || displayResult.includes('cash') || !!slip.payout_at;
    const explicitActualPayout = firstMoneyAmountIncludingZero(
      slip.actual_payout, slip.actualPayout, slip.actual_payout_amount, slip.actualPayoutAmount,
      slip.paid_out, slip.paidOut, slip.paid_out_amount, slip.paidOutAmount,
      slip.settled_payout, slip.settledPayout, slip.final_payout, slip.finalPayout,
      slip.winnings, slip.amount_won, slip.amountWon,
      centsToMoney(slip.actual_payout_cents), centsToMoney(slip.actualPayoutCents),
      centsToMoney(slip.paid_out_cents), centsToMoney(slip.paidOutCents),
      centsToMoney(slip.settled_payout_cents), centsToMoney(slip.settledPayoutCents),
    );

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
        let result = String(sel.result || sel.outcome || sel.display_result || '').toLowerCase() || 'pending';
        if (['win','correct'].includes(result)) result = 'won';
        if (['loss','incorrect'].includes(result)) result = 'lost';
        if (['void','reboot','rebooted','refunded','refund'].includes(result)) result = 'void';
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
        const matchParts = matchTitle.split(' @ ');
        const awayName = matchParts[0] || '';
        const homeName = matchParts[1] || '';
        const awaySc = game.away_team_score ?? '';
        const homeSc = game.home_team_score ?? '';
        const isActuallyLive = inPlay || (period > 0 && !gameFinished) || (!gameFinished && gameStatus === 'in_progress');

        // Determine which team this spread/ML pick is for (used for logo display)
        const _ouTitle = (ou.title || '').trim();
        const _titleFirst = _ouTitle.split(/\s+/)[0].toUpperCase();
        const _selHead = (opt.selection_header || '').trim().toUpperCase();
        const _awayU = awayAbb.toUpperCase();
        const _homeU = homeAbb.toUpperCase();
        const _nameU = name.toUpperCase();
        const _awayNameU = awayName.toUpperCase();
        const _homeNameU = homeName.toUpperCase();
        const _matchToken = (tok) => tok && (
          tok === _awayU || tok.includes(_awayU) || _awayU.includes(tok)
        );
        const _matchHomeToken = (tok) => tok && (
          tok === _homeU || tok.includes(_homeU) || _homeU.includes(tok)
        );
        const _matchAwayName = (tok) => tok && _awayNameU && (tok === _awayNameU || tok.includes(_awayNameU) || _awayNameU.includes(tok));
        const _matchHomeName = (tok) => tok && _homeNameU && (tok === _homeNameU || tok.includes(_homeNameU) || _homeNameU.includes(tok));
        const teamAbb = (_matchAwayName(_nameU) && !_matchHomeName(_nameU)) ? awayAbb
                      : (_matchHomeName(_nameU) && !_matchAwayName(_nameU)) ? homeAbb
                      : (_matchAwayName(_selHead) && !_matchHomeName(_selHead)) ? awayAbb
                      : (_matchHomeName(_selHead) && !_matchAwayName(_selHead)) ? homeAbb
                      : (_matchAwayName(_titleFirst) && !_matchHomeName(_titleFirst)) ? awayAbb
                      : (_matchHomeName(_titleFirst) && !_matchAwayName(_titleFirst)) ? homeAbb
                      : (_matchToken(_titleFirst) && !_matchHomeToken(_titleFirst)) ? awayAbb
                      : (_matchHomeToken(_titleFirst) && !_matchToken(_titleFirst)) ? homeAbb
                      : (_matchToken(_selHead) && !_matchHomeToken(_selHead)) ? awayAbb
                      : (_matchHomeToken(_selHead) && !_matchToken(_selHead)) ? homeAbb
                      : '';

        return { name, pos, league, imgUrl, statName, line: lineVal, wagerType, oddsType: '', current: cur, inGame: isActuallyLive, gameFinished, result, clock: '', period, punit, awayAbb, homeAbb, awayName, homeName, awaySc, homeSc, startTime, matchTitle: matchTitle || '', source: 'underdog', teamAbb };
      });
    });

    let won  = picks.filter(p => p.result === 'won').length;
    let lost = picks.filter(p => p.result === 'lost').length;
    const voided = picks.filter(p => p.result === 'void').length;
    let open = picks.length - won - lost - voided;
    if (!open && !won && !lost && displayResult) {
      if (displayResult.includes('won')) won = picks.length || 1;
      else if (displayResult.includes('lost')) lost = picks.length || 1;
      else if (displayResult.includes('push') || displayResult.includes('void')) open = 0;
    }
    const cancelledSlip = /cancel/.test(displayResult);
    const cashedOutSlip = /cash/.test(displayResult);
    const refundedSlip = /refund|reboot|void|push/.test(displayResult) || cancelledSlip;
    const lostSlip = !refundedSlip && !cashedOutSlip && (displayResult.includes('lost') || displayResult.includes('loss') || (isSettledSlip && lost > 0));
    const wonSlip = !refundedSlip && !cashedOutSlip && !lostSlip && (displayResult.includes('won') || displayResult.includes('win') || won > 0);
    const usableExplicitActualPayout = wonSlip && explicitActualPayout === 0 && displayPayout > 0
      ? null
      : explicitActualPayout;
    const actualPayout = !isSettledSlip ? null
      : usableExplicitActualPayout != null ? usableExplicitActualPayout
      : cashedOutSlip ? displayPayout
      : lostSlip ? 0
      : refundedSlip ? fee
      : wonSlip ? displayPayout
      : null;
    const rawDate = slip.payout_at || slip.settled_at || slip.resolved_at || slip.updated_at || slip.created_at || slip.createdAt || slip.submitted_at || '';
    const date = rawDate ? String(rawDate).slice(0, 10) : '';
    return {
      id: `underdog-${slip.id || ''}`,
      date,
      amount: `$${(isFreeBet ? 0 : fee).toFixed(2)}`,
      originalAmount: `$${fee.toFixed(2)}`,
      payout: `$${displayPayout.toFixed(2)}`,
      actualPayout: actualPayout == null ? '' : `$${actualPayout.toFixed(2)}`,
      status: slip.status || '',
      result: slip.display_result || slip.result || '',
      displayResult: slip.display_result || '',
      settledMessage: slip.settled_message || '',
      freeBet: isFreeBet,
      picks, won, lost, open, source: 'underdog',
    };
  });
}

// ── Onyx Odds ─────────────────────────────────────────────────────────────────
function getOnyxToken() {
  try {
    if (fs.existsSync(ONYX_TOKEN_FILE)) return JSON.parse(fs.readFileSync(ONYX_TOKEN_FILE, 'utf8'));
  } catch(e) {}
  return null;
}

async function captureOnyxBets() {
  return new Promise(async (resolve) => {
    if (onyxBetsWin) { try { onyxBetsWin.destroy(); } catch(e) {} onyxBetsWin = null; }
    const { session: eSession } = require('electron');
    const onyxSession = eSession.fromPartition('persist:onyx', { cache: false });

    const savedToken = getOnyxToken();
    const sessionValid = !!(savedToken && savedToken.sessionValid);
    onyxBetsWin = new BrowserWindow({
      show: !sessionValid, width: 1280, height: 900, skipTaskbar: sessionValid,
      title: 'Onyx Odds – Log in to sync your bets',
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: onyxSession, backgroundThrottling: false },
    });

    let resolved = false, capturedAuth = null, capturedApiKey = null;
    const pending = {};

    const done = (result) => {
      if (resolved) return;
      resolved = true;
      try { onyxBetsWin.webContents.debugger.detach(); } catch(e) {}
      try { if (onyxBetsWin) { onyxBetsWin.destroy(); onyxBetsWin = null; } } catch(e) {}
      resolve(result);
    };

    try {
      onyxBetsWin.webContents.debugger.attach('1.3');
      await onyxBetsWin.webContents.debugger.sendCommand('Network.enable');

      onyxBetsWin.webContents.debugger.on('message', async (event, method, params) => {
        if (resolved || !onyxBetsWin) return;

        if (method === 'Network.requestWillBeSent') {
          const url = params.request.url;
          const hdrs = params.request.headers || {};
          const auth   = Object.entries(hdrs).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
          const apiKey = Object.entries(hdrs).find(([k]) => k.toLowerCase() === 'apikey')?.[1];
          if (auth && auth.length > 50) capturedAuth = auth;
          if (apiKey) capturedApiKey = apiKey;
          const isBets = (url.includes('onyxodds.com') || (capturedApiKey && url.includes('supabase.co')))
                      && /bet|pick|slip|wager|entry|parlay|leg/i.test(url);
          if (isBets) { pending[params.requestId] = url; console.log('[onyx] tracking:', url); }
        }

        if (method === 'Network.loadingFinished' && pending[params.requestId]) {
          try {
            const { body, base64Encoded } = await onyxBetsWin.webContents.debugger.sendCommand(
              'Network.getResponseBody', { requestId: params.requestId }
            );
            const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
            const parsed = JSON.parse(text);
            fs.writeFileSync(ONYX_TOKEN_FILE, JSON.stringify({ sessionValid: true }));
            done({ data: parsed });
          } catch(e) { console.log('[onyx] body capture error:', e.message); }
        }
      });
    } catch(e) { console.log('[onyx] CDP error:', e.message); }

    if (!onyxBetsWin) { done(null); return; }
    onyxBetsWin.on('closed', () => { onyxBetsWin = null; });
    onyxBetsWin.loadURL('https://app.onyxodds.com/my-bets');

    // Fallback: scrape token from localStorage after each page load settles.
    // When window is visible (first-time login), don't close after the login page —
    // keep waiting until the bets page loads and the API is captured.
    onyxBetsWin.webContents.on('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 3000));
      if (resolved || !onyxBetsWin) return;
      try {
        const currentUrl = onyxBetsWin.webContents.getURL();
        const onBetsPage = currentUrl.includes('/my-bets') && !currentUrl.includes('/login');
        const onLoginPage = currentUrl.includes('/login') || currentUrl.includes('/create-account');
        if (onLoginPage) {
          // Session expired — mark invalid so next open shows the window
          try { fs.writeFileSync(ONYX_TOKEN_FILE, JSON.stringify({ sessionValid: false })); } catch(e2) {}
        }
        const stores = await onyxBetsWin.webContents.executeJavaScript(`(function(){
          const out={};
          for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i),v=localStorage.getItem(k);try{out[k]=JSON.parse(v);}catch(e){out[k]=v;}}
          return out;
        })()`);
        if (!capturedAuth) {
          for (const v of Object.values(stores || {})) {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            const m = s.match(/"(eyJ[A-Za-z0-9._-]{100,})"/);
            if (m) { capturedAuth = `Bearer ${m[1]}`; console.log('[onyx] found token in localStorage'); break; }
          }
        }
        // Only give up if we're actually on the bets page and still have nothing,
        // or if window is hidden (background refresh that already has a session).
        if (!sessionValid && !onBetsPage) return; // still on login — wait for user
        setTimeout(() => done(null), 2000);
      } catch(e) {}
    });

    setTimeout(() => done(null), sessionValid ? 15000 : 120000);
  });
}

async function fetchOnyxBets() {
  if (onyxBetsCache.ts && Date.now() - onyxBetsCache.ts < 25000) return onyxBetsCache.entries;

  // Always capture via CDP — the Electron persist:onyx session stays logged in
  // so this runs silently (~5s) after the first login. Only shows a window when
  // the session is logged out (sessionValid is false/missing in the token file).
  const result = await captureOnyxBets();
  if (!result || !result.data) throw new Error('no_onyx_data');
  const entries = parseOnyxBets(result.data);
  onyxBetsCache = { ts: Date.now(), entries };
  return entries;
}

function mapOnyxLeague(raw) {
  const s = (raw || '').toUpperCase().replace(/[- _]/g, '');
  const MAP = {
    'NBA':'NBA','NFL':'NFL','MLB':'MLB','NHL':'NHL','WNBA':'WNBA',
    'MLS':'MLS','EPL':'EPL','NWSL':'NWSL','NCAAF':'NCAAF','CFB':'CFB',
    'NCAAB':'NCAAB','CBB':'NCAAB','SOCCER':'MLS',
    'FOOTBALL':'NFL','BASKETBALL':'NBA','BASEBALL':'MLB','HOCKEY':'NHL',
  };
  return MAP[s] || (raw || '').toUpperCase().slice(0, 5);
}

function onyxStatName(market) {
  return (market || '')
    .replace(/^player_/i, '')
    .replace(/_\+_/g, ' + ')
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function parseOnyxLineId(lineId) {
  if (!lineId) return null;
  const parts = lineId.split(':');
  if (parts.length < 4) return null;
  const market = parts[2] || '';
  const lastPart = parts[parts.length - 1];
  const hasRefId = /^[A-F0-9]{6,}$/i.test(lastPart) || lastPart === 'null';
  const description = hasRefId ? parts.slice(3, -1).join(':') : parts.slice(3).join(':');
  const statName = onyxStatName(market);
  const m = description.match(/^(.+?)\s+(Over|Under)\s+([\d.]+)$/i);
  if (m) {
    return { name: m[1], wagerType: m[2].toLowerCase(), line: parseFloat(m[3]), statName };
  }
  // Team/moneyline bet — treat line=0 so legText shows it without direction
  const isMoneyline = /moneyline|spread|total|winner|ml\b/i.test(market);
  return { name: description || 'Pick', wagerType: 'over', line: isMoneyline ? 0 : null, statName };
}

function parseOnyxBets(data) {
  let bets = [];
  if (Array.isArray(data))  bets = data;
  else if (data.data)       return parseOnyxBets(data.data);
  else if (data.bets)       bets = data.bets;
  else if (data.wagers)     bets = data.wagers;
  if (!bets.length) return [];

  const inferOnyxTeamAbb = (name, awayName, homeName, awayAbb, homeAbb) => {
    const pick = String(name || '').toLowerCase();
    const away = String(awayName || '').toLowerCase();
    const home = String(homeName || '').toLowerCase();
    if (away && pick.includes(away)) return awayAbb || '';
    if (home && pick.includes(home)) return homeAbb || '';
    return '';
  };

  return bets.map(bet => {
    const stakeCents    = bet.stakeCents    ?? 0;
    const stakeCentsBase= bet.stakeCentsBase ?? stakeCents;
    const paidCents     = bet.paidCents     ?? 0;
    const payoutCents   = bet.payoutCents   ?? 0;

    const id = bet.id || undefined;

    let date = '';
    const rawDate = bet.placedAt || bet.createdAt || '';
    if (rawDate) { try { date = new Date(rawDate).toISOString().slice(0, 10); } catch(e) {} }
    if (!date) date = new Date().toISOString().slice(0, 10);

    // stakeCentsBase === 0 means the stake was entirely from bonus/promo credits
    const freeBet = stakeCentsBase === 0 && stakeCents > 0;

    const betStatus = bet.status || '';  // "Won", "Lost", "Cashed Out"

    const isSettled = /won|lost|cashed out/i.test(betStatus);
    const actualPaidCents = isSettled && paidCents > 0 ? paidCents : null;

    const amount  = `$${(stakeCents / 100).toFixed(2)}`;
    const payout  = actualPaidCents != null ? `$${(actualPaidCents / 100).toFixed(2)}`
                  : payoutCents > 0         ? `$${(payoutCents / 100).toFixed(2)}` : '—';
    const actualPayout = actualPaidCents != null ? `$${(actualPaidCents / 100).toFixed(2)}` : undefined;

    let picks = [];

    const selections = bet.selections || [];
    if (selections.length > 0) {
      picks = selections.map(sel => {
        const line  = sel.line || {};
        const game  = sel.game || {};
        const fixture = game.fixture || {};
        const name = line.name || line.selection || 'Pick';
        const statName = onyxStatName(line.market || line.marketName || '');
        const selStr = (line.selection || '').toLowerCase();
        const wagerType = /under|less/i.test(selStr) ? 'under' : 'over';
        const lineVal = line.selectionLine ?? line.betPoints ?? line.selectionPoints ?? null;
        const isMoneyline = /moneyline|winner|ml\b|spread|total/i.test(statName);
        const legStatus = (line.status || '').toLowerCase();
        const result = /won|win/.test(legStatus) ? 'won' : /lost|loss/.test(legStatus) ? 'lost' : 'pending';
        const league = mapOnyxLeague(game.league || game.sport || '');
        const awayName = (fixture.awayCompetitors?.[0]?.name) || '';
        const homeName = (fixture.homeCompetitors?.[0]?.name) || '';
        const awayAbb = (fixture.awayCompetitors?.[0]?.abbreviation) || game.awayTeam || '';
        const homeAbb = (fixture.homeCompetitors?.[0]?.abbreviation) || game.homeTeam || '';
        const awaySc  = game.awayScore ?? '';
        const homeSc  = game.homeScore ?? '';
        const gameFinished = (game.status || '').toLowerCase() === 'completed';
        const teamAbb = inferOnyxTeamAbb(name, awayName, homeName, awayAbb, homeAbb);
        return {
          name, pos: '', league, imgUrl: '', statName,
          line: isMoneyline && lineVal == null ? 0 : lineVal,
          wagerType, oddsType: '', current: null,
          inGame: !!(game.isLive), gameFinished,
          result, clock: '', period: 0, punit: 'quarter',
          awayAbb, homeAbb, awayName, homeName, awaySc, homeSc, teamAbb, startTime: '', source: 'onyx',
        };
      });
    } else if (bet.lineId) {
      const parsed = parseOnyxLineId(bet.lineId);
      if (parsed) {
        const game = bet.game || {};
        const fixture = game.fixture || {};
        const league = mapOnyxLeague(game.league || game.sport || '');
        const gameFinished = (game.status || '').toLowerCase() === 'completed';
        const betResult = /won|win/i.test(betStatus) ? 'won' : /lost|loss/i.test(betStatus) ? 'lost' : 'pending';
        const awayName = (fixture.awayCompetitors?.[0]?.name) || '';
        const homeName = (fixture.homeCompetitors?.[0]?.name) || '';
        const awayAbb = (fixture.awayCompetitors?.[0]?.abbreviation) || game.awayTeam || '';
        const homeAbb = (fixture.homeCompetitors?.[0]?.abbreviation) || game.homeTeam || '';
        const teamAbb = inferOnyxTeamAbb(parsed.name, awayName, homeName, awayAbb, homeAbb);
        picks = [{
          name: parsed.name, pos: '', league, imgUrl: '',
          statName: parsed.statName, line: parsed.line,
          wagerType: parsed.wagerType, oddsType: '', current: null,
          inGame: !!(game.isLive), gameFinished,
          result: betResult, clock: '', period: 0, punit: 'quarter',
          awayAbb, homeAbb, awayName, homeName, teamAbb,
          awaySc: game.awayScore ?? '', homeSc: game.homeScore ?? '',
          startTime: '', source: 'onyx',
        }];
      }
    }

    if (!picks.length) return null;

    const won  = picks.filter(p => p.result === 'won').length;
    const lost = picks.filter(p => p.result === 'lost').length;
    const open = picks.length - won - lost;

    return {
      id, date, amount, payout, actualPayout,
      result: betStatus, status: betStatus,
      freeBet: freeBet || undefined,
      picks, won, lost, open, source: 'onyx',
    };
  }).filter(Boolean).filter(e => e.picks.length > 0);
}

function isOnyxLiveEntry(entry) {
  if (!entry || entry.source !== 'onyx') return false;
  const raw = `${entry.status || ''} ${entry.result || ''}`.toLowerCase();
  if (/won|lost|cashed out|cashed_out|settled|completed|closed|graded/.test(raw)) return false;
  return (entry.open || 0) > 0 || !raw;
}

async function fetchChalkboardBets() {
  throw new Error('chalkboard_manual_only');
}

function isChalkboardLiveEntry(entry) {
  if (!entry || entry.source !== 'chalkboard') return false;
  const raw = `${entry.status || ''} ${entry.result || ''}`.toLowerCase();
  if (/won|lost|refund|void|cancel|cash|settled|completed|closed|graded/.test(raw)) return false;
  return (entry.open || 0) > 0 || !raw;
}

// ── ESPN player status ────────────────────────────────────────────────────────
const espnGameCache = {};

// Underdog stat name → ESPN boxscore column(s)
const ESPN_STAT_COLS = {
  'points':                      ['PTS'],
  'rebounds':                    ['REB'],
  'assists':                     ['AST'],
  'steals':                      ['STL'],
  'blocks':                      ['BLK'],
  'turnovers':                   ['TO'],
  'threes made':                 ['3PM'],
  '3-pointers made':             ['3PM'],
  'points + rebounds + assists': ['PTS','REB','AST'],
  'pts + rebs + asts':           ['PTS','REB','AST'],
  'points + rebounds':           ['PTS','REB'],
  'points + assists':            ['PTS','AST'],
  'rebounds + assists':          ['REB','AST'],
  'rebs+asts':                   ['REB','AST'],
  'hits':                        ['H'],
  'home runs':                   ['HR'],
  'rbis':                        ['RBI'],
  'rbi':                         ['RBI'],
  'runs':                        ['R'],
  'hits + runs + rbis':          ['H','R','RBI'],
  'hits+runs+rbis':              ['H','R','RBI'],
  'total bases':                 ['TB'],
  'stolen bases':                ['SB'],
  'pitcher strikeouts':          [['K','SO']],
  'hitter strikeouts':           [['K','SO']],
  'strikeouts':                  [['K','SO']],
  'goals':                       ['G'],
  'shots on goal':               [['SOG','S']],
  'saves':                       ['SV'],
};

// cols entries: string = required additive column; string[] = try each in order (OR fallback)
function getEspnStatValue(statObj, statName) {
  if (!statObj || !statName) return null;
  const key = statName.toLowerCase().trim();
  // Pitching Outs: ESPN stores innings pitched as "X.Y" (Y = extra outs, not decimal)
  if (key === 'pitching outs' || key === 'outs recorded') {
    const ip = statObj['IP'];
    if (ip == null) return null;
    const ipf = parseFloat(ip);
    if (isNaN(ipf)) return null;
    return Math.floor(ipf) * 3 + Math.round((ipf % 1) * 10);
  }
  const cols = ESPN_STAT_COLS[key];
  if (!cols) return null;
  let total = 0;
  for (const col of cols) {
    if (Array.isArray(col)) {
      let found = false;
      for (const alt of col) {
        const raw = statObj[alt];
        if (raw != null) { const v = parseFloat(raw); if (!isNaN(v)) { total += v; found = true; break; } }
      }
      if (!found) return null;
    } else {
      const raw = statObj[col];
      if (raw == null) return null;
      const val = parseFloat(raw);
      if (isNaN(val)) return null;
      total += val;
    }
  }
  return total;
}
const ESPN_SPORT_MAP = {
  'NBA':  { sport: 'basketball', league: 'nba' },
  'NFL':  { sport: 'football',   league: 'nfl' },
  'CFB':  { sport: 'football',   league: 'college-football' },
  'NCAAF':{ sport: 'football',   league: 'college-football' },
  'MLB':  { sport: 'baseball',   league: 'mlb' },
  'NHL':  { sport: 'hockey',     league: 'nhl' },
  'WNBA': { sport: 'basketball', league: 'wnba' },
  'MLS':  { sport: 'soccer',     league: 'usa.1' },
  'EPL':  { sport: 'soccer',     league: 'eng.1' },
  'NWSL': { sport: 'soccer',     league: 'usa.nwsl' },
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
  if (cached && Date.now() - cached.ts < 20000) return cached;
  const sport = ESPN_SPORT_MAP[leagueUpper];
  if (!sport) return null;
  try {
    const sb = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.sport}/${sport.league}/scoreboard`);
    let eventId = null, gameClock = '', gamePeriod = 0, isTimeout = false;
    for (const ev of (sb.events || [])) {
      const comp = (ev.competitions || [])[0] || {};
      const abbs = (comp.competitors || []).map(c => (c.team?.abbreviation || '').toUpperCase());
      if (abbs.includes(awayAbb.toUpperCase()) && abbs.includes(homeAbb.toUpperCase())) {
        eventId = ev.id;
        const st = comp.status || {};
        const sit = comp.situation || {};
        gameClock = st.displayClock || '';
        gamePeriod = st.period || 0;
        const _td = (st.type?.description || '').toLowerCase();
        const _tn = (st.type?.name || '').toLowerCase();
        const _ts = (st.type?.shortDetail || st.type?.detail || '').toLowerCase();
        isTimeout = _td.includes('timeout') || _tn.includes('timeout') || _ts.includes('timeout');
        espnGameCache[`${key}_bonus`] = !!(sit.awayBonus || sit.homeBonus || sit.homeTeamInBonus || sit.awayTeamInBonus || sit.inBonus);
        break;
      }
    }
    if (!eventId) return null;
    const bs = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport.sport}/${sport.league}/summary?event=${eventId}`);
    const players = {};
    const playerStats = {};
    for (const team of (bs.boxscore?.players || [])) {
      for (const sg of (team.statistics || [])) {
        const cols = (sg.names || sg.labels || sg.keys || []).map(c => (c||'').toUpperCase());
        for (const athlete of (sg.athletes || [])) {
          const a = athlete.athlete || {};
          const lastName = (a.displayName || '').split(' ').slice(-1)[0].toLowerCase();
          const fullName = (a.displayName || '').toLowerCase();
          const active = athlete.active !== false;
          players[lastName] = active;
          players[fullName] = active;
          const statsObj = {};
          (athlete.stats || []).forEach((val, i) => { if (cols[i]) statsObj[cols[i]] = val; });
          playerStats[lastName] = statsObj;
          playerStats[fullName] = statsObj;
        }
      }
    }
    const isBonus = !!(espnGameCache[`${key}_bonus`]);
    espnGameCache[key] = { ts: Date.now(), players, playerStats, gameClock, gamePeriod, isTimeout, isBonus };
    return espnGameCache[key];
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

function liveApiPayload() {
  const entries = accountEntries[activeAccount] || [];
  const allPicks = entries.flatMap(e => e.picks || []);
  return {
    ok: true,
    ts: Date.now(),
    activeAccount,
    accounts: ACCOUNTS.map(a => a.label),
    error: accountErrors[activeAccount],
    reauthing,
    entries,
    totals: {
      entries: entries.length,
      picks: allPicks.length,
      won: entries.reduce((s,e) => s + (e.won || 0), 0),
      lost: entries.reduce((s,e) => s + (e.lost || 0), 0),
      open: entries.reduce((s,e) => s + (e.open || 0), 0),
    },
  };
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const pickKey = (entry.picks || []).map(p => `${p.name}|${p.statName}|${p.line}|${p.wagerType}`).join(',');
    const key = entry.id || `${entry.source || 'prizepicks'}|${entry.date || ''}|${entry.amount}|${entry.payout}|${pickKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function firstSuccessful(label, tasks) {
  let lastErr = null;
  for (const task of tasks) {
    try { return await task(); }
    catch(e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  throw new Error(`${label}_unavailable`);
}

async function fetchPrizePicksHistory() {
  const filters = ['settled', 'completed', 'past', 'history', 'free', 'promo', 'all', ''];
  const batches = [];
  for (const f of filters) {
    try {
      const data = await fetchPicks(activeAccount, f);
      const entries = parsePicks(data);
      if (entries.length) batches.push(...entries);
    } catch (e) {}
  }
  return dedupeEntries(batches);
}

async function fetchUnderdogHistory() {
  const basePaths = [
    '/v9/user/settled_entry_slips?product=fantasy&product_experience_id=018e1234-5678-9abc-def0-123456789002',
    '/v8/user/settled_entry_slips?product=fantasy',
  ];
  return firstSuccessful('underdog_history', basePaths.map(base => async () => {
    const entries = [];
    let nextPage = 1;
    let pages = 0;
    while (nextPage && pages < 12) {
      const sep = base.includes('?') ? '&' : '?';
      const data = await fetchUnderdogEntrySlips(`${base}${sep}page=${nextPage}`);
      entries.push(...parseUnderdogPicks(data));
      const meta = data.meta || (data.data || {}).meta || {};
      nextPage = meta.next || null;
      pages += 1;
    }
    if (!entries.length) throw new Error('empty_underdog_history');
    return entries;
  }));
}

async function getWebsiteHistory(force = false) {
  if (!force && historyCache.ts && Date.now() - historyCache.ts < 60000) return historyCache;
  const entries = [];
  let error = null;

  try { entries.push(...(await fetchPrizePicksHistory())); }
  catch(e) { error = error || `PrizePicks: ${e.message}`; }

  if (activeAccount === 0) {
    try { entries.push(...(await fetchUnderdogHistory())); }
    catch(e) { if (e.message !== 'no_ud_token') error = error || `Underdog: ${e.message}`; }

    try { entries.push(...(await fetchOnyxBets())); }
    catch(e) { if (e.message !== 'no_onyx_data') error = error || `Onyx: ${e.message}`; }

    try { entries.push(...(await fetchChalkboardBets())); }
    catch(e) { if (e.message !== 'chalkboard_manual_only') error = error || `Chalkboard: ${e.message}`; }
  }

  const merged = dedupeEntries([...(accountEntries[activeAccount] || []), ...entries])
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  historyCache = { ts: Date.now(), entries: merged, error };
  return historyCache;
}

function startLiveApi() {
  if (liveApiServer) return;
  liveApiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/api/linewatch') {
      const mode = url.searchParams.get('mode');
      const wantsHistory = mode === 'history';
      const wantsRecent = mode === 'recent';
      const force = url.searchParams.get('refresh') === '1';
      if (force) ACCOUNTS.forEach((_, i) => doRefresh(i));
      if (wantsHistory || wantsRecent) {
        const hist = await getWebsiteHistory(force);
        const payload = liveApiPayload();
        payload.mode = wantsRecent ? 'recent' : 'history';
        payload.entries = wantsRecent ? dedupeEntries([...(accountEntries[activeAccount] || []), ...hist.entries]) : hist.entries;
        payload.error = hist.error;
        payload.totals = {
          entries: payload.entries.length,
          picks: payload.entries.reduce((s,e) => s + ((e.picks || []).length), 0),
          won: payload.entries.reduce((s,e) => s + (e.won || 0), 0),
          lost: payload.entries.reduce((s,e) => s + (e.lost || 0), 0),
          open: payload.entries.reduce((s,e) => s + (e.open || 0), 0),
        };
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(liveApiPayload()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  liveApiServer.on('error', e => console.log('[live-api]', e.message));
  liveApiServer.listen(LIVE_API_PORT, '127.0.0.1', () => {
    console.log(`[live-api] http://127.0.0.1:${LIVE_API_PORT}/api/linewatch`);
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
  popupWin.webContents.on('did-finish-load', () => {
    if (popupWin && popupWin.isVisible()) sendPicksData(popupWin);
  });
  popupWin.on('blur', () => {
    // Delay hide to avoid hiding when Underdog window briefly steals focus
    setTimeout(() => {
      if (udTokenWin || onyxBetsWin) return;
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

function createTooltip() {
  tooltipWin = new BrowserWindow({
    width: 240, height: 340, show: false,
    frame: false, transparent: true,
    skipTaskbar: true, alwaysOnTop: true,
    resizable: false, focusable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  tooltipWin.setAlwaysOnTop(true, 'floating');
  tooltipWin.setVisibleOnAllWorkspaces(true);
  tooltipWin.loadFile('tooltip.html');
  tooltipWin.on('closed', () => { tooltipWin = null; });
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
  startLiveApi();
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle(' ↻');
  tray.setToolTip('Linewatch');
  tray.on('click', () => {
    if (popupWin && popupWin.isVisible()) { popupWin.hide(); } else { showPopup(); }
  });
  tray.on('right-click', () => {
    Menu.buildFromTemplate([{ label: 'Quit', click: () => app.quit() }]).popup();
  });
  const onyxStartup = getOnyxToken();
  console.log('[onyx]', onyxStartup?.sessionValid ? 'session valid – will sync silently' : 'session invalid – will prompt login on next sync');
  console.log('[chalkboard] manual-only for now');
  setTimeout(() => refreshUdToken(), 5000);
  setInterval(() => refreshUdToken(), 8 * 60 * 1000);
  createPopup();
  createTooltip();
  ACCOUNTS.forEach((_, i) => doRefresh(i));
  setInterval(() => ACCOUNTS.forEach((_, i) => doRefresh(i)), REFRESH_MS);
  setInterval(() => runAutoCookie(), 30 * 60 * 1000);
});

app.on('window-all-closed', e => e.preventDefault());

// ── Refresh ───────────────────────────────────────────────────────────────────
async function doRefresh(idx) {
  let entries = [];
  let ppError = null;
  let udError = null;

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
      udError = e.message;
      if (e.message !== 'no_ud_token') console.log('[underdog]', e.message);
    }

    try {
      const onyxEntries = await fetchOnyxBets();
      entries = [...entries, ...onyxEntries.filter(isOnyxLiveEntry)];
    } catch(e) {
      if (e.message !== 'no_onyx_data') console.log('[onyx]', e.message);
    }

    try {
      const chalkboardEntries = await fetchChalkboardBets();
      entries = [...entries, ...chalkboardEntries.filter(isChalkboardLiveEntry)];
    } catch(e) {
      if (e.message !== 'chalkboard_manual_only') console.log('[chalkboard]', e.message);
    }
  }

  accountErrors[idx] = entries.length === 0 ? (udError || ppError || null) : null;

  const SUPPORTED = ['NBA','NFL','MLB','NHL','WNBA','MLS','EPL'];
  const livePickGroups = entries.flatMap(e => e.picks).filter(p =>
    p.inGame && !p.gameFinished && SUPPORTED.includes(p.league?.toUpperCase()) && p.awayAbb && p.homeAbb
  );
  const gameKeys = [...new Set(livePickGroups.map(p => `${p.awayAbb}-${p.homeAbb}-${p.league?.toUpperCase()}`))];
  await Promise.all(gameKeys.map(async key => {
    const [away, home, league] = key.split('-');
    const espnData = await fetchEspnPlayerStatus(league, away, home);
    if (!espnData) return;
    for (const entry of entries) {
      for (const pick of entry.picks) {
        if (`${pick.awayAbb}-${pick.homeAbb}-${pick.league?.toUpperCase()}` === key) {
          const active = espnData.players[pick.name.split(' ').slice(-1)[0].toLowerCase()] ?? espnData.players[pick.name.toLowerCase()] ?? null;
          if (active === false) pick.playerOut = true;
          if (espnData.isTimeout) pick.isTimeout = true;
          if (espnData.isBonus)   pick.inBonus   = true;
          if (!pick.clock && espnData.gameClock) pick.clock = espnData.gameClock;
          if ((!pick.period || pick.period === 0) && espnData.gamePeriod) pick.period = espnData.gamePeriod;
          // Pull live stat + store full ESPN stats for hover tooltip
          if (espnData.playerStats) {
            const pKey = pick.name.split(' ').slice(-1)[0].toLowerCase();
            const pKey2 = pick.name.toLowerCase();
            const sObj = espnData.playerStats[pKey] || espnData.playerStats[pKey2];
            if (sObj && Object.keys(sObj).length) pick.espnStats = sObj;
            if (pick.source === 'underdog' && sObj) {
              const espnVal = getEspnStatValue(sObj, pick.statName);
              if (espnVal != null) pick.current = espnVal;
            }
          }
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
  const MAX_H = 10 + 90 * 2 + 14; // header + up to 6 entries + 3 picks + padding (header = 20, pick = 90)
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

ipcMain.on('show-tooltip', (event, data) => {
  if (!tooltipWin || tooltipWin.isDestroyed()) createTooltip();
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin) return;
  const wb = senderWin.getBounds();
  const TW = 240, TH = 340;
  const disp = screen.getDisplayNearestPoint({ x: wb.x, y: wb.y });
  let tx = wb.x + wb.width + 8;
  if (tx + TW > disp.workArea.x + disp.workArea.width) tx = wb.x - TW - 8;
  if (tx < disp.workArea.x) tx = disp.workArea.x + 4;
  let ty = wb.y + Math.round(wb.height / 2) - Math.round(TH / 2);
  if (ty < disp.workArea.y) ty = disp.workArea.y + 4;
  if (ty + TH > disp.workArea.y + disp.workArea.height) ty = disp.workArea.y + disp.workArea.height - TH - 4;
  tooltipWin.setBounds({ x: Math.round(tx), y: Math.round(ty), width: TW, height: TH });
  tooltipWin.webContents.send('tip-data', data);
  tooltipWin.showInactive();
});

ipcMain.on('hide-tooltip', () => {
  if (tooltipWin && !tooltipWin.isDestroyed()) tooltipWin.hide();
});

ipcMain.on('tooltip-height', (_, h) => {
  if (!tooltipWin || tooltipWin.isDestroyed()) return;
  const b = tooltipWin.getBounds();
  const newH = Math.min(Math.max(h, 120), 500);
  if (Math.abs(b.height - newH) > 8) {
    tooltipWin.setBounds({ x: b.x, y: b.y, width: b.width, height: newH });
  }
});
