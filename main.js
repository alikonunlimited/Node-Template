'use strict';
require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fetch    = require('node-fetch');
const {
  fetchLivePrice, pushPrice, getHistory,
  computeIndicators, decide,
  getLotSize, BASE_LOT, TRADE_TARGETS,
} = require('./engine');
const { ensureHeaders, logTrade, logDailySummary } = require('./sheets');
const { initDB, saveTrade, saveEquity, saveDailySummary, loadTrades, loadEquityHistory } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const STARTING_BALANCE      = parseFloat(process.env.STARTING_BALANCE || 10000);
const ANALYSIS_INTERVAL_SEC = parseInt(process.env.ANALYSIS_INTERVAL_SECONDS || 20);
const DAILY_LOSS_LIMIT      = parseFloat(process.env.DAILY_LOSS_LIMIT || 100);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  balance:         STARTING_BALANCE,
  trades:          [],
  openTrades:      [],
  currentPrice:    0,
  priceSource:     'unknown',
  equityHistory:   [STARTING_BALANCE],
  log:             [],
  stats:           { skipped:0, buys:0, sells:0, tpHits:0, slHits:0, manualCloses:0, scalps:0, days:0, swings:0 },
  startedAt:       new Date().toISOString(),
  lastAnalysis:    null,
  keepAliveHits:   0,
  dbConnected:     false,
  consecutiveWins: 0,
  currentLotSize:  BASE_LOT,
  dailyPL:         0,
  dailyPaused:     false,
  dailyResetDate:  new Date().toDateString(),
};

function addLog(msg, type = 'info') {
  const entry = { ts: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 300) state.log.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== state.dailyResetDate) {
    state.dailyPL      = 0;
    state.dailyPaused  = false;
    state.dailyResetDate = today;
    addLog('New day — daily P&L reset. Trading resumed.', 'info');
  }
}

function openPosition(decision, price) {
  const trade = {
    id:         state.trades.length + state.openTrades.length + 1,
    type:       decision.action,
    tradeType:  decision.tradeType,
    entry:      price,
    tp:         decision.tp,
    sl:         decision.sl,
    lots:       decision.lots,
    openTime:   new Date().toISOString(),
    reason:     decision.reason,
    confidence: decision.confidence,
  };
  state.openTrades.push(trade);
  if (decision.action === 'buy') state.stats.buys++;
  else state.stats.sells++;
  if (decision.tradeType === 'scalp') state.stats.scalps++;
  else if (decision.tradeType === 'day') state.stats.days++;
  else state.stats.swings++;
  addLog(`ENTER ${decision.tradeType.toUpperCase()} ${decision.action.toUpperCase()} @ $${price} | TP $${decision.tp} | SL $${decision.sl} | Lots ${decision.lots}`, 'trade');
}

async function closePosition(trade, price, reason) {
  const pips  = trade.type === 'buy' ? price - trade.entry : trade.entry - price;
  const pl    = parseFloat((pips * 100 * trade.lots).toFixed(2));
  const isWin = pl > 0;
  const closed = { ...trade, exit: price, pl, isWin, closeTime: new Date().toISOString(), closeReason: reason };
  state.openTrades = state.openTrades.filter(t => t.id !== trade.id);
  state.trades.push(closed);
  state.balance  = parseFloat((state.balance + pl).toFixed(2));
  state.dailyPL  = parseFloat((state.dailyPL + pl).toFixed(2));
  state.equityHistory.push(state.balance);
  if (isWin) {
    state.consecutiveWins++;
    state.currentLotSize = getLotSize(state.consecutiveWins);
  } else {
    state.consecutiveWins = 0;
    state.currentLotSize  = BASE_LOT;
  }
  if (state.dailyPL <= -DAILY_LOSS_LIMIT && !state.dailyPaused) {
    state.dailyPaused = true;
    addLog(`Daily loss limit -$${DAILY_LOSS_LIMIT} hit. Paused until tomorrow.`, 'error');
  }
  if (reason === 'TP') state.stats.tpHits++;
  else if (reason === 'SL') state.stats.slHits++;
  else state.stats.manualCloses++;
  addLog(`EXIT ${closed.tradeType.toUpperCase()} ${closed.type.toUpperCase()} @ $${price} | ${reason} | P&L: ${pl>=0?'+':''}$${pl} | Daily: ${state.dailyPL>=0?'+':''}$${state.dailyPL} | Streak: ${state.consecutiveWins}`, isWin ? 'win' : 'loss');
  await Promise.all([saveTrade(closed), saveEquity(state.balance), logTrade(closed)]);
}

