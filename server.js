'use strict';

const express   = require('express');
const cron      = require('node-cron');
const fetch     = require('node-fetch');
const path      = require('path');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// KEEP-ALIVE SELF-PING (critical for Replit free tier — prevents sleep)
// Replit sleeps after ~1hr of no HTTP traffic. We ping ourselves every 4 min.
// ─────────────────────────────────────────────────────────────────────────────
const REPLIT_URL = process.env.REPLIT_URL || '';   // set this in Secrets after first deploy

function startKeepAlive() {
  if (!REPLIT_URL) {
    console.log('[KeepAlive] REPLIT_URL not set — add it to Secrets after first deploy');
    return;
  }
  setInterval(async () => {
    try {
      await fetch(`${REPLIT_URL}/health`);
      console.log('[KeepAlive] Pinged self →', new Date().toLocaleTimeString());
    } catch (e) {
      console.error('[KeepAlive] Ping failed:', e.message);
    }
  }, 4 * 60 * 1000); // every 4 minutes
  console.log('[KeepAlive] Self-ping active every 4 min →', REPLIT_URL);
}

// ─────────────────────────────────────────────────────────────────────────────
// YOUR HISTORICAL PATTERNS (from uploaded CSV)
// ─────────────────────────────────────────────────────────────────────────────
const YOUR_PATTERNS = {
  bestHoursUTC:     [1, 5, 15],
  worstHoursUTC:    [2, 3, 4, 16, 19],
  winRate:          0.24,
  breakEvenWinRate: 0.37,
  bestLotSize:      0.01,
  dominantMistake:  'buy_into_downtrend',
};

// ─────────────────────────────────────────────────────────────────────────────
// PRICE ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const MAX_HISTORY   = 500;
let priceHistory    = [];
let lastKnownPrice  = 4351;
let currentPrice    = 4351;
let priceSource     = 'initializing';

async function fetchLivePrice() {
  // Source 1: goldprice.org
  try {
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD',
      { headers: { Accept: 'application/json' }, timeout: 6000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.items?.[0]?.xauPrice);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; priceSource = 'goldprice.org'; return p; }
    }
  } catch (_) {}

  // Source 2: frankfurter
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=XAU&to=USD', { timeout: 6000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.rates?.USD);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; priceSource = 'frankfurter'; return p; }
    }
  } catch (_) {}

  // Fallback: drift from last known
  priceSource = 'simulated';
  const drift = (Math.random() - 0.48) * 0.9;
  return parseFloat((lastKnownPrice + drift).toFixed(2));
}

