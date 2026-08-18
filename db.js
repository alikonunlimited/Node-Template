'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── CREATE TABLES IF NOT EXISTS ───────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id          SERIAL PRIMARY KEY,
        trade_id    INTEGER,
        type        VARCHAR(10),
        entry       NUMERIC,
        exit        NUMERIC,
        tp          NUMERIC,
        sl          NUMERIC,
        lots        NUMERIC,
        pl          NUMERIC,
        is_win      BOOLEAN,
        open_time   TIMESTAMPTZ,
        close_time  TIMESTAMPTZ,
        close_reason VARCHAR(20),
        reason      TEXT,
        confidence  NUMERIC,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS equity_history (
        id         SERIAL PRIMARY KEY,
        balance    NUMERIC,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_summary (
        id          SERIAL PRIMARY KEY,
        date        DATE UNIQUE,
        trades      INTEGER,
        wins        INTEGER,
        losses      INTEGER,
        win_rate    NUMERIC,
        gross_pl    NUMERIC,
        balance     NUMERIC,
        avg_win     NUMERIC,
        avg_loss    NUMERIC,
        best_trade  NUMERIC,
        worst_trade NUMERIC,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('[DB] Tables ready');
  } catch (err) {
    console.error('[DB] initDB error:', err.message);
  }
}

// ── SAVE ONE TRADE ─────────────────────────────────────────────────────────────
async function saveTrade(trade) {
  try {
    await pool.query(`
      INSERT INTO trades
        (trade_id, type, entry, exit, tp, sl, lots, pl, is_win, open_time, close_time, close_reason, reason, confidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      trade.id, trade.type, trade.entry, trade.exit,
      trade.tp, trade.sl, trade.lots, trade.pl, trade.isWin,
      trade.openTime, trade.closeTime, trade.closeReason,
      trade.reason?.substring(0, 500), trade.confidence,
    ]);
    console.log(`[DB] Trade #${trade.id} saved`);
  } catch (err) {
    console.error('[DB] saveTrade error:', err.message);
  }
}

// ── SAVE EQUITY SNAPSHOT ──────────────────────────────────────────────────────
async function saveEquity(balance) {
  try {
    await pool.query(`INSERT INTO equity_history (balance) VALUES ($1)`, [balance]);
  } catch (err) {
    console.error('[DB] saveEquity error:', err.message);
  }
}

// ── SAVE DAILY SUMMARY ────────────────────────────────────────────────────────
async function saveDailySummary(data) {
  try {
    await pool.query(`
      INSERT INTO daily_summary
        (date, trades, wins, losses, win_rate, gross_pl, balance, avg_win, avg_loss, best_trade, worst_trade)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (date) DO UPDATE SET
        trades=$2, wins=$3, losses=$4, win_rate=$5, gross_pl=$6,
        balance=$7, avg_win=$8, avg_loss=$9, best_trade=$10, worst_trade=$11
    `, [
      data.date, data.trades, data.wins, data.losses,
      data.winRate, data.grossPL, data.balance,
      data.avgWin, data.avgLoss, data.best, data.worst,
    ]);
    console.log('[DB] Daily summary saved');
  } catch (err) {
    console.error('[DB] saveDailySummary error:', err.message);
  }
}

// ── LOAD ALL TRADES (on startup) ──────────────────────────────────────────────
async function loadTrades() {
  try {
    const result = await pool.query(`SELECT * FROM trades ORDER BY close_time ASC`);
    return result.rows.map(r => ({
      id:          r.trade_id,
      type:        r.type,
      entry:       parseFloat(r.entry),
      exit:        parseFloat(r.exit),
      tp:          parseFloat(r.tp),
      sl:          parseFloat(r.sl),
      lots:        parseFloat(r.lots),
      pl:          parseFloat(r.pl),
      isWin:       r.is_win,
      openTime:    r.open_time,
      closeTime:   r.close_time,
      closeReason: r.close_reason,
      reason:      r.reason,
      confidence:  parseFloat(r.confidence),
    }));
  } catch (err) {
    console.error('[DB] loadTrades error:', err.message);
    return [];
  }
}

// ── LOAD EQUITY HISTORY (on startup) ─────────────────────────────────────────
async function loadEquityHistory() {
  try {
    const result = await pool.query(`SELECT balance FROM equity_history ORDER BY recorded_at ASC`);
    return result.rows.map(r => parseFloat(r.balance));
  } catch (err) {
    console.error('[DB] loadEquityHistory error:', err.message);
    return [];
  }
}

module.exports = { initDB, saveTrade, saveEquity, saveDailySummary, loadTrades, loadEquityHistory };
