'use strict';

// ── SELF-LEARNING PERFORMANCE TRACKER ────────────────────────────────────────
const performance = {
  conditions: {
    rsi_oversold_bull:    { wins: 0, losses: 0 },
    rsi_overbought_bear:  { wins: 0, losses: 0 },
    stoch_oversold_bull:  { wins: 0, losses: 0 },
    stoch_overbought_bear:{ wins: 0, losses: 0 },
    macd_bull:            { wins: 0, losses: 0 },
    macd_bear:            { wins: 0, losses: 0 },
    ema_bull_align:       { wins: 0, losses: 0 },
    ema_bear_align:       { wins: 0, losses: 0 },
    momentum_up:          { wins: 0, losses: 0 },
    momentum_down:        { wins: 0, losses: 0 },
    best_hour:            { wins: 0, losses: 0 },
    worst_hour:           { wins: 0, losses: 0 },
    near_support:         { wins: 0, losses: 0 },
    near_resistance:      { wins: 0, losses: 0 },
    high_volume:          { wins: 0, losses: 0 },
    low_volume:           { wins: 0, losses: 0 },
    htf_confirmed:        { wins: 0, losses: 0 },
    htf_conflicted:       { wins: 0, losses: 0 },
  },
  byType: {
    scalp_buy:  { wins: 0, losses: 0, totalPL: 0 },
    scalp_sell: { wins: 0, losses: 0, totalPL: 0 },
    day_buy:    { wins: 0, losses: 0, totalPL: 0 },
    day_sell:   { wins: 0, losses: 0, totalPL: 0 },
    swing_buy:  { wins: 0, losses: 0, totalPL: 0 },
    swing_sell: { wins: 0, losses: 0, totalPL: 0 },
  },
  recentTrades:         [],
  totalTrades:          0,
  consecutiveLosses:    0,
  maxConsecutiveLosses: 0,
};

function recordOutcome(trade) {
  const { type, tradeType, pl, isWin, conditions } = trade;
  const key = `${tradeType}_${type}`;
  if (performance.byType[key]) {
    if (isWin) performance.byType[key].wins++;
    else        performance.byType[key].losses++;
    performance.byType[key].totalPL += pl;
  }
  if (conditions) {
    conditions.forEach(c => {
      if (performance.conditions[c]) {
        if (isWin) performance.conditions[c].wins++;
        else        performance.conditions[c].losses++;
      }
    });
  }
  performance.recentTrades.push({ isWin, pl, type, tradeType });
  if (performance.recentTrades.length > 20) performance.recentTrades.shift();
  if (!isWin) {
    performance.consecutiveLosses++;
    performance.maxConsecutiveLosses = Math.max(performance.maxConsecutiveLosses, performance.consecutiveLosses);
  } else {
    performance.consecutiveLosses = 0;
  }
  performance.totalTrades++;
}

function getConditionWeight(condition, baseWeight) {
  const perf = performance.conditions[condition];
  if (!perf || (perf.wins + perf.losses) < 5) return baseWeight;
  const wr = perf.wins / (perf.wins + perf.losses);
  if (wr > 0.6) return baseWeight * 1.4;
  if (wr < 0.4) return baseWeight * 0.5;
  return baseWeight;
}

function getSizeMultiplier(confidence) {
  const losses = performance.consecutiveLosses;
  if (losses >= 5) return 0;
  if (losses >= 3) return 0.5;
  return Math.max(0.5, Math.min(1.0, confidence));
}

function getPerformanceSummary() {
  const recent = performance.recentTrades;
  return {
    recentWinRate:     recent.length ? recent.filter(t => t.isWin).length / recent.length : null,
    consecutiveLosses: performance.consecutiveLosses,
    byType:            performance.byType,
    conditions:        performance.conditions,
    totalTrades:       performance.totalTrades,
  };
}

