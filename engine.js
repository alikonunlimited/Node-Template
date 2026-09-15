'use strict';

// ── SELF-LEARNING PERFORMANCE TRACKER ────────────────────────────────────────
const performance = {
  // Track outcomes by condition to learn what works
  conditions: {
    rsi_oversold_bull:   { wins: 0, losses: 0 },
    rsi_overbought_bear: { wins: 0, losses: 0 },
    stoch_oversold_bull: { wins: 0, losses: 0 },
    stoch_overbought_bear: { wins: 0, losses: 0 },
    macd_bull:           { wins: 0, losses: 0 },
    macd_bear:           { wins: 0, losses: 0 },
    ema_bull_align:      { wins: 0, losses: 0 },
    ema_bear_align:      { wins: 0, losses: 0 },
    momentum_up:         { wins: 0, losses: 0 },
    momentum_down:       { wins: 0, losses: 0 },
    best_hour:           { wins: 0, losses: 0 },
    worst_hour:          { wins: 0, losses: 0 },
  },
  // Track outcomes by trade type
  byType: {
    scalp_buy:  { wins: 0, losses: 0, totalPL: 0 },
    scalp_sell: { wins: 0, losses: 0, totalPL: 0 },
    day_buy:    { wins: 0, losses: 0, totalPL: 0 },
    day_sell:   { wins: 0, losses: 0, totalPL: 0 },
    swing_buy:  { wins: 0, losses: 0, totalPL: 0 },
    swing_sell: { wins: 0, losses: 0, totalPL: 0 },
  },
  // Rolling window — last 20 trades
  recentTrades: [],
  totalTrades: 0,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 0,
};

// Called after every trade closes
function recordOutcome(trade) {
  const { type, tradeType, pl, isWin, conditions } = trade;
  const key = `${tradeType}_${type}`;

  if (performance.byType[key]) {
    if (isWin) performance.byType[key].wins++;
    else performance.byType[key].losses++;
    performance.byType[key].totalPL += pl;
  }

  // Track which conditions led to this outcome
  if (conditions) {
    conditions.forEach(c => {
      if (performance.conditions[c]) {
        if (isWin) performance.conditions[c].wins++;
        else performance.conditions[c].losses++;
      }
    });
  }

  // Rolling window
  performance.recentTrades.push({ isWin, pl, type, tradeType });
  if (performance.recentTrades.length > 20) performance.recentTrades.shift();

  // Consecutive loss tracking
  if (!isWin) {
    performance.consecutiveLosses++;
    performance.maxConsecutiveLosses = Math.max(
      performance.maxConsecutiveLosses,
      performance.consecutiveLosses
    );
  } else {
    performance.consecutiveLosses = 0;
  }

  performance.totalTrades++;
}

// Get adaptive weight for a condition based on historical performance
function getConditionWeight(condition, baseWeight) {
  const perf = performance.conditions[condition];
  if (!perf || (perf.wins + perf.losses) < 5) return baseWeight; // not enough data
  const winRate = perf.wins / (perf.wins + perf.losses);
  // Scale weight: good condition (>60% win) gets bonus, bad (<40%) gets penalty
  if (winRate > 0.6) return baseWeight * 1.3;
  if (winRate < 0.4) return baseWeight * 0.5;
  return baseWeight;
}

// Check if we should reduce size after losses
function getSizeMultiplier() {
  const losses = performance.consecutiveLosses;
  if (losses >= 5) return 0; // pause after 5 straight losses
  if (losses >= 3) return 0.5; // half size after 3
  return 1;
}

function getPerformanceSummary() {
  const recent = performance.recentTrades;
  const recentWinRate = recent.length
    ? recent.filter(t => t.isWin).length / recent.length
    : null;
  return {
    recentWinRate,
    consecutiveLosses: performance.consecutiveLosses,
    byType: performance.byType,
    conditions: performance.conditions,
    totalTrades: performance.totalTrades,
  };
}