async function priceTick() {
  const { price, source } = await fetchLivePrice();
  state.currentPrice = price;
  state.priceSource  = source;
  pushPrice(price);
  for (const trade of [...state.openTrades]) {
    if (trade.type === 'buy') {
      if (price >= trade.tp) await closePosition(trade, price, 'TP');
      else if (price <= trade.sl) await closePosition(trade, price, 'SL');
    } else {
      if (price <= trade.tp) await closePosition(trade, price, 'TP');
      else if (price >= trade.sl) await closePosition(trade, price, 'SL');
    }
  }
}

async function analysisCycle() {
  try {
    checkDailyReset();
    await priceTick();
    if (state.dailyPaused) {
      addLog(`Paused — daily limit hit. Daily P&L: $${state.dailyPL}`, 'wait');
      return;
    }
    const price   = state.currentPrice;
    const history = getHistory();
    const inds    = computeIndicators(price, history);
    const hourUTC = new Date().getUTCHours();

    // SCALP
    if (!state.openTrades.find(t => t.tradeType === 'scalp')) {
      const dec = decide(price, inds, hourUTC, state.consecutiveWins, 'scalp');
      if (dec.action !== 'wait') openPosition(dec, price);
      else { state.stats.skipped++; addLog(`SCALP WAIT | ${dec.reason}`, 'wait'); }
    } else {
      const t = state.openTrades.find(t => t.tradeType === 'scalp');
      const u = t.type==='buy' ? (price-t.entry)*100*t.lots : (t.entry-price)*100*t.lots;
      addLog(`SCALP HOLD ${t.type.toUpperCase()} | Unreal ${u>=0?'+':''}$${u.toFixed(2)}`, 'hold');
    }

    // DAY
    if (!state.openTrades.find(t => t.tradeType === 'day')) {
      const dec = decide(price, inds, hourUTC, state.consecutiveWins, 'day');
      if (dec.action !== 'wait') openPosition(dec, price);
      else addLog(`DAY WAIT | ${dec.reason}`, 'wait');
    } else {
      const t = state.openTrades.find(t => t.tradeType === 'day');
      const u = t.type==='buy' ? (price-t.entry)*100*t.lots : (t.entry-price)*100*t.lots;
      addLog(`DAY HOLD ${t.type.toUpperCase()} | Unreal ${u>=0?'+':''}$${u.toFixed(2)}`, 'hold');
    }

    // SWING
    if (!state.openTrades.find(t => t.tradeType === 'swing')) {
      const dec = decide(price, inds, hourUTC, state.consecutiveWins, 'swing');
      if (dec.action !== 'wait') openPosition(dec, price);
      else addLog(`SWING WAIT | ${dec.reason}`, 'wait');
    } else {
      const t = state.openTrades.find(t => t.tradeType === 'swing');
      const u = t.type==='buy' ? (price-t.entry)*100*t.lots : (t.entry-price)*100*t.lots;
      addLog(`SWING HOLD ${t.type.toUpperCase()} | Unreal ${u>=0?'+':''}$${u.toFixed(2)}`, 'hold');
    }

    state.lastAnalysis = {
      ts: new Date().toISOString(), price, hourUTC,
      priceSource: state.priceSource,
      consecutiveWins: state.consecutiveWins,
      currentLotSize:  state.currentLotSize,
      dailyPL:         state.dailyPL,
      dailyPaused:     state.dailyPaused,
    };
  } catch (err) {
    addLog(`Analysis error: ${err.message}`, 'error');
  }
}

