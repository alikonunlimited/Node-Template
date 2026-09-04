'use strict';
require('dotenv').config();
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

function getAuth() {
  const clientEmail  = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const jsonRaw      = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  // Prefer separate vars, fall back to full JSON
  if (clientEmail && privateKey) {
    console.log('[Sheets] Using GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY');
    return new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        client_email: clientEmail,
        private_key: privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  if (jsonRaw) {
    console.log('[Sheets] Using GOOGLE_SERVICE_ACCOUNT_JSON');
    const creds = typeof jsonRaw === 'string' ? JSON.parse(jsonRaw) : jsonRaw;
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  throw new Error('No Google credentials found in environment variables');
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

async function ensureHeaders() {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'TradeLog!A1:L1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Trade #', 'Date', 'Open Time', 'Close Time',
          'Type', 'Style', 'Entry', 'Exit', 'TP', 'SL',
          'P&L ($)', 'Result'
        ]],
      },
    });
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
    console.log('[Sheets] Headers ensured ✓');
  } catch (err) {
    console.error('[Sheets] ensureHeaders error:', err.message);
  }
}

async function logTrade(trade) {
  try {
    const sheets = await getSheets();
    const row = [
      trade.id,
      new Date(trade.openTime).toLocaleDateString('en-US'),
      new Date(trade.openTime).toLocaleTimeString('en-US'),
      new Date(trade.closeTime).toLocaleTimeString('en-US'),
      trade.type.toUpperCase(),
      (trade.tradeType || 'scalp').toUpperCase(),
      trade.entry,
      trade.exit,
      trade.tp,
      trade.sl,
      trade.pl,
      trade.isWin ? 'WIN' : 'LOSS',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'TradeLog!A:L',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log(`[Sheets] Trade #${trade.id} logged ✓`);
  } catch (err) {
    console.error('[Sheets] logTrade error:', err.message);
  }
}

async function logDailySummary(state) {
  try {
    const sheets = await getSheets();
    const today = new Date().toLocaleDateString('en-US');
    const todayTrades = state.trades.filter(t => {
      return new Date(t.closeTime).toLocaleDateString('en-US') === today;
    });
    if (!todayTrades.length) { console.log('[Sheets] No trades today'); return; }
    const wins   = todayTrades.filter(t => t.isWin);
    const losses = todayTrades.filter(t => !t.isWin);
    const pls    = todayTrades.map(t => t.pl);
    const row = [
      today,
      todayTrades.length,
      wins.length,
      losses.length,
      ((wins.length / todayTrades.length) * 100).toFixed(1),
      pls.reduce((a, b) => a + b, 0).toFixed(2),
      state.balance.toFixed(2),
      wins.length ? (wins.reduce((a,t)=>a+t.pl,0)/wins.length).toFixed(2) : 'N/A',
      losses.length ? (losses.reduce((a,t)=>a+t.pl,0)/losses.length).toFixed(2) : 'N/A',
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
    console.log('[Sheets] Daily summary logged ✓');
  } catch (err) {
    console.error('[Sheets] logDailySummary error:', err.message);
  }
}

module.exports = { ensureHeaders, logTrade, logDailySummary };