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
    fvg_bullish:          { wins: 0, losses: 0 },
    fvg_bearish:          { wins: 0, losses: 0 },
    volume_confirming:    { wins: 0, losses: 0 },
    volume_diverging:     { wins: 0, losses: 0 },
    htf_sr_support:       { wins: 0, losses: 0 },
    htf_sr_resistance:    { wins: 0, losses: 0 },
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

function resetLosses() {
  performance.consecutiveLosses = 0;
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
  if (losses >= 15) return 0;
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

// ── FAIR VALUE GAPS (FVG) ─────────────────────────────────────────────────────
// ICC Strategy from Trades By Sci:
// A 3-candle imbalance — price moved so fast it left a gap.
// Bullish FVG: candle[i].high < candle[i+2].low → buyers were left behind → price returns to fill
// Bearish FVG: candle[i].low  > candle[i+2].high → sellers were left behind → price returns to fill
//
// Here history is an array of close prices (scalars), so we simulate OHLC from consecutive closes.
// We treat each adjacent pair as a bar: open=prev, close=curr, high=max, low=min.
function detectFairValueGaps(history) {
  const fvgs = { bullish: [], bearish: [], nearBullishFVG: false, nearBearishFVG: false };
  if (history.length < 5) return fvgs;

  // Build simplified OHLC bars from close prices
  const bars = [];
  for (let i = 1; i < history.length; i++) {
    const o = history[i - 1];
    const c = history[i];
    bars.push({ open: o, close: c, high: Math.max(o, c), low: Math.min(o, c) });
  }

  // Scan for FVG patterns (3-bar pattern)
  for (let i = 0; i < bars.length - 2; i++) {
    const c1 = bars[i], c3 = bars[i + 2];
    // Bullish FVG: gap between bar1 high and bar3 low (price jumped up, left imbalance below)
    if (c3.low > c1.high) {
      fvgs.bullish.push({
        top:      c3.low,
        bottom:   c1.high,
        midpoint: (c3.low + c1.high) / 2,
        age:      bars.length - i,        // older = larger index
      });
    }
    // Bearish FVG: gap between bar1 low and bar3 high (price jumped down, left imbalance above)
    if (c3.high < c1.low) {
      fvgs.bearish.push({
        top:      c1.low,
        bottom:   c3.high,
        midpoint: (c1.low + c3.high) / 2,
        age:      bars.length - i,
      });
    }
  }

  // Keep only the 5 most recent (freshest) FVGs
  fvgs.bullish = fvgs.bullish.slice(-5);
  fvgs.bearish = fvgs.bearish.slice(-5);

  // Check if current price is inside or very near an unfilled FVG (within 0.15%)
  const last = history[history.length - 1];
  const zone = last * 0.0015;

  fvgs.nearBullishFVG = fvgs.bullish.some(g =>
    last >= g.bottom - zone && last <= g.top + zone
  );
  fvgs.nearBearishFVG = fvgs.bearish.some(g =>
    last >= g.bottom - zone && last <= g.top + zone
  );

  return fvgs;
}

// ── SUPPORT / RESISTANCE (enhanced with daily/4H pivots) ──────────────────────
function computeSRLevels(price, history) {
  if (history.length < 20) return { nearSupport: false, nearResistance: false, srStrength: 0 };

  const recent = history.slice(-50);
  const highs = [], lows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i-2] && recent[i] > recent[i+1] && recent[i] > recent[i+2]) highs.push(recent[i]);
    if (recent[i] < recent[i-1] && recent[i] < recent[i-2] && recent[i] < recent[i+1] && recent[i] < recent[i+2]) lows.push(recent[i]);
  }

  // ── HTF Pivot Points (simulated from daily-like slices) ──────────────────────
  // Daily pivot: (High + Low + Close) / 3 from the last ~288 bars (≈24h @ 5min bars)
  // 4H pivot: last ~48 bars (≈4h @ 5min bars)
  const htfPivots = [];
  const sliceSizes = [288, 144, 48]; // daily, half-day, 4H approximations
  for (const sz of sliceSizes) {
    if (history.length >= sz) {
      const slice = history.slice(-sz);
      const hi  = Math.max(...slice);
      const lo  = Math.min(...slice);
      const cl  = slice[slice.length - 1];
      const pp  = (hi + lo + cl) / 3;       // pivot point
      const r1  = 2 * pp - lo;              // resistance 1
      const s1  = 2 * pp - hi;              // support 1
      const r2  = pp + (hi - lo);           // resistance 2
      const s2  = pp - (hi - lo);           // support 2
      htfPivots.push(pp, r1, s1, r2, s2);
    }
  }

  // Combine swing highs/lows with HTF pivots
  const allResistance = [...highs, ...htfPivots.filter(p => p > price)];
  const allSupport    = [...lows,  ...htfPivots.filter(p => p < price)];

  const ZONE = price * 0.001;
  const nearSupport    = allSupport.some(l => Math.abs(price - l) < ZONE);
  const nearResistance = allResistance.some(h => Math.abs(price - h) < ZONE);

  const srStrength = nearSupport || nearResistance
    ? Math.min(
        (nearSupport    ? allSupport.filter(l => Math.abs(price - l) < ZONE * 2).length    : 0) +
        (nearResistance ? allResistance.filter(h => Math.abs(price - h) < ZONE * 2).length : 0),
        5
      )
    : 0;

  // Nearest key levels for display
  const nearestSupport    = allSupport.length    ? allSupport.reduce((a, b) => Math.abs(b - price) < Math.abs(a - price) ? b : a) : null;
  const nearestResistance = allResistance.length ? allResistance.reduce((a, b) => Math.abs(b - price) < Math.abs(a - price) ? b : a) : null;

  return {
    nearSupport, nearResistance, srStrength,
    highs, lows,
    htfPivots,
    nearestSupport,
    nearestResistance,
  };
}

