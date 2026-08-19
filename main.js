'use strict';

// ── Load env (Replit uses Secrets tab, but dotenv works as fallback) ──────────
require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fetch    = require('node-fetch');
const { fetchLivePrice, pushPrice, getHistory, computeIndicators, decide } = require('./engine');
const { ensureHeaders, logTrade, logDailySummary } = require('./sheets');

const app  = express();
const PORT = process.env.PORT || 3000;
const STARTING_BALANCE      = parseFloat(process.env.STARTING_BALANCE || 10000);
const ANALYSIS_INTERVAL_SEC = parseInt(process.env.ANALYSIS_INTERVAL_SECONDS || 30);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── TRADER STATE ──────────────────────────────────────────────────────────────
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

  if (reason === 'TP')     state.stats.tpHits++;
  else if (reason === 'SL') state.stats.slHits++;
  else                      state.stats.manualCloses++;

  addLog(`EXIT ${closed.type.toUpperCase()} @ $${price} | ${reason} | P&L: ${pl>=0?'+':''}$${pl}`, isWin ? 'win' : 'loss');
  await logTrade(closed);
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

// ── KEEP-ALIVE (critical for Replit free tier) ────────────────────────────────
// Replit sleeps inactive repls after ~1 hour on the free tier.
// This self-ping every 4 minutes prevents that.
function startKeepAlive() {
  // We need the public Replit URL — it's set as REPL_SLUG + REPL_OWNER env vars
  const replSlug  = process.env.REPL_SLUG;
  const replOwner = process.env.REPL_OWNER;

  let pingUrl = null;
  if (replSlug && replOwner) {
    pingUrl = `https://${replSlug}.${replOwner}.repl.co/health`;
  } else if (process.env.PUBLIC_URL) {
    pingUrl = `${process.env.PUBLIC_URL}/health`;
  }

  if (!pingUrl) {
    console.log('[KeepAlive] No public URL found — add PUBLIC_URL secret if repl sleeps');
    return;
  }

  console.log(`[KeepAlive] Pinging ${pingUrl} every 4 minutes`);

  setInterval(async () => {
    try {
      const r = await fetch(pingUrl, { timeout: 10000 });
      state.keepAliveHits++;
      console.log(`[KeepAlive] Ping #${state.keepAliveHits} → ${r.status}`);
    } catch (e) {
      console.warn(`[KeepAlive] Ping failed: ${e.message}`);
    }
  }, 4 * 60 * 1000); // every 4 minutes
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

// Health endpoint — also used by keep-alive ping
app.get('/health', (req, res) => {
  res.json({
    ok:        true,
    uptime:    process.uptime(),
    trades:    state.trades.length,
    balance:   state.balance,
    keepAlive: state.keepAliveHits,
  });
});

// ── CRON: Daily summary at midnight UTC ──────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  addLog('Running midnight daily summary…', 'info');
  await logDailySummary(state);
}, { timezone: 'UTC' });

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  XAU/USD AI Trader — Replit Edition  ║');
  console.log('╚══════════════════════════════════════╝');

  // Start web server first so Replit's port check passes immediately
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Server] Running on port ${PORT}`);

    await ensureHeaders();

    const { price, source } = await fetchLivePrice();
    state.currentPrice = price;
    state.priceSource  = source;
    pushPrice(price);
    addLog(`Started | $${price} from ${source}`, 'info');

    // Price tick every 5s (TP/SL monitoring)
    setInterval(priceTick, 5000);

    // AI analysis every N seconds
    setInterval(analysisCycle, ANALYSIS_INTERVAL_SEC * 1000);
    analysisCycle(); // run immediately

    // Keep-alive self-ping
    startKeepAlive();
  });
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
