'use strict';
require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// ── AUTH ──────────────────────────────────────────────────────────────────────
function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ── SETUP SHEET HEADERS (run once on startup) ─────────────────────────────────
async function ensureHeaders() {
  try {
    const sheets = await getSheets();

    // ── Tab 1: Trade Log ──
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'TradeLog!A1:L1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Trade #', 'Date', 'Open Time', 'Close Time',
          'Type', 'Entry', 'Exit', 'TP', 'SL',
          'P&L ($)', 'Result', 'Reason'
        ]],
      },
    });

    // ── Tab 2: Daily Summary ──
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'DailySummary!A1:K1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Date', 'Trades', 'Wins', 'Losses', 'Win Rate %',
          'Gross P&L', 'Balance', 'Avg Win', 'Avg Loss',
          'Best Trade', 'Worst Trade'
        ]],
      },
    });

    console.log('[Sheets] Headers ensured');
  } catch (err) {
    console.error('[Sheets] ensureHeaders error:', err.message);
  }
}

// ── LOG ONE TRADE ─────────────────────────────────────────────────────────────
async function logTrade(trade) {
  try {
    const sheets = await getSheets();
    const row = [
      trade.id,
      new Date(trade.openTime).toLocaleDateString('en-US'),
      new Date(trade.openTime).toLocaleTimeString('en-US'),
      new Date(trade.closeTime).toLocaleTimeString('en-US'),
      trade.type.toUpperCase(),
      trade.entry,
      trade.exit,
      trade.tp,
      trade.sl,
      trade.pl,
      trade.isWin ? 'WIN' : 'LOSS',
      trade.reason.substring(0, 120),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'TradeLog!A:L',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    console.log(`[Sheets] Logged trade #${trade.id} → ${trade.isWin ? 'WIN' : 'LOSS'} $${trade.pl}`);
  } catch (err) {
    console.error('[Sheets] logTrade error:', err.message);
  }
}

// ── DAILY SUMMARY (called by cron at midnight) ────────────────────────────────
async function logDailySummary(state) {
  try {
    const sheets = await getSheets();
    const today = new Date().toLocaleDateString('en-US');

    const todayTrades = state.trades.filter(t => {
      const d = new Date(t.closeTime);
      return d.toLocaleDateString('en-US') === today;
    });

    if (todayTrades.length === 0) {
      console.log('[Sheets] No trades today — skipping daily summary');
      return;
    }

    const wins   = todayTrades.filter(t => t.isWin);
    const losses = todayTrades.filter(t => !t.isWin);
    const pls    = todayTrades.map(t => t.pl);
    const gross  = pls.reduce((a, b) => a + b, 0).toFixed(2);
    const avgWin = wins.length ? (wins.reduce((a,t)=>a+t.pl,0)/wins.length).toFixed(2) : 'N/A';
    const avgLoss= losses.length ? (losses.reduce((a,t)=>a+t.pl,0)/losses.length).toFixed(2) : 'N/A';

    const row = [
      today,
      todayTrades.length,
      wins.length,
      losses.length,
      ((wins.length / todayTrades.length) * 100).toFixed(1),
      gross,
      state.balance.toFixed(2),
      avgWin,
      avgLoss,
      Math.max(...pls).toFixed(2),
      Math.min(...pls).toFixed(2),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'DailySummary!A:K',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    console.log(`[Sheets] Daily summary logged for ${today}`);
  } catch (err) {
    console.error('[Sheets] logDailySummary error:', err.message);
  }
}

module.exports = { ensureHeaders, logTrade, logDailySummary };