// ── VOLUME (enhanced with price-direction confirmation) ────────────────────────
// Core concept from Trades By Sci:
//   Rising price + rising volume  → trend is CONFIRMED (strong move, follow it)
//   Rising price + falling volume → trend is DIVERGING (weakening, possible reversal)
//   Falling price + rising volume → trend is CONFIRMED bearish
//   Falling price + falling volume → diverging / exhaustion
function computeVolume(history) {
  if (history.length < 20) return { volumeScore: 0, highVolume: false, lowVolume: false, volumeTrend: 'neutral' };

  const recent20 = history.slice(-20);
  const recent5  = history.slice(-5);
  const recent10 = history.slice(-10);

  // ATR-based "volume proxy" (we don't have tick volume, so use price volatility as proxy)
  const atr20 = recent20.slice(1).reduce((sum, p, i) => sum + Math.abs(p - recent20[i]), 0) / 19;
  const atr5  = recent5.slice(1).reduce((sum, p, i) => sum + Math.abs(p - recent5[i]), 0) / 4;
  const atr10 = recent10.slice(1).reduce((sum, p, i) => sum + Math.abs(p - recent10[i]), 0) / 9;

  const volumeRatio = atr5 / (atr20 || 0.001);

  // Price direction over last 5 bars vs last 10 bars
  const priceChange5  = recent5[recent5.length - 1]   - recent5[0];
  const priceChange10 = recent10[recent10.length - 1]  - recent10[0];

  // Volume trend: compare recent 5-bar ATR to mid-range 10-bar ATR
  const recentVolHigh = atr5 > atr10;     // volume increasing
  const recentVolLow  = atr5 < atr10 * 0.7; // volume meaningfully decreasing

  // Price-volume confluence analysis
  let volumeTrend = 'neutral';
  let risingWithPrice  = false; // bull confirmation
  let fallingWithPrice = false; // bear confirmation
  let divergingFromPrice = false;

  if (priceChange5 > 0) {
    // Price rising
    if (recentVolHigh) {
      volumeTrend = 'confirming_bull';
      risingWithPrice = true;
    } else if (recentVolLow) {
      volumeTrend = 'diverging_bull';    // price up but volume fading = weak
      divergingFromPrice = true;
    }
  } else if (priceChange5 < 0) {
    // Price falling
    if (recentVolHigh) {
      volumeTrend = 'confirming_bear';
      fallingWithPrice = true;
    } else if (recentVolLow) {
      volumeTrend = 'diverging_bear';    // price down but volume fading = possible bounce
      divergingFromPrice = true;
    }
  }

  return {
    volumeScore:       volumeRatio,
    highVolume:        volumeRatio > 1.5,
    lowVolume:         volumeRatio < 0.5,
    atr20,
    atr5,
    atr10,
    volumeTrend,
    risingWithPrice,      // volume confirms bull move
    fallingWithPrice,     // volume confirms bear move
    divergingFromPrice,   // volume diverging = caution
    priceChange5,
    priceChange10,
  };
}