// ── SUPPORT / RESISTANCE ──────────────────────────────────────────────────────
function computeSRLevels(price, history) {
  if (history.length < 20) return { nearSupport: false, nearResistance: false, srStrength: 0 };
  const recent = history.slice(-50);
  const highs = [], lows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i-2] && recent[i] > recent[i+1] && recent[i] > recent[i+2]) highs.push(recent[i]);
    if (recent[i] < recent[i-1] && recent[i] < recent[i-2] && recent[i] < recent[i+1] && recent[i] < recent[i+2]) lows.push(recent[i]);
  }
  const ZONE = price * 0.001;
  const nearSupport    = lows.some(l => Math.abs(price - l) < ZONE);
  const nearResistance = highs.some(h => Math.abs(price - h) < ZONE);
  const srStrength = nearSupport || nearResistance
    ? Math.min((nearSupport ? lows.filter(l => Math.abs(price-l) < ZONE*2).length : 0) + (nearResistance ? highs.filter(h => Math.abs(price-h) < ZONE*2).length : 0), 5)
    : 0;
  return { nearSupport, nearResistance, srStrength, highs, lows };
}

// ── VOLUME ────────────────────────────────────────────────────────────────────
function computeVolume(history) {
  if (history.length < 20) return { volumeScore: 0, highVolume: false, lowVolume: false };
  const recent20 = history.slice(-20);
  const recent5  = history.slice(-5);
  const atr20 = recent20.slice(1).reduce((sum, p, i) => sum + Math.abs(p - recent20[i]), 0) / 19;
  const atr5  = recent5.slice(1).reduce((sum, p, i) => sum + Math.abs(p - recent5[i]), 0) / 4;
  const volumeRatio = atr5 / (atr20 || 0.001);
  return { volumeScore: volumeRatio, highVolume: volumeRatio > 1.5, lowVolume: volumeRatio < 0.5, atr20, atr5 };
}

// ── MULTI-TIMEFRAME ───────────────────────────────────────────────────────────
function computeHTF(price, history) {
  if (history.length < 40) return { htfBull: null, htfBear: null, confirmed: false };
  const h1_slice = history.slice(-40);
  const h4_slice = history.slice(-Math.min(160, history.length));
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const h1_ma = avg(h1_slice), h4_ma = avg(h4_slice);
  const h1_bull = price > h1_ma, h4_bull = price > h4_ma;
  const r = h1_slice;
  let g = 0, l = 0, gc = 0, lc = 0;
  for (let i = 1; i < r.length; i++) {
    const d = r[i] - r[i-1];
    if (d > 0) { g += d; gc++; } else { l += Math.abs(d); lc++; }
  }
  const h1_rsi = 100 - (100 / (1 + (gc ? g/gc : 0) / (lc ? l/lc : 0.001)));
  const htfBull = h1_bull && h4_bull && h1_rsi < 65;
  const htfBear = !h1_bull && !h4_bull && h1_rsi > 35;
  return { htfBull, htfBear, h1_bull, h4_bull, h1_rsi, confirmed: htfBull || htfBear };
}

// ── SPREAD MONITOR ────────────────────────────────────────────────────────────
let spreadHistory = [];
function updateSpread(bid, ask) {
  if (!bid || !ask) return;
  spreadHistory.push(ask - bid);
  if (spreadHistory.length > 50) spreadHistory.shift();
}
function getSpreadScore(currentSpread) {
  if (spreadHistory.length < 5) return { spreadOk: true, spreadRatio: 1 };
  const avg = spreadHistory.reduce((a, b) => a + b, 0) / spreadHistory.length;
  const ratio = currentSpread / (avg || 0.001);
  return { spreadOk: ratio < 2.0, spreadRatio: ratio, avgSpread: avg };
}

// ── YOUR HISTORICAL PATTERNS ──────────────────────────────────────────────────
const YOUR_PATTERNS = {
  winRate:          0.24,
  bestHoursUTC:     [1, 5, 15],
  worstHoursUTC:    [2, 3, 4, 16, 19],
  breakEvenWinRate: 0.37,
  dominantMistake:  'buy_into_downtrend',
};

const LOT_PROGRESSION = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32];
const BASE_LOT = 0.01;
function getLotSize(w) { return LOT_PROGRESSION[Math.min(w, LOT_PROGRESSION.length - 1)]; }

const TRADE_TARGETS = {
  scalp: { pips_tp: 3,   pips_sl: 0.75 },
  day:   { pips_tp: 10,  pips_sl: 3    },
  swing: { pips_tp: 100, pips_sl: 50   },
};

const MAX_LOSS_PER_TRADE    = 15;
const MARKET_CLOSE_HOUR_UTC = 21;
const MARKET_OPEN_HOUR_UTC  = 22;
const MAX_HISTORY = 1000;
let priceHistory   = [];
let lastKnownPrice = 4336;

function pushPrice(p) { priceHistory.push(p); if (priceHistory.length > MAX_HISTORY) priceHistory.shift(); }
function getHistory() { return [...priceHistory]; }

const fetch = require('node-fetch');

// ── PRICE FETCH ───────────────────────────────────────────────────────────────
async function fetchLivePrice() {
  // SOURCE 1: Yahoo Finance (no API key)
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1m&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 5000 }
    );
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (p > 1800 && p < 7000) {
        lastKnownPrice = p;
        console.log(`[Price] Yahoo Finance → $${p}`);
        return { price: p, source: 'Yahoo Finance' };
      }
    }
  } catch (e) { console.log(`[Price] Yahoo: ${e.message}`); }

  // SOURCE 2: Twelve Data
  try {
    const key = process.env.TWELVE_DATA_KEY;
    if (key) {
      const r = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${key}`, { timeout: 5000 });
      if (r.ok) {
        const d = await r.json();
        const p = parseFloat(d?.price);
        if (p > 1800 && p < 7000) { lastKnownPrice = p; return { price: p, source: 'Twelve Data' }; }
      }
    }
  } catch (e) { console.log(`[Price] Twelve Data: ${e.message}`); }

  // SOURCE 3: OANDA
  try {
    const apiKey = process.env.OANDA_API_KEY;
    if (apiKey) {
      const accR = await fetch('https://api-fxtrade.oanda.com/v3/accounts', {
        headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000,
      });
      if (accR.ok) {
        const accD = await accR.json();
        const accountId = accD?.accounts?.[0]?.id;
        if (accountId) {
          const r = await fetch(
            `https://api-fxtrade.oanda.com/v3/accounts/${accountId}/pricing?instruments=XAU_USD`,
            { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 }
          );
          if (r.ok) {
            const d = await r.json();
            const priceData = d?.prices?.[0];
            if (priceData) {
              const bid = parseFloat(priceData.bids?.[0]?.price);
              const ask = parseFloat(priceData.asks?.[0]?.price);
              updateSpread(bid, ask);
              const mid = parseFloat(((bid + ask) / 2).toFixed(2));
              if (mid > 1800 && mid < 7000) { lastKnownPrice = mid; return { price: mid, source: 'OANDA Live', bid, ask, spread: ask - bid }; }
            }
          }
        }
      }
    }
  } catch (e) { console.log(`[Price] OANDA: ${e.message}`); }

  // SOURCE 4: goldprice.org
  try {
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { headers: { Accept: 'application/json' }, timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.items?.[0]?.xauPrice);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; return { price: p, source: 'goldprice.org' }; }
    }
  } catch (_) {}

  // FALLBACK
  const drift = (Math.random() - 0.48) * 0.5;
  return { price: parseFloat((lastKnownPrice + drift).toFixed(2)), source: 'simulated' };
}

// ── INDICATORS ────────────────────────────────────────────────────────────────
function computeIndicators(price, history) {
  const len = history.length;
  if (len < 5) return null;
  const slice = n => history.slice(-Math.min(n, len));
  const avg   = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ma5 = avg(slice(5)), ma14 = avg(slice(14)), ma21 = avg(slice(21));
  const r14 = slice(14);
  let g = 0, l = 0, gc = 0, lc = 0;
  for (let i = 1; i < r14.length; i++) {
    const d = r14[i] - r14[i-1];
    if (d > 0) { g += d; gc++; } else { l += Math.abs(d); lc++; }
  }
  const rsi   = 100 - (100 / (1 + (gc ? g/gc : 0) / (lc ? l/lc : 0.001)));
  const st    = slice(14), hi = Math.max(...st), lo = Math.min(...st);
  const stoch = hi !== lo ? ((price - lo) / (hi - lo)) * 100 : 50;
  const macd  = avg(slice(12)) - avg(slice(26));
  const momentum = len >= 5 ? price - history[len-5] : 0;
  const s14 = slice(14);
  const diffs = s14.slice(1).map((v, i) => Math.abs(v - s14[i]));
  const vol = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0.5;
  return { rsi, stoch, macd, momentum, vol, ma5, ma14, ma21, trend: price > ma14 ? 'bull' : 'bear', ema_align: ma5 > ma14 && ma14 > ma21 };
}

// ── DECISION ENGINE ───────────────────────────────────────────────────────────
function decide(price, indicators, hourUTC, consecutiveWins, tradeType = 'scalp', extraData = {}) {
  const target = TRADE_TARGETS[tradeType];
  const lots   = getLotSize(consecutiveWins);

  const now = new Date();
  const hourUTCnow = now.getUTCHours();
  const dayUTC = now.getUTCDay(); // 0=Sun, 6=Sat

  // Gold trades Sun 23:00 UTC to Fri 21:00 UTC with 1hr break daily at 21:00-22:00
  const isSaturdayClosed = dayUTC === 6; // all Saturday
  const isSundayPreOpen  = dayUTC === 0 && hourUTCnow < 23; // Sunday before 11pm UTC
  const isDailyBreak     = hourUTCnow >= 21 && hourUTCnow < 22; // 5-6pm EST daily
  const isFridayClose    = dayUTC === 5 && hourUTCnow >= 21; // Friday after 5pm EST

  const isMarketClosed = isSaturdayClosed || isSundayPreOpen || isDailyBreak || isFridayClose;
  if (isMarketClosed) {
    return { action:'wait', tradeType, reason:`Market closed — ${isSaturdayClosed?'Saturday':isSundayPreOpen?'Sunday pre-open':isDailyBreak?'Daily break 5-6pm EST':'Friday close'}`, confidence:0, bullScore:0, bearScore:0 };
  }

  const { spread } = extraData;
  if (spread) {
    const sc = getSpreadScore(spread);
    if (!sc.spreadOk) return { action:'wait', tradeType, reason:`Spread too wide (${sc.spreadRatio.toFixed(1)}x)`, confidence:0, bullScore:0, bearScore:0 };
  }

  const sizeM = getSizeMultiplier(0.5);
  if (sizeM === 0) return { action:'wait', tradeType, reason:`Paused — ${performance.consecutiveLosses} straight losses`, confidence:0, bullScore:0, bearScore:0 };

  const makeDecision = (action, reason, conf, conditions) => {
    const sl_dist = Math.min(target.pips_sl, MAX_LOSS_PER_TRADE / (lots * 100));
    const tp = action === 'buy' ? parseFloat((price + target.pips_tp).toFixed(2)) : parseFloat((price - target.pips_tp).toFixed(2));
    const sl = action === 'buy' ? parseFloat((price - sl_dist).toFixed(2))         : parseFloat((price + sl_dist).toFixed(2));
    return { action, tradeType, reason, confidence: conf, bullScore:0, bearScore:0, tp, sl, lots, conditions };
  };

  if (!indicators) return makeDecision(Math.random() > 0.5 ? 'buy' : 'sell', 'Building history', 0.5, []);

  const { rsi, stoch, macd, momentum, trend, ema_align } = indicators;
  const isBest  = YOUR_PATTERNS.bestHoursUTC.includes(hourUTC);
  const isWorst = YOUR_PATTERNS.worstHoursUTC.includes(hourUTC);
  let bull = 0, bear = 0;
  const log = [], activeConditions = [];

  // HTF
  const htf = extraData.htf || computeHTF(price, priceHistory);
  if (htf.htfBull)       { bull += getConditionWeight('htf_confirmed', 2); log.push('HTF bull'); activeConditions.push('htf_confirmed'); }
  else if (htf.htfBear)  { bear += getConditionWeight('htf_confirmed', 2); log.push('HTF bear'); activeConditions.push('htf_confirmed'); }
  else                   { bull -= 0.5; bear -= 0.5; log.push('HTF conflicted'); activeConditions.push('htf_conflicted'); }

  // S/R
  const sr = extraData.sr || computeSRLevels(price, priceHistory);
  if (sr.nearSupport)    { bull += getConditionWeight('near_support', 1.5) * (sr.srStrength / 3); log.push(`Near S (str:${sr.srStrength})`); activeConditions.push('near_support'); }
  if (sr.nearResistance) { bear += getConditionWeight('near_resistance', 1.5) * (sr.srStrength / 3); log.push(`Near R (str:${sr.srStrength})`); activeConditions.push('near_resistance'); }
  if (!sr.nearSupport && !sr.nearResistance) { bull -= 0.5; bear -= 0.5; log.push('Mid-range'); }

  // Volume
  const vol = extraData.vol || computeVolume(priceHistory);
  if (vol.highVolume)    { const w = getConditionWeight('high_volume', 1.5); bull += w; bear += w; log.push(`Hi vol (${vol.volumeScore.toFixed(1)}x)`); activeConditions.push('high_volume'); }
  else if (vol.lowVolume){ bull -= 1; bear -= 1; log.push(`Lo vol (${vol.volumeScore.toFixed(1)}x)`); activeConditions.push('low_volume'); }

  // Standard indicators
  if (rsi < 40)        { const w = getConditionWeight('rsi_oversold_bull', 2);    bull += w; log.push(`RSI bull ${rsi.toFixed(0)}`); activeConditions.push('rsi_oversold_bull'); }
  else if (rsi > 60)   { const w = getConditionWeight('rsi_overbought_bear', 2);  bear += w; log.push(`RSI bear ${rsi.toFixed(0)}`); activeConditions.push('rsi_overbought_bear'); }
  if (stoch < 30)      { const w = getConditionWeight('stoch_oversold_bull', 2);  bull += w; log.push('Stoch OS'); activeConditions.push('stoch_oversold_bull'); }
  else if (stoch > 70) { const w = getConditionWeight('stoch_overbought_bear', 2);bear += w; log.push('Stoch OB'); activeConditions.push('stoch_overbought_bear'); }
  if (macd > 0)        { const w = getConditionWeight('macd_bull', 1); bull += w; log.push('MACD bull'); activeConditions.push('macd_bull'); }
  else                 { const w = getConditionWeight('macd_bear', 1); bear += w; log.push('MACD bear'); activeConditions.push('macd_bear'); }
  if (ema_align)       { const w = getConditionWeight('ema_bull_align', 2); bull += w; log.push('EMA bull'); activeConditions.push('ema_bull_align'); }
  else                 { const w = getConditionWeight('ema_bear_align', 1); bear += w; log.push('EMA bear'); activeConditions.push('ema_bear_align'); }
  if (momentum > 0)    { const w = getConditionWeight('momentum_up', 1);   bull += w; activeConditions.push('momentum_up'); }
  else                 { const w = getConditionWeight('momentum_down', 1);  bear += w; activeConditions.push('momentum_down'); }

  if (isWorst) { bull -= 1.5; bear -= 1.5; log.push(`⚠ Worst hour`); activeConditions.push('worst_hour'); }
  if (isBest)  { bull += 1;   bear += 1;   log.push(`✓ Best hour`);  activeConditions.push('best_hour'); }

  if (trend === 'bear' && bull > bear) { bull -= 2; log.push('AI correction: trend bearish'); }

  const buyPerf = performance.byType[`${tradeType}_buy`];
  if (buyPerf && (buyPerf.wins + buyPerf.losses) >= 10) {
    const wr = buyPerf.wins / (buyPerf.wins + buyPerf.losses);
    if (wr < 0.3) { bull -= 1.5; log.push(`AI: buy WR ${(wr*100).toFixed(0)}%`); }
  }
  const sellPerf = performance.byType[`${tradeType}_sell`];
  if (sellPerf && (sellPerf.wins + sellPerf.losses) >= 5) {
    const wr = sellPerf.wins / (sellPerf.wins + sellPerf.losses);
    if (wr > 0.5) { bear += 1; log.push(`AI: sell WR ${(wr*100).toFixed(0)}%`); }
  }

  const topScore   = Math.max(bull, bear);
  const confidence = Math.min(topScore / 10, 1);
  const minScore   = performance.consecutiveLosses >= 3 ? 5 : 3;

  if (topScore < minScore) return { action:'wait', tradeType, reason:`Score ${topScore.toFixed(1)} < ${minScore} | ${log.join(' · ')}`, confidence, bullScore:bull, bearScore:bear };

  const action = bull >= bear ? 'buy' : 'sell';
  return makeDecision(action, `[${action.toUpperCase()}] B${bull.toFixed(1)}/S${bear.toFixed(1)} | ${log.join(' · ')}`, confidence, activeConditions);
}

module.exports = {
  fetchLivePrice, pushPrice, getHistory,
  computeIndicators, computeSRLevels, computeVolume, computeHTF,
  decide, recordOutcome, getPerformanceSummary,
  getLotSize, LOT_PROGRESSION, BASE_LOT,
  TRADE_TARGETS, YOUR_PATTERNS,
  MARKET_CLOSE_HOUR_UTC, MARKET_OPEN_HOUR_UTC,
  MAX_LOSS_PER_TRADE, updateSpread, getSpreadScore,
};