// ── YOUR HISTORICAL PATTERNS ──────────────────────────────────────────────────
const YOUR_PATTERNS = {
  winRate:          0.24,
  bestHoursUTC:     [1, 5, 15],
  worstHoursUTC:    [2, 3, 4, 16, 19],
  breakEvenWinRate: 0.37,
  dominantMistake:  'buy_into_downtrend',
  // From latest AI data analysis
  aiMistakes: {
    catastrophicOvernight: true, // trades #48,49,90,91
    buyBias: true,               // BUY -$1879 vs SELL +$44
    slTooWide: true,             // avg loss $31 vs avg win $18
  },
};

const LOT_PROGRESSION = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32];
const BASE_LOT = 0.01;

function getLotSize(consecutiveWins) {
  return LOT_PROGRESSION[Math.min(consecutiveWins, LOT_PROGRESSION.length - 1)];
}

// ── TIGHTENED TRADE TARGETS (based on data analysis) ─────────────────────────
const TRADE_TARGETS = {
  scalp: { pips_tp: 3,   pips_sl: 0.75 }, // tighter SL
  day:   { pips_tp: 10,  pips_sl: 3    }, // tighter SL
  swing: { pips_tp: 100, pips_sl: 50   }, // tighter SL
};

// Max loss per trade - hard cap
const MAX_LOSS_PER_TRADE = 15;

// Market hours - don't hold overnight (5pm-6pm EST = 21:00-22:00 UTC)
const MARKET_CLOSE_HOUR_UTC = 21;
const MARKET_OPEN_HOUR_UTC  = 22;

const MAX_HISTORY = 1000;
let priceHistory   = [];
let lastKnownPrice = 4293; // Updated Sep 15 2026

function pushPrice(p) {
  priceHistory.push(p);
  if (priceHistory.length > MAX_HISTORY) priceHistory.shift();
}

function getHistory() { return [...priceHistory]; }

const fetch = require('node-fetch');

async function fetchLivePrice() {
  // SOURCE 1: Twelve Data
  try {
    const key = process.env.TWELVE_DATA_KEY;
    if (key) {
      const r = await fetch(
        `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${key}`,
        { timeout: 5000 }
      );
      if (r.ok) {
        const d = await r.json();
        const p = parseFloat(d?.price);
        if (p > 1800 && p < 7000) {
          lastKnownPrice = p;
          return { price: p, source: 'Twelve Data' };
        }
      }
    }
  } catch (e) { console.log(`[Price] Twelve Data: ${e.message}`); }

  // SOURCE 2: OANDA
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
          }
        }
      }
    }
  } catch (e) { console.log(`[Price] OANDA: ${e.message}`); }

  // SOURCE 3: goldprice.org
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

  // FALLBACK
  const drift = (Math.random() - 0.48) * 0.5;
  const p = parseFloat((lastKnownPrice + drift).toFixed(2));
  return { price: p, source: 'simulated' };
}

function computeIndicators(price, history) {
  const len = history.length;
  if (len < 5) return null;
  const slice = n => history.slice(-Math.min(n, len));
  const avg   = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ma5   = avg(slice(5));
  const ma14  = avg(slice(14));
  const ma21  = avg(slice(21));
  const r14   = slice(14);
  let g = 0, l = 0, gc = 0, lc = 0;
  for (let i = 1; i < r14.length; i++) {
    const d = r14[i] - r14[i - 1];
    if (d > 0) { g += d; gc++; } else { l += Math.abs(d); lc++; }
  }
  const rsi   = 100 - (100 / (1 + (gc ? g / gc : 0) / (lc ? l / lc : 0.001)));
  const st    = slice(14), hi = Math.max(...st), lo = Math.min(...st);
  const stoch = hi !== lo ? ((price - lo) / (hi - lo)) * 100 : 50;
  const macd  = avg(slice(12)) - avg(slice(26));
  const momentum = len >= 5 ? price - history[len - 5] : 0;
  const s14   = slice(14);
  const diffs = s14.slice(1).map((v, i) => Math.abs(v - s14[i]));
  const vol   = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0.5;
  return {
    rsi, stoch, macd, momentum, vol, ma5, ma14, ma21,
    trend:     price > ma14 ? 'bull' : 'bear',
    ema_align: ma5 > ma14 && ma14 > ma21,
  };
}

