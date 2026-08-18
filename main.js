'use strict';
require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fetch    = require('node-fetch');
const { fetchLivePrice, pushPrice, getHistory, computeIndicators, decide } = require('./engine');
const { ensureHeaders, logTrade, logDailySummary } = require('./sheets');
const { initDB, saveTrade, saveEquity, saveDailySummary, loadTrades, loadEquityHistory } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const STARTING_BALANCE      = parseFloat(process.env.STARTING_BALANCE || 10000);
const ANALYSIS_INTERVAL_SEC = parseInt(process.env.ANALYSIS_INTERVAL_SECONDS || 30);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  balance:       STARTING_BALANCE,
  trades:        [],
  openTrade:     null,
  currentPrice:  0,
  priceSource:   'unknown',
  equityHistory: [STARTING_BALANCE],
  log:           [],
  stats:         { skipped:0, buys:0, sells:0, tpHits:0, slHits:0, manualCloses:0 },
  startedAt:     new Date().toISOString(),
  lastAnalysis:  null,
  keepAliveHits: 0,
  dbConnected:   false,
};

function addLog(msg, type = 'info') {
  const entry = { ts: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ── TRADE EXECUTION ───────────────────────────────────────────────────────────
function openPosition(decision, price) {
  state.openTrade = {
    id:         state.trades.length + 1,
    type:       decision.action,
    entry:      price,
    tp:         decision.tp,
    sl:         decision.sl,
    lots:       decision.lots,
    openTime:   new Date().toISOString(),
    reason:     decision.reason,
    confidence: decision.confidence,
  };
  if (decision.action === 'buy') state.stats.buys++;
  else state.stats.sells++;
  addLog(`ENTER ${decision.action.toUpperCase()} @ $${price} | TP $${decision.tp} | SL $${decision.sl} | Conf ${(decision.confidence*100).toFixed(0)}%`, 'trade');
}

async function closePosition(price, reason) {
  if (!state.openTrade) return;
  const t = state.openTrade;
  const pips = t.type === 'buy' ? price - t.entry : t.entry - price;
  const pl   = parseFloat((pips * 100 * t.lots).toFixed(2));
  const isWin = pl > 0;

  const closed = { ...t, exit: price, pl, isWin, closeTime: new Date().toISOString(), closeReason: reason };
  state.trades.push(closed);
  state.balance = parseFloat((state.balance + pl).toFixed(2));
  state.equityHistory.push(state.balance);
  state.openTrade = null;

  if (reason === 'TP')      state.stats.tpHits++;
  else if (reason === 'SL') state.stats.slHits++;
  else                      state.stats.manualCloses++;

  addLog(`EXIT ${closed.type.toUpperCase()} @ $${price} | ${reason} | P&L: ${pl>=0?'+':''}$${pl}`, isWin ? 'win' : 'loss');

  // Save to DB + Sheets in parallel
  await Promise.all([
    saveTrade(closed),
    saveEquity(state.balance),
    logTrade(closed),
  ]);
}

// ── PRICE TICK ────────────────────────────────────────────────────────────────
async function priceTick() {
  const { price, source } = await fetchLivePrice();
  state.currentPrice = price;
  state.priceSource  = source;
  pushPrice(price);

  if (state.openTrade) {
    const { type, tp, sl } = state.openTrade;
    if (type === 'buy') {
      if (price >= tp) await closePosition(price, 'TP');
      else if (price <= sl) await closePosition(price, 'SL');
    } else {
      if (price <= tp) await closePosition(price, 'TP');
      else if (price >= sl) await closePosition(price, 'SL');
    }
  }
}

// ── ANALYSIS CYCLE ────────────────────────────────────────────────────────────
async function analysisCycle() {
  try {
    await priceTick();
    const price      = state.currentPrice;
    const history    = getHistory();
    const indicators = computeIndicators(price, history);
    const hourUTC    = new Date().getUTCHours();
    const decision   = decide(price, indicators, hourUTC);

    state.lastAnalysis = { ts: new Date().toISOString(), price, indicators, decision, hourUTC };

    if (state.openTrade) {
      const unreal = state.openTrade.type === 'buy'
        ? (price - state.openTrade.entry) * 100 * state.openTrade.lots
        : (state.openTrade.entry - price) * 100 * state.openTrade.lots;
      addLog(`HOLD ${state.openTrade.type.toUpperCase()} | Unrealized ${unreal>=0?'+':''}$${unreal.toFixed(2)} | ${decision.reason}`, 'hold');
    } else {
      if (decision.action === 'buy' || decision.action === 'sell') {
        openPosition(decision, price);
      } else {
        state.stats.skipped++;
        addLog(`WAIT | Bull ${decision.bullScore?.toFixed(1)||0} Bear ${decision.bearScore?.toFixed(1)||0} | ${decision.reason}`, 'wait');
      }
    }
  } catch (err) {
    addLog(`Analysis error: ${err.message}`, 'error');
  }
}

// ── KEEP-ALIVE ────────────────────────────────────────────────────────────────
function startKeepAlive() {
  const pingUrl = process.env.PUBLIC_URL
    ? `${process.env.PUBLIC_URL}/health`
    : null;

  if (!pingUrl) return;
  console.log(`[KeepAlive] Pinging ${pingUrl} every 4 min`);
  setInterval(async () => {
    try {
      await fetch(pingUrl, { timeout: 10000 });
      state.keepAliveHits++;
    } catch (e) {
      console.warn(`[KeepAlive] Ping failed: ${e.message}`);
    }
  }, 4 * 60 * 1000);
}

// ── COMPUTED STATS ────────────────────────────────────────────────────────────
function computeStats() {
  const t = state.trades;
  if (!t.length) return null;
  const wins   = t.filter(x => x.isWin);
  const losses = t.filter(x => !x.isWin);
  const totalPL = t.reduce((a, x) => a + x.pl, 0);
  const avgWin  = wins.length   ? wins.reduce((a,x)=>a+x.pl,0)/wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((a,x)=>a+x.pl,0)/losses.length : 0;
  const grossW  = wins.reduce((a,x)=>a+x.pl,0);
  const grossL  = Math.abs(losses.reduce((a,x)=>a+x.pl,0));
  const pf      = grossL > 0 ? grossW / grossL : null;

  let peak = STARTING_BALANCE, mdd = 0;
  state.equityHistory.forEach(e => {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak * 100;
    if (dd > mdd) mdd = dd;
  });

  let maxWS=0, maxLS=0, curWS=0, curLS=0;
  t.forEach(x => {
    if (x.isWin) { curWS++; curLS=0; maxWS=Math.max(maxWS,curWS); }
    else         { curLS++; curWS=0; maxLS=Math.max(maxLS,curLS); }
  });

  return {
    total: t.length, wins: wins.length, losses: losses.length,
    winRate:  (wins.length / t.length * 100).toFixed(1),
    totalPL:  totalPL.toFixed(2),
    avgWin:   avgWin.toFixed(2),
    avgLoss:  avgLoss.toFixed(2),
    rr:       avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : null,
    pf:       pf ? pf.toFixed(2) : null,
    best:     Math.max(...t.map(x=>x.pl)).toFixed(2),
    worst:    Math.min(...t.map(x=>x.pl)).toFixed(2),
    mdd:      mdd.toFixed(1),
    maxWinStreak: maxWS, maxLossStreak: maxLS,
  };
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json({
    balance:       state.balance,
    currentPrice:  state.currentPrice,
    priceSource:   state.priceSource,
    openTrade:     state.openTrade,
    equityHistory: state.equityHistory,
    recentLog:     state.log.slice(0, 50),
    stats:         computeStats(),
    activityStats: state.stats,
    lastAnalysis:  state.lastAnalysis,
    startedAt:     state.startedAt,
    tradeCount:    state.trades.length,
    keepAliveHits: state.keepAliveHits,
    dbConnected:   state.dbConnected,
  });
});

app.get('/api/trades', (req, res) => {
  const page  = parseInt(req.query.page  || 1);
  const limit = parseInt(req.query.limit || 50);
  const slice = [...state.trades].reverse().slice((page-1)*limit, page*limit);
  res.json({ trades: slice, total: state.trades.length, page, limit });
});

app.post('/api/close', async (req, res) => {
  if (!state.openTrade) return res.json({ ok: false, message: 'No open position' });
  await closePosition(state.currentPrice, 'Manual');
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), trades: state.trades.length, balance: state.balance, dbConnected: state.dbConnected });
});