// ── MULTI-TIMEFRAME (enhanced with HTF S/R key levels) ────────────────────────
function computeHTF(price, history) {
  if (history.length < 40) return { htfBull: null, htfBear: null, confirmed: false };

  const h1_slice = history.slice(-40);
  const h4_slice = history.slice(-Math.min(160, history.length));
  const d1_slice = history.slice(-Math.min(480, history.length)); // ~daily equivalent

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const h1_ma = avg(h1_slice);
  const h4_ma = avg(h4_slice);
  const d1_ma = d1_slice.length >= 10 ? avg(d1_slice) : null;

  const h1_bull = price > h1_ma;
  const h4_bull = price > h4_ma;
  const d1_bull = d1_ma ? price > d1_ma : null;

  // RSI calculation on H1 slice
  const r = h1_slice;
  let g = 0, l = 0, gc = 0, lc = 0;
  for (let i = 1; i < r.length; i++) {
    const d = r[i] - r[i-1];
    if (d > 0) { g += d; gc++; } else { l += Math.abs(d); lc++; }
  }
  const h1_rsi = 100 - (100 / (1 + (gc ? g/gc : 0) / (lc ? l/lc : 0.001)));

  // HTF S/R key levels from swing structure
  const htfHigh = Math.max(...h4_slice);
  const htfLow  = Math.min(...h4_slice);
  const htfMid  = (htfHigh + htfLow) / 2;

  // Daily range
  const d1High = d1_slice.length ? Math.max(...d1_slice) : htfHigh;
  const d1Low  = d1_slice.length ? Math.min(...d1_slice) : htfLow;
  const d1Mid  = (d1High + d1Low) / 2;

  // Is price near HTF key levels?
  const htfZone = price * 0.001; // 0.1% zone â€” tightened to reduce dual-fire
  const rawNearSupport    = [htfLow, d1Low].some(lvl => Math.abs(price - lvl) < htfZone && price >= lvl);
  const rawNearResistance = [htfHigh, d1High].some(lvl => Math.abs(price - lvl) < htfZone && price <= lvl);
  const supportDist    = rawNearSupport    ? Math.min(...[htfLow, d1Low].map(l => Math.abs(price - l)))    : Infinity;
  const resistanceDist = rawNearResistance ? Math.min(...[htfHigh, d1High].map(h => Math.abs(price - h))) : Infinity;
  const nearHTFSupport    = rawNearSupport    && (!rawNearResistance || supportDist <= resistanceDist);
  const nearHTFResistance = rawNearResistance && (!rawNearSupport    || resistanceDist < supportDist);

  // Tri-TF confirmation (Sci's timeframe hierarchy: D1 → H4 → H1)
  const htfBull = h1_bull && h4_bull && h1_rsi < 65;
  const htfBear = !h1_bull && !h4_bull && h1_rsi > 35;

  // Full alignment (all 3 TFs agree) = strongest signal
  const fullBullAlign = d1_bull === true  && h4_bull && h1_bull;
  const fullBearAlign = d1_bull === false && !h4_bull && !h1_bull;

  return {
    htfBull, htfBear,
    h1_bull, h4_bull, d1_bull,
    h1_rsi,
    confirmed: htfBull || htfBear,
    fullBullAlign, fullBearAlign,
    htfHigh, htfLow, htfMid,
    d1High, d1Low, d1Mid,
    nearHTFSupport, nearHTFResistance,
  };
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
// FIX 4: winRate and dominantMistake are now computed live from performance data
// so the AI learns from actual results instead of a stale hardcoded value.
const YOUR_PATTERNS = {
  bestHoursUTC:     [1, 5, 15],
  worstHoursUTC:    [2, 3, 4, 16, 19],
  breakEvenWinRate: 0.37,
  // winRate computed dynamically below — do NOT hardcode it here
};

function getLiveWinRate() {
  const recent = performance.recentTrades;
  if (!recent.length) return 0.5; // neutral until we have data
  return recent.filter(t => t.isWin).length / recent.length;
}

function getDominantDirection() {
  // Returns 'buy' or 'sell' based on which side has won more recently
  const buys  = performance.recentTrades.filter(t => t.type === 'buy');
  const sells = performance.recentTrades.filter(t => t.type === 'sell');
  if (!buys.length && !sells.length) return null;
  const buyWR  = buys.length  ? buys.filter(t => t.isWin).length  / buys.length  : 0;
  const sellWR = sells.length ? sells.filter(t => t.isWin).length / sells.length : 0;
  return buyWR >= sellWR ? 'buy' : 'sell';
}

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
let lastKnownPrice = 4289.68;

function pushPrice(p) { priceHistory.push(p); if (priceHistory.length > MAX_HISTORY) priceHistory.shift(); }
function getHistory() { return [...priceHistory]; }

const fetch = require('node-fetch');

// ── PRICE FETCH ───────────────────────────────────────────────────────────────
async function fetchLivePrice() {
  // SOURCE 1: Yahoo Finance (no API key)
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d',
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

// ── SESSION QUALITY ───────────────────────────────────────────────────────────
function isGoodSession() {
  const h = new Date().getUTCHours();
  // London open 7-10, NY open 12-16, overlap 12-16 UTC = best volume
  return (h >= 7 && h <= 10) || (h >= 12 && h <= 16);
}

// ── ICC PATTERN (Indication → Correction → Continuation) ─────────────────────
function detectICC(history) {
  if (history.length < 15) return { iccBull: false, iccBear: false };
  const recent = history.slice(-15);
  const mid    = Math.floor(recent.length / 2);

  // Look for: push (indication), pullback (correction), then continuation setup
  const firstHalf  = recent.slice(0, mid);
  const secondHalf = recent.slice(mid);

  const firstMove  = firstHalf[firstHalf.length - 1]   - firstHalf[0];
  const secondMove = secondHalf[secondHalf.length - 1]  - secondHalf[0];
  const pullback   = recent[mid] - firstHalf[firstHalf.length - 1];

  // Bull ICC: strong up move → corrective pullback → continuation up
  const iccBull = firstMove > 0 && pullback < 0 && Math.abs(pullback) < firstMove * 0.618 && secondMove > 0;
  // Bear ICC: strong down move → corrective bounce → continuation down
  const iccBear = firstMove < 0 && pullback > 0 && Math.abs(pullback) < Math.abs(firstMove) * 0.618 && secondMove < 0;

  return { iccBull, iccBear, firstMove, pullback, secondMove };
}

// ── SWING REENTRY ─────────────────────────────────────────────────────────────
function checkSwingReentry(price, history, direction, htf, vol) {
  if (!direction || !htf) return { shouldReenter: false };
  const aligned = direction === 'buy' ? htf.htfBull : htf.htfBear;
  const hasVol  = vol && vol.highVolume;
  const shouldReenter = aligned && hasVol;
  return { shouldReenter, reason: shouldReenter ? `HTF aligned + volume confirmed reentry` : 'Conditions not met' };
}

// ── DECISION ENGINE ───────────────────────────────────────────────────────────
function decide(price, indicators, hourUTC, consecutiveWins, tradeType = 'scalp', extraData = {}) {
  const target = TRADE_TARGETS[tradeType];
  if (!target) return { action:'wait', tradeType, reason:`Invalid tradeType: ${tradeType}`, confidence:0, bullScore:0, bearScore:0 };
  const lots   = getLotSize(consecutiveWins);

  const now = new Date();
  const hourUTCnow = now.getUTCHours();
  const dayUTC = now.getUTCDay(); // 0=Sun, 6=Sat

  // Gold trades Sun 23:00 UTC to Fri 21:00 UTC with 1hr break daily at 21:00-22:00
  const isSaturdayClosed = dayUTC === 6;
  const isSundayPreOpen  = dayUTC === 0 && hourUTCnow < 23;
  const isDailyBreak     = hourUTCnow >= 21 && hourUTCnow < 22;
  const isFridayClose    = dayUTC === 5 && hourUTCnow >= 21;

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
    return { action, tradeType, reason, confidence: conf, bullScore: bull, bearScore: bear, tp, sl, lots, conditions };
  };

  if (!indicators) return makeDecision(Math.random() > 0.5 ? 'buy' : 'sell', 'Building history', 0.5, []);

  const { rsi, stoch, macd, momentum, trend, ema_align } = indicators;
  const isBest  = YOUR_PATTERNS.bestHoursUTC.includes(hourUTC);
  const isWorst = YOUR_PATTERNS.worstHoursUTC.includes(hourUTC);
  let bull = 0, bear = 0;
  const log = [], activeConditions = [];

  // FIX 4: Dynamic live bias — if buy side is historically outperforming, give a small head-start
  const dominantDir = getDominantDirection();
  const liveWR = getLiveWinRate();
  if (dominantDir === 'buy'  && liveWR > YOUR_PATTERNS.breakEvenWinRate) { bull += 0.5; log.push(`Live bias: buy (${(liveWR*100).toFixed(0)}%WR)`); }
  if (dominantDir === 'sell' && liveWR > YOUR_PATTERNS.breakEvenWinRate) { bear += 0.5; log.push(`Live bias: sell (${(liveWR*100).toFixed(0)}%WR)`); }

  // ── HTF (Higher Timeframe) Analysis ──────────────────────────────────────────
  const htf = extraData.htf || computeHTF(price, priceHistory);
  if (htf.htfBull)       { bull += getConditionWeight('htf_confirmed', 2); log.push('HTF bull'); activeConditions.push('htf_confirmed'); }
  else if (htf.htfBear)  { bear += getConditionWeight('htf_confirmed', 2); log.push('HTF bear'); activeConditions.push('htf_confirmed'); }
  else                   { bull -= 0.5; bear -= 0.5; log.push('HTF conflicted'); activeConditions.push('htf_conflicted');
                           return { action:'wait', tradeType, reason:'HTF conflicted — all modes paused until alignment', confidence:0, bullScore:bull, bearScore:bear }; }

  // Full 3-TF alignment gives bonus
  if (htf.fullBullAlign) { bull += 1.5; log.push('D1+H4+H1 bull align'); }
  if (htf.fullBearAlign) { bear += 1.5; log.push('D1+H4+H1 bear align'); }

  // HTF S/R levels as entry filter (from computeHTF)
  if (htf.nearHTFSupport)    { bull += getConditionWeight('htf_sr_support', 1.5);    log.push('Near HTF S'); activeConditions.push('htf_sr_support'); }
  if (htf.nearHTFResistance) { bear += getConditionWeight('htf_sr_resistance', 1.5); log.push('Near HTF R'); activeConditions.push('htf_sr_resistance'); }

  // ── S/R Levels (with HTF pivots) ─────────────────────────────────────────────
  const sr = extraData.sr || computeSRLevels(price, priceHistory);
  if (sr.nearSupport)    { bull += getConditionWeight('near_support', 1.5) * (sr.srStrength / 3); log.push(`Near S (str:${sr.srStrength})`); activeConditions.push('near_support'); }
  if (sr.nearResistance) { bear += getConditionWeight('near_resistance', 1.5) * (sr.srStrength / 3); log.push(`Near R (str:${sr.srStrength})`); activeConditions.push('near_resistance'); }
  if (!sr.nearSupport && !sr.nearResistance) { bull -= 0.5; bear -= 0.5; log.push('Mid-range'); }

  // ── Volume Analysis (with price direction confirmation) ───────────────────────
  const vol = extraData.vol || computeVolume(priceHistory);
  if (vol.highVolume) {
    const w = getConditionWeight('high_volume', 1.5);
    bull += w; bear += w;
    log.push(`Hi vol (${vol.volumeScore.toFixed(1)}x)`);
    activeConditions.push('high_volume');
  } else if (vol.lowVolume) {
    bull -= 1; bear -= 1;
    log.push(`Lo vol (${vol.volumeScore.toFixed(1)}x)`);
    activeConditions.push('low_volume');
  }

  // Volume-price confluence: boost when volume confirms the direction
  if (vol.risingWithPrice) {
    bull += getConditionWeight('volume_confirming', 1.5);
    log.push('Vol confirms bull');
    activeConditions.push('volume_confirming');
  }
  if (vol.fallingWithPrice) {
    bear += getConditionWeight('volume_confirming', 1.5);
    log.push('Vol confirms bear');
    activeConditions.push('volume_confirming');
  }
  // Volume diverging = reduce confidence in the current price direction
  if (vol.divergingFromPrice) {
    const movingUp = vol.priceChange5 > 0;
    if (movingUp) { bull -= 1.5; log.push('Vol diverging (price up, vol fading)'); activeConditions.push('volume_diverging'); }
    else          { bear -= 1.5; log.push('Vol diverging (price down, vol fading)'); activeConditions.push('volume_diverging'); }
  }

  // ── Fair Value Gaps (FVG) ─────────────────────────────────────────────────────
  // FVG acts as a magnet: if price is in/near a bullish FVG → support → favour buy
  //                        if price is in/near a bearish FVG → resistance → favour sell
  const fvgData = extraData.fvg || detectFairValueGaps(priceHistory);
  if (fvgData.nearBullishFVG) {
    bull += getConditionWeight('fvg_bullish', 1.5);
    log.push('In bullish FVG (magnet)');
    activeConditions.push('fvg_bullish');
  }
  if (fvgData.nearBearishFVG) {
    bear += getConditionWeight('fvg_bearish', 1.5);
    log.push('In bearish FVG (magnet)');
    activeConditions.push('fvg_bearish');
  }

  // ── Standard Indicators ───────────────────────────────────────────────────────
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

  // FIX 1: Symmetric trend alignment — both directions get a bonus, neither gets an asymmetric penalty
  if (trend === 'bull') { bull += 1; log.push('Trend bull'); }
  else                  { bear += 1; log.push('Trend bear'); }

  // FIX 2 & 3: Symmetric performance feedback — both buy and sell get boosted AND penalised equally
  const buyPerf = performance.byType[`${tradeType}_buy`];
  if (buyPerf && (buyPerf.wins + buyPerf.losses) >= 5) {
    const wr = buyPerf.wins / (buyPerf.wins + buyPerf.losses);
    if (wr > 0.5)  { bull += 1;   log.push(`AI: buy WR ${(wr*100).toFixed(0)}%✓`); }
    if (wr < 0.3)  { bull -= 1.5; log.push(`AI: buy WR ${(wr*100).toFixed(0)}%✗`); }
  }
  const sellPerf = performance.byType[`${tradeType}_sell`];
  if (sellPerf && (sellPerf.wins + sellPerf.losses) >= 5) {
    const wr = sellPerf.wins / (sellPerf.wins + sellPerf.losses);
    if (wr > 0.5)  { bear += 1;   log.push(`AI: sell WR ${(wr*100).toFixed(0)}%✓`); }
    if (wr < 0.3)  { bear -= 1.5; log.push(`AI: sell WR ${(wr*100).toFixed(0)}%✗`); }
  }

  const topScore   = Math.max(bull, bear);
  const confidence = Math.min(topScore / 10, 1);
  const minScore   = performance.consecutiveLosses >= 3 ? 6 : 4; // raised floor: was 5:3

  if (topScore < minScore) return { action:'wait', tradeType, reason:`Score ${topScore.toFixed(1)} < ${minScore} | ${log.join(' · ')}`, confidence, bullScore:bull, bearScore:bear };

  const action = bull >= bear ? 'buy' : 'sell';
  return makeDecision(action, `[${action.toUpperCase()}] B${bull.toFixed(1)}/S${bear.toFixed(1)} | ${log.join(' · ')}`, confidence, activeConditions);
}

module.exports = {
  fetchLivePrice, pushPrice, getHistory,
  computeIndicators, computeSRLevels, computeVolume, computeHTF,
  detectFairValueGaps,
  decide, recordOutcome, resetLosses, getPerformanceSummary,
  detectICC, isGoodSession, checkSwingReentry,
  getLotSize, LOT_PROGRESSION, BASE_LOT,
  TRADE_TARGETS, YOUR_PATTERNS,
  MARKET_CLOSE_HOUR_UTC, MARKET_OPEN_HOUR_UTC,
  MAX_LOSS_PER_TRADE, updateSpread, getSpreadScore,
};