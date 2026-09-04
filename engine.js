'use strict';

const YOUR_PATTERNS = {
  winRate: 0.24,
  bestHoursUTC: [1, 5, 15],
  worstHoursUTC: [2, 3, 4, 16, 19],
  breakEvenWinRate: 0.37,
  dominantMistake: 'buy_into_downtrend',
};

const LOT_PROGRESSION = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32];
const BASE_LOT = 0.01;

function getLotSize(w) {
  return LOT_PROGRESSION[Math.min(w, LOT_PROGRESSION.length - 1)];
}

const TRADE_TARGETS = {
  scalp: { pips_tp: 3,   pips_sl: 1.5 },
  day:   { pips_tp: 10,  pips_sl: 5   },
  swing: { pips_tp: 250, pips_sl: 100 },
};

const MAX_HISTORY = 1000;
let priceHistory = [];
let lastKnownPrice = 4603;
let oandaAccountId = null;

function pushPrice(p) {
  priceHistory.push(p);
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

function getHistory() { return [...priceHistory]; }

const fetch = require('node-fetch');

// Get OANDA account ID (needed for pricing endpoint)
async function getOandaAccountId(apiKey) {
  if (oandaAccountId) return oandaAccountId;
  try {
    const r = await fetch('https://api-fxtrade.oanda.com/v3/accounts', {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    if (r.ok) {
      const d = await r.json();
      oandaAccountId = d?.accounts?.[0]?.id;
      console.log(`[OANDA] Account ID: ${oandaAccountId}`);
      return oandaAccountId;
    }
  } catch (e) {
    console.log(`[OANDA] Account ID fetch error: ${e.message}`);
  }
  return null;
}

async function fetchLivePrice() {
  const apiKey = process.env.OANDA_API_KEY;

  // SOURCE 1: OANDA pricing endpoint
  if (apiKey) {
    try {
      const accountId = await getOandaAccountId(apiKey);
      if (accountId) {
        const r = await fetch(
          `https://api-fxtrade.oanda.com/v3/accounts/${accountId}/pricing?instruments=XAU_USD`,
          {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 5000,
          }
        );
        if (r.ok) {
          const d = await r.json();
          const price = d?.prices?.[0];
          if (price) {
            const bid = parseFloat(price.bids?.[0]?.price);
            const ask = parseFloat(price.asks?.[0]?.price);
            const mid = parseFloat(((bid + ask) / 2).toFixed(2));
            if (mid > 1800 && mid < 7000) {
              lastKnownPrice = mid;
              return { price: mid, source: 'OANDA Live' };
            }
          }
        } else {
          const err = await r.text();
          console.log(`[OANDA] Pricing error ${r.status}: ${err}`);
        }
      }
    } catch (e) {
      console.log(`[OANDA] Fetch error: ${e.message}`);
    }
  }

  // SOURCE 2: goldprice.org
  try {
    const r = await fetch('https://data-asg.goldprice.org/dbXRates/USD',
      { headers: { Accept: 'application/json' }, timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.items?.[0]?.xauPrice);
      if (p > 1800 && p < 7000) {
        lastKnownPrice = p;
        return { price: p, source: 'goldprice.org' };
      }
    }
  } catch (_) {}

  // SOURCE 3: frankfurter
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=XAU&to=USD', { timeout: 5000 });
    if (r.ok) {
      const d = await r.json();
      const p = parseFloat(d?.rates?.USD);
      if (p > 1800 && p < 7000) {
        lastKnownPrice = p;
        return { price: p, source: 'frankfurter' };
      }
    }
  } catch (_) {}

  // FALLBACK
  const drift = (Math.random() - 0.48) * 0.8;
  const p = parseFloat((lastKnownPrice + drift).toFixed(2));
  return { price: p, source: 'simulated' };
}

function computeIndicators(price, history) {
  const len = history.length;
  if (len < 5) return null;
  const slice = n => history.slice(-Math.min(n, len));
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ma5 = avg(slice(5)), ma14 = avg(slice(14)), ma21 = avg(slice(21));
  const r14 = slice(14);
  let g = 0, l = 0, gc = 0, lc = 0;
  for (let i = 1; i < r14.length; i++) {
    const d = r14[i] - r14[i - 1];
    if (d > 0) { g += d; gc++; } else { l += Math.abs(d); lc++; }
  }
  const rsi = 100 - (100 / (1 + (gc ? g / gc : 0) / (lc ? l / lc : 0.001)));
  const st = slice(14), hi = Math.max(...st), lo = Math.min(...st);
  const stoch = hi !== lo ? ((price - lo) / (hi - lo)) * 100 : 50;
  const macd = avg(slice(12)) - avg(slice(26));
  const momentum = len >= 5 ? price - history[len - 5] : 0;
  const s14 = slice(14);
  const diffs = s14.slice(1).map((v, i) => Math.abs(v - s14[i]));
  const vol = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0.5;
  return {
    rsi, stoch, macd, momentum, vol, ma5, ma14, ma21,
    trend: price > ma14 ? 'bull' : 'bear',
    ema_align: ma5 > ma14 && ma14 > ma21,
  };
}

function decide(price, indicators, hourUTC, consecutiveWins, tradeType = 'scalp') {
  const target = TRADE_TARGETS[tradeType];
  const lots = getLotSize(consecutiveWins);
  const makeDecision = (action, reason, conf) => {
    const tp = action === 'buy'
      ? parseFloat((price + target.pips_tp).toFixed(2))
      : parseFloat((price - target.pips_tp).toFixed(2));
    const sl = action === 'buy'
      ? parseFloat((price - target.pips_sl).toFixed(2))
      : parseFloat((price + target.pips_sl).toFixed(2));
    return { action, tradeType, reason, confidence: conf, bullScore: 5, bearScore: 5, tp, sl, lots };
  };
  if (!indicators) return makeDecision(Math.random() > 0.5 ? 'buy' : 'sell', 'Building history', 0.5);
  const { rsi, stoch, macd, momentum, trend, ema_align } = indicators;
  let bull = 0, bear = 0, log = [];
  if (rsi < 40) { bull += 2; log.push(`RSI bull ${rsi.toFixed(0)}`); }
  else if (rsi > 60) { bear += 2; log.push(`RSI bear ${rsi.toFixed(0)}`); }
  else { log.push(`RSI neutral ${rsi.toFixed(0)}`); }
  if (stoch < 30) { bull += 2; log.push('Stoch OS'); }
  else if (stoch > 70) { bear += 2; log.push('Stoch OB'); }
  if (macd > 0) { bull += 1; log.push('MACD bull'); }
  else { bear += 1; log.push('MACD bear'); }
  if (ema_align) { bull += 2; log.push('EMA bull'); }
  else { bear += 1; log.push('EMA bear'); }
  if (momentum > 0) { bull += 1; log.push('Mom up'); }
  else { bear += 1; log.push('Mom dn'); }
  if (YOUR_PATTERNS.worstHoursUTC.includes(hourUTC)) { bull -= 1; bear -= 1; }
  if (YOUR_PATTERNS.bestHoursUTC.includes(hourUTC)) { bull += 1; bear += 1; }
  if (trend === 'bear' && bull > bear) { bull -= 1; log.push('Trend corr'); }
  const action = bull >= bear ? 'buy' : 'sell';
  return makeDecision(action, log.join(' · '), Math.min(Math.max(bull, bear) / 8, 1));
}

module.exports = {
  fetchLivePrice, pushPrice, getHistory,
  computeIndicators, decide,
  getLotSize, LOT_PROGRESSION, BASE_LOT,
  TRADE_TARGETS, YOUR_PATTERNS,
};