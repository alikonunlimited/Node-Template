'use strict';

// ── YOUR HISTORICAL PATTERNS (from uploaded CSV analysis) ─────────────────────
const YOUR_PATTERNS = {
  winRate:        0.24,
  bestHoursUTC:   [1, 5, 15],
  worstHoursUTC:  [2, 3, 4, 16, 19],
  avgWinDuration: 986,   // minutes
  avgLossDuration:180,
  breakEvenWinRate: 0.37,
  dominantMistake: 'buy_into_downtrend',
  bestLotSize:    0.01,
};

// ── PRICE HISTORY STORE ───────────────────────────────────────────────────────
const MAX_HISTORY = 500;
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
  // Source 1: goldprice.org
  try {
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD',
      { headers: { Accept: 'application/json' }, timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.items?.[0]?.xauPrice);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; return { price: p, source: 'goldprice.org' }; }
    }
  } catch (_) {}

  // Source 2: frankfurter
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=XAU&to=USD', { timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.rates?.USD);
      if (p > 1800 && p < 7000) { lastKnownPrice = p; return { price: p, source: 'frankfurter' }; }
    }
  } catch (_) {}

  // Fallback: simulate drift
  const drift = (Math.random() - 0.48) * 0.8;
  const p = parseFloat((lastKnownPrice + drift).toFixed(2));
  return { price: p, source: 'simulated' };
}

// ── INDICATOR ENGINE ──────────────────────────────────────────────────────────
function computeIndicators(price, history) {
  const len = history.length;
  if (len < 10) return null;

  const slice = (n) => history.slice(-Math.min(n, len));

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const ma5  = avg(slice(5));
  const ma14 = avg(slice(14));
  const ma21 = avg(slice(21));
  const ma50 = avg(slice(50));

  // RSI
  const r14 = slice(14);
  let gains = 0, losses = 0, gc = 0, lc = 0;
  for (let i = 1; i < r14.length; i++) {
    const d = r14[i] - r14[i - 1];
    if (d > 0) { gains += d; gc++; } else { losses += Math.abs(d); lc++; }
  }
  const avgG = gc ? gains / gc : 0;
  const avgL = lc ? losses / lc : 0.001;
  const rsi  = 100 - (100 / (1 + avgG / avgL));

  // Stochastic
  const hi14 = Math.max(...slice(14));
  const lo14 = Math.min(...slice(14));
  const stoch = hi14 !== lo14 ? ((price - lo14) / (hi14 - lo14)) * 100 : 50;

  // MACD approx
  const ema12 = avg(slice(12));
  const ema26 = avg(slice(Math.min(26, len)));
  const macd  = ema12 - ema26;

  // Momentum
  const momentum = len >= 10 ? price - history[len - 10] : 0;

  // Volatility (avg abs move per tick)
  const s14 = slice(14);
  const diffs = s14.slice(1).map((v, i) => Math.abs(v - s14[i]));
  const vol = avg(diffs);

  return {
    rsi, stoch, macd, momentum, vol,
    ma5, ma14, ma21, ma50,
    trend:     price > ma14 ? 'bull' : 'bear',
    ema_align: ma5 > ma14 && ma14 > ma21,
    golden_cross: ma50 > 0 && ma14 > ma50,
  };
}

// ── AI DECISION ENGINE ────────────────────────────────────────────────────────
function decide(price, indicators, hourUTC) {
  if (!indicators) {
    return { action: 'wait', reason: 'Building price history…', confidence: 0, bullScore: 0, bearScore: 0 };
  }

  const { rsi, stoch, macd, momentum, trend, ema_align, vol } = indicators;
  const isBest  = YOUR_PATTERNS.bestHoursUTC.includes(hourUTC);
  const isWorst = YOUR_PATTERNS.worstHoursUTC.includes(hourUTC);

  let bull = 0, bear = 0;
  const log = [];

  // RSI
  if (rsi < 32)       { bull += 2.5; log.push(`RSI oversold ${rsi.toFixed(1)}`); }
  else if (rsi > 68)  { bear += 2.5; log.push(`RSI overbought ${rsi.toFixed(1)}`); }
  else                { log.push(`RSI neutral ${rsi.toFixed(1)}`); }

  // Stochastic
  if (stoch < 20)     { bull += 2; log.push('Stoch oversold'); }
  else if (stoch > 80){ bear += 2; log.push('Stoch overbought'); }

  // MACD
  if (macd > 0.5)     { bull += 1.5; log.push('MACD bull'); }
  else if (macd < -0.5){ bear += 1.5; log.push('MACD bear'); }

  // EMA alignment
  if (ema_align)      { bull += 2; log.push('EMA aligned bull'); }
  else                { bear += 1; log.push('EMA misaligned'); }

  // Momentum
  if (momentum > 3)   { bull += 1; log.push('Momentum up'); }
  else if (momentum < -3){ bear += 1; log.push('Momentum down'); }

  // Your pattern corrections
  if (isWorst)        { bull -= 2; bear -= 2; log.push(`⚠ Worst hour ${hourUTC}:00 UTC`); }
  if (isBest)         { bull += 0.5; bear += 0.5; log.push(`✓ Best hour ${hourUTC}:00 UTC`); }

  // Key correction: avoid buying into downtrend (your #1 mistake)
  if (trend === 'bear' && bull > bear) {
    bull -= 2;
    log.push('Correction: trend bearish, reduced bull score');
  }

  const maxScore = 9;
  const topScore = Math.max(bull, bear);
  const confidence = Math.min(topScore / maxScore, 1);
  const THRESHOLD = 0.44;

  if (confidence < THRESHOLD) {
    return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
  }

  const tp_dist = Math.max(vol * 10, 6);
  const sl_dist = Math.max(vol * 5,  3);

  if (bull >= bear && bull >= 4) {
    return {
      action: 'buy', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price + tp_dist).toFixed(2)),
      sl: parseFloat((price - sl_dist).toFixed(2)),
      lots: YOUR_PATTERNS.bestLotSize,
    };
  }
  if (bear > bull && bear >= 4) {
    return {
      action: 'sell', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear,
      tp: parseFloat((price - tp_dist).toFixed(2)),
      sl: parseFloat((price + sl_dist).toFixed(2)),
      lots: YOUR_PATTERNS.bestLotSize,
    };
  }

  return { action: 'wait', reason: log.join(' · '), confidence, bullScore: bull, bearScore: bear };
}

module.exports = { fetchLivePrice, pushPrice, getHistory, computeIndicators, decide, YOUR_PATTERNS };