function pushPrice(p) {
  priceHistory.push(p);
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

// ─────────────────────────────────────────────────────────────────────────────
// INDICATOR ENGINE
// ─────────────────────────────────────────────────────────────────────────────
function computeIndicators(price, history) {
  const len = history.length;
  if (len < 10) return null;

  const slice = n => history.slice(-Math.min(n, len));
  const avg   = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const ma5  = avg(slice(5));
  const ma14 = avg(slice(14));
  const ma21 = avg(slice(21));

  // RSI
  const r14 = slice(14);
  let gains = 0, losses = 0, gc = 0, lc = 0;
  for (let i = 1; i < r14.length; i++) {
    const d = r14[i] - r14[i - 1];
    if (d > 0) { gains += d; gc++; } else { losses += Math.abs(d); lc++; }
  }
  const rsi = 100 - (100 / (1 + (gc ? gains/gc : 0) / (lc ? losses/lc : 0.001)));

  // Stochastic
  const hi14  = Math.max(...slice(14));
  const lo14  = Math.min(...slice(14));
  const stoch = hi14 !== lo14 ? ((price - lo14) / (hi14 - lo14)) * 100 : 50;

  // MACD
  const macd = avg(slice(12)) - avg(slice(Math.min(26, len)));

  // Momentum
  const momentum = len >= 10 ? price - history[len - 10] : 0;

  // Volatility
  const s14  = slice(14);
  const diffs = s14.slice(1).map((v, i) => Math.abs(v - s14[i]));
  const vol  = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0.5;

  return {
    rsi, stoch, macd, momentum, vol,
    ma5, ma14, ma21,
    trend:     price > ma14 ? 'bull' : 'bear',
    ema_align: ma5 > ma14 && ma14 > ma21,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI DECISION ENGINE
// ─────────────────────────────────────────────────────────────────────────────
function decide(price, indicators, hourUTC) {
  if (!indicators) return { action: 'wait', reason: 'Building price history…', confidence: 0, bullScore: 0, bearScore: 0 };

  const { rsi, stoch, macd, momentum, trend, ema_align, vol } = indicators;
  const isBest  = YOUR_PATTERNS.bestHoursUTC.includes(hourUTC);
  const isWorst = YOUR_PATTERNS.worstHoursUTC.includes(hourUTC);

  let bull = 0, bear = 0;
  const log = [];

  if (rsi < 32)        { bull += 2.5; log.push(`RSI oversold ${rsi.toFixed(1)}`); }
  else if (rsi > 68)   { bear += 2.5; log.push(`RSI overbought ${rsi.toFixed(1)}`); }
  else                 { log.push(`RSI neutral ${rsi.toFixed(1)}`); }

  if (stoch < 20)      { bull += 2;   log.push('Stoch oversold'); }
  else if (stoch > 80) { bear += 2;   log.push('Stoch overbought'); }

  if (macd > 0.5)      { bull += 1.5; log.push('MACD bull'); }
  else if (macd < -0.5){ bear += 1.5; log.push('MACD bear'); }

  if (ema_align)       { bull += 2;   log.push('EMA aligned bull'); }
  else                 { bear += 1;   log.push('EMA misaligned'); }

  if (momentum > 3)    { bull += 1;   log.push('Momentum up'); }
  else if (momentum < -3){ bear += 1; log.push('Momentum down'); }

  if (isWorst) { bull -= 2; bear -= 2; log.push(`⚠ Worst hour ${hourUTC}:00 UTC`); }
  if (isBest)  { bull += 0.5; bear += 0.5; log.push(`✓ Best hour ${hourUTC}:00 UTC`); }

  // Avoid your #1 mistake: buying into a downtrend
  if (trend === 'bear' && bull > bear) {
    bull -= 2;
    log.push('Correction: trend bearish, avoided buy-into-downtrend');
  }

  const confidence = Math.min(Math.max(bull, bear) / 9, 1);
  const THRESHOLD  = 0.44;

  if (confidence < THRESHOLD) return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };

  const tp_dist = Math.max(vol * 10, 6);
  const sl_dist = Math.max(vol * 5,  3);

  if (bull >= bear && bull >= 4) {
    return { action: 'buy', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price + tp_dist).toFixed(2)), sl: parseFloat((price - sl_dist).toFixed(2)), lots: 0.01 };
  }
  if (bear > bull && bear >= 4) {
    return { action: 'sell', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price - tp_dist).toFixed(2)), sl: parseFloat((price + sl_dist).toFixed(2)), lots: 0.01 };
  }

  return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADER STATE
// ─────────────────────────────────────────────────────────────────────────────
const STARTING_BALANCE = parseFloat(process.env.STARTING_BALANCE || 10000);

const state = {
  balance:       STARTING_BALANCE,
  trades:        [],
  openTrade:     null,
  equityHistory: [STARTING_BALANCE],
  log:           [],
  stats:         { skipped: 0, buys: 0, sells: 0, tpHits: 0, slHits: 0, manualCloses: 0 },
  startedAt:     new Date().toISOString(),
  lastAnalysis:  null,
};