function decide(price, indicators, hourUTC, consecutiveWins, tradeType = 'scalp') {
  const target = TRADE_TARGETS[tradeType];
  const lots   = getLotSize(consecutiveWins);
  const sizeM  = getSizeMultiplier();

  // ── MARKET HOURS CHECK ────────────────────────────────────────────────────
  const isMarketClosed = hourUTC >= MARKET_CLOSE_HOUR_UTC && hourUTC < MARKET_OPEN_HOUR_UTC;
  const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;

  if (isMarketClosed || isWeekend) {
    return {
      action: 'wait',
      tradeType,
      reason: isWeekend ? 'Weekend — market closed' : 'Market close hour — no new entries',
      confidence: 0, bullScore: 0, bearScore: 0,
    };
  }

  // ── PAUSE AFTER TOO MANY CONSECUTIVE LOSSES ───────────────────────────────
  if (sizeM === 0) {
    return {
      action: 'wait',
      tradeType,
      reason: `Paused — ${performance.consecutiveLosses} consecutive losses. Self-adjusting...`,
      confidence: 0, bullScore: 0, bearScore: 0,
    };
  }

  const makeDecision = (action, reason, conf, conditions) => {
    // Apply max loss cap to SL
    const raw_sl_dist = target.pips_sl;
    const max_sl_dist = MAX_LOSS_PER_TRADE / (lots * 100);
    const sl_dist = Math.min(raw_sl_dist, max_sl_dist);
    const tp_dist = target.pips_tp;

    const tp = action === 'buy'
      ? parseFloat((price + tp_dist).toFixed(2))
      : parseFloat((price - tp_dist).toFixed(2));
    const sl = action === 'buy'
      ? parseFloat((price - sl_dist).toFixed(2))
      : parseFloat((price + sl_dist).toFixed(2));

    return { action, tradeType, reason, confidence: conf, bullScore: 0, bearScore: 0, tp, sl, lots, conditions };
  };

  if (!indicators) {
    return makeDecision(
      Math.random() > 0.5 ? 'buy' : 'sell',
      'Building history', 0.5, []
    );
  }

  const { rsi, stoch, macd, momentum, trend, ema_align } = indicators;
  const isBest  = YOUR_PATTERNS.bestHoursUTC.includes(hourUTC);
  const isWorst = YOUR_PATTERNS.worstHoursUTC.includes(hourUTC);

  let bull = 0, bear = 0;
  const log = [];
  const activeConditions = [];

  // RSI — adaptive weight
  if (rsi < 40) {
    const w = getConditionWeight('rsi_oversold_bull', 2);
    bull += w;
    log.push(`RSI bull ${rsi.toFixed(0)} (w:${w.toFixed(1)})`);
    activeConditions.push('rsi_oversold_bull');
  } else if (rsi > 60) {
    const w = getConditionWeight('rsi_overbought_bear', 2);
    bear += w;
    log.push(`RSI bear ${rsi.toFixed(0)} (w:${w.toFixed(1)})`);
    activeConditions.push('rsi_overbought_bear');
  }

  // Stochastic — adaptive weight
  if (stoch < 30) {
    const w = getConditionWeight('stoch_oversold_bull', 2);
    bull += w;
    log.push(`Stoch OS (w:${w.toFixed(1)})`);
    activeConditions.push('stoch_oversold_bull');
  } else if (stoch > 70) {
    const w = getConditionWeight('stoch_overbought_bear', 2);
    bear += w;
    log.push(`Stoch OB (w:${w.toFixed(1)})`);
    activeConditions.push('stoch_overbought_bear');
  }

  // MACD — adaptive weight
  if (macd > 0) {
    const w = getConditionWeight('macd_bull', 1);
    bull += w;
    log.push(`MACD bull (w:${w.toFixed(1)})`);
    activeConditions.push('macd_bull');
  } else {
    const w = getConditionWeight('macd_bear', 1);
    bear += w;
    log.push(`MACD bear (w:${w.toFixed(1)})`);
    activeConditions.push('macd_bear');
  }

  // EMA — adaptive weight
  if (ema_align) {
    const w = getConditionWeight('ema_bull_align', 2);
    bull += w;
    log.push(`EMA bull (w:${w.toFixed(1)})`);
    activeConditions.push('ema_bull_align');
  } else {
    const w = getConditionWeight('ema_bear_align', 1);
    bear += w;
    log.push(`EMA bear (w:${w.toFixed(1)})`);
    activeConditions.push('ema_bear_align');
  }

  // Momentum — adaptive weight
  if (momentum > 0) {
    const w = getConditionWeight('momentum_up', 1);
    bull += w;
    activeConditions.push('momentum_up');
  } else {
    const w = getConditionWeight('momentum_down', 1);
    bear += w;
    activeConditions.push('momentum_down');
  }

  // Hour adjustments
  if (isWorst) {
    bull -= 1.5; bear -= 1.5;
    log.push(`⚠ Worst hour ${hourUTC}:00`);
    activeConditions.push('worst_hour');
  }
  if (isBest) {
    bull += 1; bear += 1;
    log.push(`✓ Best hour ${hourUTC}:00`);
    activeConditions.push('best_hour');
  }

  // Key correction: avoid buying into downtrend (AI's #1 mistake from data)
  if (trend === 'bear' && bull > bear) {
    bull -= 2;
    log.push('AI self-correction: trend bearish, penalizing buy');
  }

  // Penalize buy if recent buy performance is poor
  const buyPerf = performance.byType[`${tradeType}_buy`];
  if (buyPerf && (buyPerf.wins + buyPerf.losses) >= 10) {
    const buyWR = buyPerf.wins / (buyPerf.wins + buyPerf.losses);
    if (buyWR < 0.3) {
      bull -= 1.5;
      log.push(`AI self-correction: buy WR ${(buyWR*100).toFixed(0)}% — reducing buy score`);
    }
  }

  // Boost sell if recent sell performance is good
  const sellPerf = performance.byType[`${tradeType}_sell`];
  if (sellPerf && (sellPerf.wins + sellPerf.losses) >= 5) {
    const sellWR = sellPerf.wins / (sellPerf.wins + sellPerf.losses);
    if (sellWR > 0.5) {
      bear += 1;
      log.push(`AI self-correction: sell WR ${(sellWR*100).toFixed(0)}% — boosting sell score`);
    }
  }

  // After consecutive losses — require stronger signal
  const minScore = performance.consecutiveLosses >= 3 ? 5 : 3;

  const action = bull >= bear ? 'buy' : 'sell';
  const topScore = Math.max(bull, bear);

  if (topScore < minScore) {
    return {
      action: 'wait', tradeType,
      reason: `Score ${topScore.toFixed(1)} < min ${minScore} | ${log.join(' · ')}`,
      confidence: 0, bullScore: bull, bearScore: bear,
    };
  }

  return makeDecision(
    action,
    `[${action.toUpperCase()}] B${bull.toFixed(1)}/S${bear.toFixed(1)} | ${log.join(' · ')}`,
    Math.min(topScore / 8, 1),
    activeConditions
  );
}

module.exports = {
  fetchLivePrice, pushPrice, getHistory,
  computeIndicators, decide, recordOutcome, getPerformanceSummary,
  getLotSize, LOT_PROGRESSION, BASE_LOT,
  TRADE_TARGETS, YOUR_PATTERNS,
  MARKET_CLOSE_HOUR_UTC, MARKET_OPEN_HOUR_UTC,
  MAX_LOSS_PER_TRADE,
};