// ── CRON: Daily summary midnight UTC ─────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  addLog('Running midnight daily summary…', 'info');
  const t = state.trades;
  if (!t.length) return;
  const today = new Date().toLocaleDateString('en-US');
  const todayTrades = t.filter(x => new Date(x.closeTime).toLocaleDateString('en-US') === today);
  if (!todayTrades.length) return;

  const wins   = todayTrades.filter(x => x.isWin);
  const losses = todayTrades.filter(x => !x.isWin);
  const pls    = todayTrades.map(x => x.pl);
  const data   = {
    date:    new Date().toISOString().split('T')[0],
    trades:  todayTrades.length,
    wins:    wins.length,
    losses:  losses.length,
    winRate: (wins.length / todayTrades.length * 100).toFixed(1),
    grossPL: pls.reduce((a,b)=>a+b,0).toFixed(2),
    balance: state.balance.toFixed(2),
    avgWin:  wins.length ? (wins.reduce((a,x)=>a+x.pl,0)/wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? (losses.reduce((a,x)=>a+x.pl,0)/losses.length).toFixed(2) : 0,
    best:    Math.max(...pls).toFixed(2),
    worst:   Math.min(...pls).toFixed(2),
  };

  await Promise.all([saveDailySummary(data), logDailySummary(state)]);
}, { timezone: 'UTC' });

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  XAU/USD AI Trader — Supabase + Render ║');
  console.log('╚══════════════════════════════════════╝');

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Server] Running on port ${PORT}`);

    // Init DB and load existing trade history
    await initDB();
    state.dbConnected = true;

    const [savedTrades, savedEquity] = await Promise.all([loadTrades(), loadEquityHistory()]);

    if (savedTrades.length) {
      state.trades = savedTrades;
      state.balance = savedTrades.reduce((a, t) => a + t.pl, STARTING_BALANCE);
      addLog(`Loaded ${savedTrades.length} trades from database — balance $${state.balance.toFixed(2)}`, 'info');
    }

    if (savedEquity.length) {
      state.equityHistory = [STARTING_BALANCE, ...savedEquity];
    }

    await ensureHeaders();

    const { price, source } = await fetchLivePrice();
    state.currentPrice = price;
    state.priceSource  = source;
    pushPrice(price);
    addLog(`Started | $${price} from ${source} | ${savedTrades.length} trades restored from DB`, 'info');

    setInterval(priceTick, 5000);
    setInterval(analysisCycle, ANALYSIS_INTERVAL_SEC * 1000);
    analysisCycle();
    startKeepAlive();
  });
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