// TEST TRADE
app.post('/api/test-trade', async (req, res) => {
  try {
    const price = state.currentPrice || 4603;
    const closed = {
      id: 99999, type: 'buy', tradeType: 'scalp',
      entry: price, exit: parseFloat((price+3).toFixed(2)),
      tp: parseFloat((price+3).toFixed(2)), sl: parseFloat((price-1.5).toFixed(2)),
      lots: 0.01, pl: 0.30, isWin: true,
      openTime: new Date().toISOString(), closeTime: new Date().toISOString(),
      closeReason: 'TEST', reason: 'TEST TRADE — confirming pipeline', confidence: 1.0,
    };
    state.trades.push(closed);
    state.balance = parseFloat((state.balance + 0.30).toFixed(2));
    state.equityHistory.push(state.balance);
    addLog('Test trade executed — logging to Sheets + DB', 'info');
    await Promise.all([saveTrade(closed), saveEquity(state.balance), logTrade(closed)]);
    res.json({ ok: true, trade: closed });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

function startKeepAlive() {
  const pingUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/health` : null;
  if (!pingUrl) return;
  setInterval(async () => {
    try { await fetch(pingUrl, { timeout: 10000 }); state.keepAliveHits++; }
    catch (e) { console.warn(`[KeepAlive] ${e.message}`); }
  }, 4 * 60 * 1000);
}

function computeStats() {
  const t = state.trades;
  if (!t.length) return null;
  const wins = t.filter(x => x.isWin), losses = t.filter(x => !x.isWin);
  const totalPL = t.reduce((a,x) => a+x.pl, 0);
  const avgWin  = wins.length   ? wins.reduce((a,x)=>a+x.pl,0)/wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((a,x)=>a+x.pl,0)/losses.length : 0;
  const grossW  = wins.reduce((a,x)=>a+x.pl,0);
  const grossL  = Math.abs(losses.reduce((a,x)=>a+x.pl,0));
  const pf      = grossL > 0 ? grossW/grossL : null;
  let peak = STARTING_BALANCE, mdd = 0;
  state.equityHistory.forEach(e => { if(e>peak)peak=e; const dd=(peak-e)/peak*100; if(dd>mdd)mdd=dd; });
  let maxWS=0,maxLS=0,curWS=0,curLS=0;
  t.forEach(x => { if(x.isWin){curWS++;curLS=0;maxWS=Math.max(maxWS,curWS);}else{curLS++;curWS=0;maxLS=Math.max(maxLS,curLS);} });
  const scalps=t.filter(x=>x.tradeType==='scalp'), days=t.filter(x=>x.tradeType==='day'), swings=t.filter(x=>x.tradeType==='swing');
  return {
    total:t.length, wins:wins.length, losses:losses.length,
    winRate:(wins.length/t.length*100).toFixed(1),
    totalPL:totalPL.toFixed(2), avgWin:avgWin.toFixed(2), avgLoss:avgLoss.toFixed(2),
    rr:avgLoss!==0?Math.abs(avgWin/avgLoss).toFixed(2):null,
    pf:pf?pf.toFixed(2):null,
    best:Math.max(...t.map(x=>x.pl)).toFixed(2), worst:Math.min(...t.map(x=>x.pl)).toFixed(2),
    mdd:mdd.toFixed(1), maxWinStreak:maxWS, maxLossStreak:maxLS,
    scalpsTotal:scalps.length, daysTotal:days.length, swingsTotal:swings.length,
    scalpWinRate:scalps.length?(scalps.filter(x=>x.isWin).length/scalps.length*100).toFixed(1):null,
    dayWinRate:days.length?(days.filter(x=>x.isWin).length/days.length*100).toFixed(1):null,
    swingWinRate:swings.length?(swings.filter(x=>x.isWin).length/swings.length*100).toFixed(1):null,
  };
}

app.get('/api/state', (req, res) => {
  res.json({
    balance:state.balance, currentPrice:state.currentPrice, priceSource:state.priceSource,
    openTrades:state.openTrades, equityHistory:state.equityHistory,
    recentLog:state.log.slice(0,60), stats:computeStats(),
    activityStats:state.stats, lastAnalysis:state.lastAnalysis,
    startedAt:state.startedAt, tradeCount:state.trades.length,
    keepAliveHits:state.keepAliveHits, dbConnected:state.dbConnected,
    consecutiveWins:state.consecutiveWins, currentLotSize:state.currentLotSize,
    dailyPL:state.dailyPL, dailyPaused:state.dailyPaused, dailyLossLimit:DAILY_LOSS_LIMIT,
  });
});

app.get('/api/trades', (req, res) => {
  const page=parseInt(req.query.page||1), limit=parseInt(req.query.limit||50);
  const slice=[...state.trades].reverse().slice((page-1)*limit,page*limit);
  res.json({trades:slice, total:state.trades.length, page, limit});
});

app.post('/api/close', async (req, res) => {
  const { id } = req.body;
  const trade = id ? state.openTrades.find(t=>t.id===id) : state.openTrades[0];
  if (!trade) return res.json({ok:false, message:'No open position'});
  await closePosition(trade, state.currentPrice, 'Manual');
  res.json({ok:true});
});

app.post('/api/closeAll', async (req, res) => {
  for (const trade of [...state.openTrades]) await closePosition(trade, state.currentPrice, 'Manual');
  res.json({ok:true});
});

app.get('/health', (req, res) => {
  res.json({ok:true, uptime:process.uptime(), trades:state.trades.length, balance:state.balance, dailyPL:state.dailyPL, dailyPaused:state.dailyPaused, priceSource:state.priceSource});
});

cron.schedule('0 0 * * *', async () => {
  const today = new Date().toLocaleDateString('en-US');
  const todayTrades = state.trades.filter(x => new Date(x.closeTime).toLocaleDateString('en-US')===today);
  if (!todayTrades.length) return;
  const wins=todayTrades.filter(x=>x.isWin), losses=todayTrades.filter(x=>!x.isWin), pls=todayTrades.map(x=>x.pl);
  const data = {
    date:new Date().toISOString().split('T')[0], trades:todayTrades.length,
    wins:wins.length, losses:losses.length,
    winRate:(wins.length/todayTrades.length*100).toFixed(1),
    grossPL:pls.reduce((a,b)=>a+b,0).toFixed(2), balance:state.balance.toFixed(2),
    avgWin:wins.length?(wins.reduce((a,x)=>a+x.pl,0)/wins.length).toFixed(2):0,
    avgLoss:losses.length?(losses.reduce((a,x)=>a+x.pl,0)/losses.length).toFixed(2):0,
    best:Math.max(...pls).toFixed(2), worst:Math.min(...pls).toFixed(2),
  };
  await Promise.all([saveDailySummary(data), logDailySummary(state)]);
}, { timezone:'UTC' });

async function start() {
  console.log('XAU/USD AI Trader — Scalp + Day + Swing + OANDA Live');
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Server] Port ${PORT}`);
    await initDB();
    state.dbConnected = true;
    const [savedTrades, savedEquity] = await Promise.all([loadTrades(), loadEquityHistory()]);
    if (savedTrades.length) {
      state.trades  = savedTrades;
      state.balance = savedTrades.reduce((a,t)=>a+t.pl, STARTING_BALANCE);
      let streak=0;
      for (let i=savedTrades.length-1;i>=0;i--) { if(savedTrades[i].isWin)streak++; else break; }
      state.consecutiveWins = streak;
      state.currentLotSize  = getLotSize(streak);
      addLog(`Restored ${savedTrades.length} trades | Balance $${state.balance.toFixed(2)}`, 'info');
    }
    if (savedEquity.length) state.equityHistory = [STARTING_BALANCE, ...savedEquity];
    await ensureHeaders();
    const { price, source } = await fetchLivePrice();
    state.currentPrice = price;
    state.priceSource  = source;
    pushPrice(price);
    addLog(`Live | $${price} from ${source} | OANDA key: ${process.env.OANDA_API_KEY ? 'SET' : 'MISSING'}`, 'info');
    setInterval(priceTick, 5000);
    setInterval(analysisCycle, ANALYSIS_INTERVAL_SEC * 1000);
    analysisCycle();
    startKeepAlive();
  });
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });