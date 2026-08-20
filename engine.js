'use strict';

// ── YOUR HISTORICAL PATTERNS ──────────────────────────────────────────────────
const YOUR_PATTERNS = {
  winRate:          0.24,
  bestHoursUTC:     [1, 5, 15],
  worstHoursUTC:    [2, 3, 4, 16, 19],
  breakEvenWinRate: 0.37,
  dominantMistake:  'buy_into_downtrend',
};

// ── ANTI-MARTINGALE LOT SIZING ────────────────────────────────────────────────
// Increase lots on consecutive wins, reset to base on any loss
const LOT_PROGRESSION = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32];
const BASE_LOT = 0.01;

function getLotSize(consecutiveWins) {
  const idx = Math.min(consecutiveWins, LOT_PROGRESSION.length - 1);
  return LOT_PROGRESSION[idx];
}

// ── PRICE HISTORY ─────────────────────────────────────────────────────────────
const MAX_HISTORY = 1000;
let priceHistory  = [];
let lastKnownPrice = 4351;

function pushPrice(p) {
  priceHistory.push(p);
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

function getHistory() { return [...priceHistory]; }

// ── LIVE PRICE FETCH ──────────────────────────────────────────────────────────
const fetch = require('node-fetch');

async function fetchLivePrice() {
  try {
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD',
      { headers: { Accept: 'application/json' }, timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.items?.[0]?.xauPrice);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; return { price: p, source: 'goldprice.org' }; }
    }
  } catch (_) {}

  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=XAU&to=USD', { timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.rates?.USD);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; return { price: p, source: 'frankfurter' }; }
    }
  } catch (_) {}

  const drift = (Math.random() - 0.48) * 0.8;
  const p = parseFloat((lastKnownPrice + drift).toFixed(2));
  return { price: p, source: 'simulated' };
}

// ── INDICATOR ENGINE ──────────────────────────────────────────────────────────
function computeIndicators(price, history, timeframe = 'scalp') {
  const len = history.length;
  if (len < 10) return null;

  const slice = (n) => history.slice(-Math.min(n, len));
  const avg   = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  // Timeframe-specific periods
  const periods = timeframe === 'swing'
    ? { rsi: 21, stoch: 21, fast: 21, slow: 50, trend: 50 }
    : { rsi: 14, stoch: 14, fast: 9,  slow: 21, trend: 21 };

  const ma_fast  = avg(slice(periods.fast));
  const ma_slow  = avg(slice(periods.slow));
  const ma_trend = avg(slice(periods.trend));
  const ma200    = avg(slice(Math.min(200, len)));

  // RSI
  const r = slice(periods.rsi);
  let gains = 0, losses = 0, gc = 0, lc = 0;
  for (let i = 1; i < r.length; i++) {
    const d = r[i] - r[i - 1];
    if (d > 0) { gains += d; gc++; } else { losses += Math.abs(d); lc++; }
  }
  const avgG = gc ? gains / gc : 0;
  const avgL = lc ? losses / lc : 0.001;
  const rsi  = 100 - (100 / (1 + avgG / avgL));

  // Stochastic
  const st   = slice(periods.stoch);
  const hi   = Math.max(...st);
  const lo   = Math.min(...st);
  const stoch = hi !== lo ? ((price - lo) / (hi - lo)) * 100 : 50;

  // MACD
  const emaF = avg(slice(Math.min(12, len)));
  const emaS = avg(slice(Math.min(26, len)));
  const macd = emaF - emaS;

  // Momentum
  const lookback = timeframe === 'swing' ? 20 : 10;
  const momentum = len >= lookback ? price - history[len - lookback] : 0;

  // Volatility
  const s14  = slice(14);
  const diffs = s14.slice(1).map((v, i) => Math.abs(v - s14[i]));
  const vol   = avg(diffs);

  // Bollinger Bands
  const bb_slice = slice(20);
  const bb_avg   = avg(bb_slice);
  const bb_std   = Math.sqrt(bb_slice.reduce((a, v) => a + Math.pow(v - bb_avg, 2), 0) / bb_slice.length);
  const bb_upper = bb_avg + 2 * bb_std;
  const bb_lower = bb_avg - 2 * bb_std;
  const bb_pos   = price > bb_upper ? 'upper' : price < bb_lower ? 'lower' : 'mid';

  return {
    rsi, stoch, macd, momentum, vol,
    ma_fast, ma_slow, ma_trend, ma200,
    bb_upper, bb_lower, bb_pos,
    trend:      price > ma_trend ? 'bull' : 'bear',
    ema_align:  ma_fast > ma_slow && ma_slow > ma_trend,
    golden_cross: ma_slow > ma200,
    timeframe,
  };
}

// ── SCALP DECISION (M5–M15 style) ────────────────────────────────────────────
function decideScalp(price, indicators, hourUTC, consecutiveWins) {
  if (!indicators) return { action: 'wait', reason: 'Building history…', confidence: 0, bullScore: 0, bearScore: 0 };

  const { rsi, stoch, macd, momentum, trend, ema_align, vol, bb_pos } = indicators;
  const isBest  = YOUR_PATTERNS.bestHoursUTC.includes(hourUTC);
  const isWorst = YOUR_PATTERNS.worstHoursUTC.includes(hourUTC);

  let bull = 0, bear = 0;
  const log = [];

  // RSI
  if (rsi < 30)       { bull += 2.5; log.push(`RSI oversold ${rsi.toFixed(1)}`); }
  else if (rsi > 70)  { bear += 2.5; log.push(`RSI overbought ${rsi.toFixed(1)}`); }
  else                { log.push(`RSI neutral ${rsi.toFixed(1)}`); }

  // Stoch
  if (stoch < 20)     { bull += 2; log.push('Stoch oversold'); }
  else if (stoch > 80){ bear += 2; log.push('Stoch overbought'); }

  // MACD
  if (macd > 0.5)     { bull += 1.5; log.push('MACD bull'); }
  else if (macd < -0.5){ bear += 1.5; log.push('MACD bear'); }

  // EMA
  if (ema_align)      { bull += 2; log.push('EMA bull align'); }
  else                { bear += 1; log.push('EMA misaligned'); }

  // Bollinger
  if (bb_pos === 'lower') { bull += 1.5; log.push('At BB lower — bounce potential'); }
  if (bb_pos === 'upper') { bear += 1.5; log.push('At BB upper — rejection potential'); }

  // Momentum
  if (momentum > 2)   { bull += 1; log.push('Momentum up'); }
  else if (momentum < -2){ bear += 1; log.push('Momentum down'); }

  // Hour adjustments
  if (isWorst) { bull -= 2; bear -= 2; log.push(`⚠ Worst hour ${hourUTC}:00`); }
  if (isBest)  { bull += 1; bear += 1; log.push(`✓ Best hour ${hourUTC}:00`); }

  // Avoid your #1 mistake
  if (trend === 'bear' && bull > bear) {
    bull -= 2;
    log.push('Correction: trend bearish, reduced bull');
  }

  const confidence = Math.min(Math.max(bull, bear) / 9, 1);
  const THRESHOLD  = 0.40; // lower threshold = more trades for scalping
  const lots       = getLotSize(consecutiveWins);

  if (confidence < THRESHOLD) {
    return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
  }

  // TP/SL tighter for scalps
  const tp_dist = Math.max(vol * 6, 3.5);
  const sl_dist = Math.max(vol * 3, 2.0);

  if (bull >= bear && bull >= 3.5) {
    return {
      action: 'buy', tradeType: 'scalp', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price + tp_dist).toFixed(2)),
      sl: parseFloat((price - sl_dist).toFixed(2)),
      lots,
    };
  }
  if (bear > bull && bear >= 3.5) {
    return {
      action: 'sell', tradeType: 'scalp', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price - tp_dist).toFixed(2)),
      sl: parseFloat((price + sl_dist).toFixed(2)),
      lots,
    };
  }

  return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
}

// ── SWING DECISION (H1–H4 style) ─────────────────────────────────────────────
function decideSwing(price, indicators, hourUTC, consecutiveWins) {
  if (!indicators) return { action: 'wait', reason: 'Building history…', confidence: 0, bullScore: 0, bearScore: 0 };

  const { rsi, stoch, macd, momentum, trend, ema_align, golden_cross, vol, bb_pos } = indicators;

  let bull = 0, bear = 0;
  const log = [];

  // RSI — wider bands for swing
  if (rsi < 40)       { bull += 2; log.push(`RSI ${rsi.toFixed(1)} bull zone`); }
  else if (rsi > 60)  { bear += 2; log.push(`RSI ${rsi.toFixed(1)} bear zone`); }

  // Stoch
  if (stoch < 25)     { bull += 2; log.push('Stoch oversold'); }
  else if (stoch > 75){ bear += 2; log.push('Stoch overbought'); }

  // MACD
  if (macd > 1)       { bull += 2; log.push('MACD strong bull'); }
  else if (macd < -1) { bear += 2; log.push('MACD strong bear'); }

  // EMA + Golden cross
  if (ema_align)      { bull += 2.5; log.push('EMA bull align'); }
  else                { bear += 1.5; log.push('EMA bear align'); }
  if (golden_cross)   { bull += 1.5; log.push('Golden cross'); }
  else                { bear += 1; log.push('Death cross'); }

  // Bollinger mean reversion for swings
  if (bb_pos === 'lower') { bull += 2; log.push('BB lower — swing long setup'); }
  if (bb_pos === 'upper') { bear += 2; log.push('BB upper — swing short setup'); }

  // Strong momentum confirms swing
  if (momentum > 5)   { bull += 2; log.push('Strong upward momentum'); }
  else if (momentum < -5){ bear += 2; log.push('Strong downward momentum'); }

  // Avoid worst hours for swing entries too
  if (YOUR_PATTERNS.worstHoursUTC.includes(hourUTC)) {
    bull -= 1; bear -= 1;
    log.push(`⚠ Avoid hour ${hourUTC}:00 for new entries`);
  }

  // Correct buy-into-downtrend
  if (trend === 'bear' && bull > bear) {
    bull -= 2;
    log.push('Correction: macro trend bearish');
  }

  const confidence = Math.min(Math.max(bull, bear) / 12, 1);
  const THRESHOLD  = 0.45; // higher threshold for swing — need stronger signal
  const lots       = getLotSize(consecutiveWins);

  if (confidence < THRESHOLD) {
    return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
  }

  // TP/SL wider for swings
  const tp_dist = Math.max(vol * 18, 12);
  const sl_dist = Math.max(vol * 9,  6);

  if (bull >= bear && bull >= 5) {
    return {
      action: 'buy', tradeType: 'swing', reason: '[SWING] ' + log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price + tp_dist).toFixed(2)),
      sl: parseFloat((price - sl_dist).toFixed(2)),
      lots,
    };
  }
  if (bear > bull && bear >= 5) {
    return {
      action: 'sell', tradeType: 'swing', reason: '[SWING] ' + log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price - tp_dist).toFixed(2)),
      sl: parseFloat((price + sl_dist).toFixed(2)),
      lots,
    };
  }

  return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
}

module.exports = {
  fetchLivePrice, pushPrice, getHistory,
  computeIndicators, decideScalp, decideSwing,
  getLotSize, LOT_PROGRESSION, BASE_LOT,
  YOUR_PATTERNS,
};