function addLog(msg, type = 'info') {
  const entry = { ts: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log(`[${type.toUpperCase().padEnd(5)}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────────────────────────────────────────
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw);
    return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } catch (e) { console.error('[Sheets] Auth parse error:', e.message); return null; }
}

async function sheetsClient() {
  const auth = getAuth();
  if (!auth || !SHEET_ID) return null;
  return google.sheets({ version: 'v4', auth });
}

async function ensureHeaders() {
  const sheets = await sheetsClient();
  if (!sheets) { console.log('[Sheets] Skipping headers — not configured'); return; }
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'TradeLog!A1:L1', valueInputOption: 'RAW',
      requestBody: { values: [['Trade#','Date','Open Time','Close Time','Type','Entry','Exit','TP','SL','P&L','Result','Reason']] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: 'DailySummary!A1:K1', valueInputOption: 'RAW',
      requestBody: { values: [['Date','Trades','Wins','Losses','Win Rate %','Gross P&L','Balance','Avg Win','Avg Loss','Best','Worst']] },
    });
    console.log('[Sheets] Headers ensured');
  } catch (e) { console.error('[Sheets] ensureHeaders:', e.message); }
}

async function logTradeToSheets(trade) {
  const sheets = await sheetsClient();
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'TradeLog!A:L',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        trade.id,
        new Date(trade.openTime).toLocaleDateString('en-US'),
        new Date(trade.openTime).toLocaleTimeString('en-US'),
        new Date(trade.closeTime).toLocaleTimeString('en-US'),
        trade.type.toUpperCase(), trade.entry, trade.exit,
        trade.tp, trade.sl, trade.pl,
        trade.isWin ? 'WIN' : 'LOSS',
        (trade.reason || '').substring(0, 120),
      ]] },
    });
    console.log(`[Sheets] Logged trade #${trade.id} ${trade.isWin ? 'WIN' : 'LOSS'} $${trade.pl}`);
  } catch (e) { console.error('[Sheets] logTrade:', e.message); }
}

async function logDailySummary() {
  const sheets = await sheetsClient();
  if (!sheets) return;
  const today = new Date().toLocaleDateString('en-US');
  const todayTrades = state.trades.filter(t => new Date(t.closeTime).toLocaleDateString('en-US') === today);
  if (!todayTrades.length) { console.log('[Sheets] No trades today — skipping summary'); return; }

  const wins   = todayTrades.filter(t => t.isWin);
  const losses = todayTrades.filter(t => !t.isWin);
  const pls    = todayTrades.map(t => t.pl);
  const gross  = pls.reduce((a, b) => a + b, 0).toFixed(2);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'DailySummary!A:K',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[
        today, todayTrades.length, wins.length, losses.length,
        ((wins.length / todayTrades.length) * 100).toFixed(1),
        gross, state.balance.toFixed(2),
        wins.length   ? (wins.reduce((a,t)=>a+t.pl,0)/wins.length).toFixed(2)   : 'N/A',
        losses.length ? (losses.reduce((a,t)=>a+t.pl,0)/losses.length).toFixed(2) : 'N/A',
        Math.max(...pls).toFixed(2), Math.min(...pls).toFixed(2),
      ]] },
    });
    console.log('[Sheets] Daily summary logged for', today);
  } catch (e) { console.error('[Sheets] logDailySummary:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
function openPosition(decision, price) {
  state.openTrade = {
    id: state.trades.length + 1,
    type: decision.action, entry: price,
    tp: decision.tp, sl: decision.sl, lots: decision.lots,
    openTime: new Date().toISOString(),
    reason: decision.reason, confidence: decision.confidence,
  };
  if (decision.action === 'buy') state.stats.buys++;
  else state.stats.sells++;
  addLog(`ENTER ${decision.action.toUpperCase()} @ $${price} | TP $${decision.tp} | SL $${decision.sl} | Conf ${(decision.confidence*100).toFixed(0)}%`, 'trade');
}

async function closePositionFn(price, reason) {
  if (!state.openTrade) return;
  const t   = state.openTrade;
  const pip = t.type === 'buy' ? price - t.entry : t.entry - price;
  const pl  = parseFloat((pip * 100 * t.lots).toFixed(2));
  const isWin = pl > 0;

  const closed = { ...t, exit: price, pl, isWin, closeTime: new Date().toISOString(), closeReason: reason };
  state.trades.push(closed);
  state.balance      = parseFloat((state.balance + pl).toFixed(2));
  state.equityHistory.push(state.balance);
  state.openTrade    = null;

  if (reason === 'TP') state.stats.tpHits++;
  else if (reason === 'SL') state.stats.slHits++;
  else state.stats.manualCloses++;

  addLog(`EXIT ${closed.type.toUpperCase()} @ $${price} | ${reason} | P&L: ${pl >= 0 ? '+' : ''}$${pl}`, isWin ? 'win' : 'loss');
  await logTradeToSheets(closed);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOPS
// ─────────────────────────────────────────────────────────────────────────────
async function priceTick() {
  const p = await fetchLivePrice();
  currentPrice = p;
  pushPrice(p);

  if (state.openTrade) {
    const { type, tp, sl } = state.openTrade;
    if (type === 'buy') {
      if (p >= tp) await closePositionFn(p, 'TP');
      else if (p <= sl) await closePositionFn(p, 'SL');
    } else {
      if (p <= tp) await closePositionFn(p, 'TP');
      else if (p >= sl) await closePositionFn(p, 'SL');
    }
  }
}

async function analysisCycle() {
  await priceTick();
  const indicators = computeIndicators(currentPrice, priceHistory);
  const hourUTC    = new Date().getUTCHours();
  const decision   = decide(currentPrice, indicators, hourUTC);

  state.lastAnalysis = { ts: new Date().toISOString(), price: currentPrice, decision, hourUTC };

  if (state.openTrade) {
    const unreal = state.openTrade.type === 'buy'
      ? (currentPrice - state.openTrade.entry) * 100 * state.openTrade.lots
      : (state.openTrade.entry - currentPrice) * 100 * state.openTrade.lots;
    addLog(`HOLD ${state.openTrade.type.toUpperCase()} | Unrealized ${unreal >= 0 ? '+' : ''}$${unreal.toFixed(2)} | ${decision.reason}`, 'hold');
  } else {
    if (decision.action === 'buy' || decision.action === 'sell') {
      openPosition(decision, currentPrice);
    } else {
      state.stats.skipped++;
      addLog(`WAIT | Bull ${(decision.bullScore||0).toFixed(1)} Bear ${(decision.bearScore||0).toFixed(1)} | ${decision.reason}`, 'wait');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTED STATS
// ─────────────────────────────────────────────────────────────────────────────
function computeStats() {
  const t = state.trades;
  if (!t.length) return null;
  const wins   = t.filter(x => x.isWin);
  const losses = t.filter(x => !x.isWin);
  const totalPL = t.reduce((a, x) => a + x.pl, 0);
  const avgWin  = wins.length   ? wins.reduce((a,x)=>a+x.pl,0)/wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((a,x)=>a+x.pl,0)/losses.length : 0;
  const pf      = Math.abs(avgLoss) > 0 ? Math.abs(avgWin * wins.length / (avgLoss * losses.length)) : null;

  let peak = STARTING_BALANCE, mdd = 0;
  state.equityHistory.forEach(e => { if (e > peak) peak = e; const dd = (peak-e)/peak*100; if (dd > mdd) mdd = dd; });

  let maxWS=0,maxLS=0,cWS=0,cLS=0;
  t.forEach(x => { if(x.isWin){cWS++;cLS=0;maxWS=Math.max(maxWS,cWS);}else{cLS++;cWS=0;maxLS=Math.max(maxLS,cLS);} });

  return {
    total: t.length, wins: wins.length, losses: losses.length,
    winRate: (wins.length/t.length*100).toFixed(1),
    totalPL: totalPL.toFixed(2), avgWin: avgWin.toFixed(2), avgLoss: avgLoss.toFixed(2),
    rr: avgLoss!==0 ? Math.abs(avgWin/avgLoss).toFixed(2) : null,
    pf: pf ? pf.toFixed(2) : null,
    best: Math.max(...t.map(x=>x.pl)).toFixed(2), worst: Math.min(...t.map(x=>x.pl)).toFixed(2),
    mdd: mdd.toFixed(1), maxWinStreak: maxWS, maxLossStreak: maxLS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json({
  balance: state.balance, currentPrice, priceSource,
  openTrade: state.openTrade, equityHistory: state.equityHistory,
  recentLog: state.log.slice(0, 60), stats: computeStats(),
  activityStats: state.stats, lastAnalysis: state.lastAnalysis,
  startedAt: state.startedAt, tradeCount: state.trades.length,
}));

app.get('/api/trades', (req, res) => {
  const page  = parseInt(req.query.page  || 1);
  const limit = parseInt(req.query.limit || 50);
  const slice = [...state.trades].reverse().slice((page-1)*limit, page*limit);
  res.json({ trades: slice, total: state.trades.length });
});

app.post('/api/close', async (req, res) => {
  if (!state.openTrade) return res.json({ ok: false, msg: 'No open position' });
  await closePositionFn(currentPrice, 'Manual');
  res.json({ ok: true });
});

// Health endpoint — used by keep-alive ping
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), trades: state.trades.length }));

// ─────────────────────────────────────────────────────────────────────────────
// CRON — midnight UTC daily summary
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  addLog('Running midnight daily summary…');
  await logDailySummary();
}, { timezone: 'UTC' });

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const ANALYSIS_INTERVAL = parseInt(process.env.ANALYSIS_INTERVAL_SECONDS || 30) * 1000;

async function start() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   XAU/USD AI Trader — Replit Build   ║');
  console.log('╚══════════════════════════════════════╝');

  await ensureHeaders();

  // Seed initial price
  const seed = await fetchLivePrice();
  currentPrice = seed;
  pushPrice(seed);
  addLog(`Started | $${seed} from ${priceSource}`, 'info');

  // Price tick every 5s (TP/SL monitoring)
  setInterval(priceTick, 5000);

  // Full AI analysis on interval
  setInterval(analysisCycle, ANALYSIS_INTERVAL);
  analysisCycle(); // run immediately

  // Keep-alive self-ping
  startKeepAlive();

  app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
    console.log(`[Trader] Analysis every ${ANALYSIS_INTERVAL / 1000}s`);
  });
}

start().catch(e => { console.error('Fatal:', e); process.exit(1); });
