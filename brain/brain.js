#!/usr/bin/env node
// AIKON-OS Commander Brain v1.3
// 24/7 learning worker — runs on Railway, independent of Thomas
// Learns for ALL business branches, current and future
// Commander on Thomas syncs on startup and picks up everything missed

const https   = require('https');
const http    = require('http');
const { Pool } = require('pg');

const VERSION = '1.3';

// ─── DB ───────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS brain_memory (
      id          SERIAL PRIMARY KEY,
      branch      TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT,
      score       FLOAT DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS brain_branch_idx ON brain_memory(branch)`);
  await query(`CREATE INDEX IF NOT EXISTS brain_type_idx   ON brain_memory(type)`);
  await query(`CREATE INDEX IF NOT EXISTS brain_time_idx   ON brain_memory(created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS brain_branches (
      id           SERIAL PRIMARY KEY,
      slug         TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      keywords     TEXT[],
      news_queries TEXT[],
      data_urls    TEXT[],
      active       BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS brain_status (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed default branches (upsert — safe to re-run)
  const defaults = [
    {
      slug: 'trader',
      name: 'XAU/USD Trader',
      keywords: ['gold','xau','usd','forex','trade','price','signal','market','inflation','fed'],
      news_queries: ['gold price XAU USD forecast today','federal reserve interest rates gold','XAU USD technical analysis'],
      data_urls: ['https://xauusd-trader-80p0.onrender.com/api/state'],
    },
    {
      slug: 'roblox',
      name: 'Roblox Games',
      keywords: ['roblox','robux','game','silent santa','magic moments','castle kings','dead to dawn','lemonade','stick fights','metaverse'],
      news_queries: ['roblox game monetization trends 2024','roblox top earning games 2024','roblox developer revenue tips'],
      data_urls: [],
    },
    {
      slug: 'agency',
      name: 'Restaurant Web Agency',
      keywords: ['restaurant','web','agency','client','lead','demo','outreach','local business','seo','menu'],
      news_queries: ['restaurant local business website 2024','small business web design pricing','restaurant digital marketing ROI'],
      data_urls: [],
    },
    {
      slug: 'aikon_os',
      name: 'AIKON-OS',
      keywords: ['commander','ollama','ai','node','render','postgres','automation','system','update','voice'],
      news_queries: ['local AI models Ollama 2024','AI automation tools small business','open source LLM business tools'],
      data_urls: [],
    },
    {
      slug: 'opportunities',
      name: 'New Opportunities',
      keywords: ['saas','passive income','automate','business','app','tool','grant','startup','niche','revenue'],
      news_queries: ['automated business ideas 2024 low cost','passive income online business','AI tools business opportunity 2024','grant funding small business Ohio 2024'],
      data_urls: [],
    },
    {
      slug: 'good_ish',
      name: 'Good Ish (Food Cart)',
      keywords: ['food cart','burger','mobile food','street food','columbus','permit','vendor'],
      news_queries: ['mobile food cart business Columbus Ohio','food cart permit Ohio 2024','mobile food business profit margins'],
      data_urls: [],
    },
    {
      slug: 'cleaning',
      name: 'Commercial Cleaning',
      keywords: ['cleaning','commercial','janitorial','contract','bid','office','columbus'],
      news_queries: ['commercial cleaning business startup 2024','janitorial contract pricing','cleaning business automation software'],
      data_urls: [],
    },
    {
      slug: 'backin',
      name: 'BackIn (Car Lockout App)',
      keywords: ['lockout','car','roadside','app','locksmith','columbus','emergency'],
      news_queries: ['car lockout app market 2024','roadside assistance app startup','locksmith app business model'],
      data_urls: [],
    },
  ];

  for (const b of defaults) {
    await query(`
      INSERT INTO brain_branches (slug, name, keywords, news_queries, data_urls)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (slug) DO UPDATE SET
        name         = EXCLUDED.name,
        news_queries = EXCLUDED.news_queries,
        data_urls    = EXCLUDED.data_urls
    `, [b.slug, b.name, b.keywords, b.news_queries, b.data_urls]);
  }

  log(`DB: initialized — tables ready`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function setStatus(key, value) {
  await query(`
    INSERT INTO brain_status (key, value, updated_at) VALUES ($1,$2,NOW())
    ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
  `, [key, typeof value === 'string' ? value : JSON.stringify(value)]);
}

// ─── MEMORY ───────────────────────────────────────────────────────────────────
async function remember(branch, type, content, source = null, score = 0) {
  if (!content || content.length < 10) return;
  // Dedupe: skip if near-identical content in last 24h
  const existing = await query(`
    SELECT id FROM brain_memory
    WHERE branch=$1 AND type=$2 AND content ILIKE $3
    AND created_at > NOW() - INTERVAL '24 hours'
    LIMIT 1
  `, [branch, type, `%${content.substring(0, 50)}%`]);
  if (existing.rows.length > 0) return;

  await query(`
    INSERT INTO brain_memory (branch, type, content, source, score)
    VALUES ($1,$2,$3,$4,$5)
  `, [branch, type, content.substring(0, 1000), source, score]);
}

async function getMemory(branch, type = null, limit = 20) {
  const sql = type
    ? `SELECT * FROM brain_memory WHERE branch=$1 AND type=$2 ORDER BY created_at DESC LIMIT $3`
    : `SELECT * FROM brain_memory WHERE branch=$1 ORDER BY created_at DESC LIMIT $2`;
  const params = type ? [branch, type, limit] : [branch, limit];
  const res = await query(sql, params);
  return res.rows;
}

async function getTopInsights(limit = 10) {
  const res = await query(`
    SELECT * FROM brain_memory
    WHERE score > 0
    ORDER BY score DESC, created_at DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

// ─── LEARN: DATA SOURCES ──────────────────────────────────────────────────────
async function learnFromUrl(branch, url) {
  try {
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    // Trader-specific parsing
    if (url.includes('xauusd-trader')) {
      const insight = `balance=$${data.balance?.toFixed(2)}, winRate=${data.winRate}%, status=${data.status}, price=$${data.currentPrice}, openTrades=${data.openTrades}, consecutiveLosses=${data.consecutiveLosses}`;
      await remember(branch, 'data', insight, url, 1);
      log(`LEARN [${branch}]: trader snapshot — ${insight}`);
    } else {
      // Generic JSON — stringify top-level keys
      const insight = JSON.stringify(data).substring(0, 500);
      await remember(branch, 'data', insight, url, 0.5);
      log(`LEARN [${branch}]: data from ${url}`);
    }
  } catch(e) {
    log(`LEARN_ERR [${branch}] url=${url}: ${e.message}`);
  }
}

// ─── LEARN: NEWS (DuckDuckGo — free, no key) ─────────────────────────────────
async function learnFromNews(branch, newsQuery) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(newsQuery)}&format=json&no_html=1&skip_disambig=1`;
    const raw = await httpGet(url);
    const data = JSON.parse(raw);

    const insights = [];
    if (data.AbstractText && data.AbstractText.length > 30) insights.push(data.AbstractText);
    if (data.Answer && data.Answer.length > 10) insights.push(`Answer: ${data.Answer}`);
    (data.RelatedTopics || []).slice(0, 3).forEach(t => {
      if (t.Text && t.Text.length > 20) insights.push(t.Text);
    });

    for (const insight of insights) {
      await remember(branch, 'news', insight.substring(0, 500), `ddg:${newsQuery}`, 0.5);
    }

    if (insights.length > 0) log(`LEARN [${branch}]: ${insights.length} news items — "${newsQuery}"`);
  } catch(e) {
    log(`LEARN_ERR [${branch}] news="${newsQuery}": ${e.message}`);
  }
}

// ─── LEARN: OPPORTUNITY SCORING ───────────────────────────────────────────────
async function scoreOpportunities() {
  // Pull recent news from opportunities branch and score each
  const items = await getMemory('opportunities', 'news', 20);
  for (const item of items) {
    if (item.score > 0) continue; // already scored
    // Simple keyword scoring — no LLM needed on Render (no Ollama)
    const text = item.content.toLowerCase();
    let score = 0;
    if (text.includes('automated') || text.includes('automation')) score += 2;
    if (text.includes('passive')) score += 1.5;
    if (text.includes('saas') || text.includes('software')) score += 1.5;
    if (text.includes('no-code') || text.includes('low-code')) score += 1;
    if (text.includes('grant') || text.includes('funding')) score += 2;
    if (text.includes('ohio') || text.includes('columbus')) score += 1;
    if (text.includes('node') || text.includes('javascript') || text.includes('flutter')) score += 1;
    if (text.includes('roblox') || text.includes('gaming')) score += 0.5;
    if (text.includes('free') || text.includes('low cost') || text.includes('cheap')) score += 1;

    if (score > 0) {
      await query(`UPDATE brain_memory SET score=$1 WHERE id=$2`, [score, item.id]);
    }
  }
}

// ─── LEARN: CROSS-BRANCH SYNTHESIS ───────────────────────────────────────────
async function synthesize() {
  // Find high-score items across all branches and write a combined insight
  const top = await getTopInsights(5);
  if (top.length < 3) return;

  const summary = top.map(t => `[${t.branch}] ${t.content.substring(0, 100)}`).join(' | ');
  await remember('opportunities', 'synthesis',
    `Cross-branch synthesis: ${summary}`,
    'brain_synthesizer', 2
  );
  log(`SYNTHESIZE: wrote cross-branch insight from ${top.length} top items`);
}

// ─── MAIN LEARN CYCLE ─────────────────────────────────────────────────────────
let cycleCount = 0;

async function learnCycle() {
  cycleCount++;
  log(`CYCLE #${cycleCount} starting`);

  try {
    // Load all active branches
    const { rows: branches } = await query(`SELECT * FROM brain_branches WHERE active=true`);

    for (const branch of branches) {
      // 1. Pull data from any live URLs (trader API, etc)
      for (const url of (branch.data_urls || [])) {
        await learnFromUrl(branch.slug, url);
      }

      // 2. Pull one news query per branch per cycle (rotate through queries)
      const queries = branch.news_queries || [];
      if (queries.length > 0) {
        const q = queries[cycleCount % queries.length];
        await learnFromNews(branch.slug, q);
      }
    }

    // 3. Score opportunities every cycle
    await scoreOpportunities();

    // 4. Cross-branch synthesis every 12 cycles (~1hr)
    if (cycleCount % 12 === 0) await synthesize();

    // 5. Update status
    const totalRows = await query(`SELECT COUNT(*) FROM brain_memory`);
    await setStatus('last_cycle', new Date().toISOString());
    await setStatus('cycle_count', String(cycleCount));
    await setStatus('total_memories', totalRows.rows[0].count);
    await setStatus('version', VERSION);
    await setStatus('branches_active', String(branches.length));

    log(`CYCLE #${cycleCount} complete — ${totalRows.rows[0].count} total memories`);
  } catch(e) {
    log(`CYCLE_ERR: ${e.message}`);
  }
}

// ─── HTTP STATUS SERVER ───────────────────────────────────────────────────────
// Render needs a port binding to keep the service alive
const express = require('express');
const app = express();
app.use(require('express').json());

// WebSocket proxy — browser connects here, we forward to Commander on Thomas
let WS = null;
try { WS = require('ws'); } catch(e) { log('ws not installed — HUD proxy disabled'); }

// Offline feed buffer — last 50 events, served to new HUD connections when Thomas is offline
const feedBuffer = [];
function bufferFeed(msg) {
  feedBuffer.push(msg);
  if (feedBuffer.length > 50) feedBuffer.shift();
}

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-bridge-key'] || req.query.key;
  if (process.env.BRIDGE_KEY && key !== process.env.BRIDGE_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ─── WAKE ON LAN ─────────────────────────────────────────────────────────────
// Sends magic packet to Thomas via Tailscale network
// MAC: 9C-7B-EF-3D-3D-46  |  Tailscale IP: 100.91.204.20

const dgram = require('dgram');

function sendMagicPacket(mac, ip, port = 9) {
  return new Promise((resolve, reject) => {
    // Build magic packet: 6x FF + 16x MAC
    const macBytes = mac.replace(/[:\-]/g, '').match(/.{2}/g).map(h => parseInt(h, 16));
    const buf = Buffer.alloc(102);
    buf.fill(0xFF, 0, 6);
    for (let i = 1; i <= 16; i++) {
      macBytes.forEach((b, j) => buf.writeUInt8(b, 6 + (i - 1) * 6 + j));
    }
    const socket = dgram.createSocket('udp4');
    socket.once('error', e => { socket.close(); reject(e); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(buf, 0, buf.length, port, ip, err => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}

const THOMAS_MAC = process.env.THOMAS_MAC || '9C-7B-EF-3D-3D-46';
const THOMAS_IP  = process.env.THOMAS_IP  || '100.91.204.20';

app.post('/wake', auth, async (req, res) => {
  try {
    await sendMagicPacket(THOMAS_MAC, THOMAS_IP);
    log(`WAKE: magic packet sent to ${THOMAS_MAC} @ ${THOMAS_IP}`);
    res.json({ ok: true, message: 'Magic packet sent to Thomas', mac: THOMAS_MAC, ip: THOMAS_IP });
  } catch(e) {
    log(`WAKE_ERR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Check if Thomas (Commander) is reachable via Tailscale
app.get('/ping-thomas', auth, async (req, res) => {
  const commanderPort = process.env.THOMAS_COMMANDER_PORT || 3000;
  try {
    await new Promise((resolve, reject) => {
      const req2 = http.request({
        hostname: THOMAS_IP, port: commanderPort,
        path: '/health', method: 'GET', timeout: 3000
      }, r => { r.resume(); resolve(); });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
      req2.end();
    });
    res.json({ online: true, ip: THOMAS_IP });
  } catch(e) {
    res.json({ online: false, ip: THOMAS_IP, reason: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'alive', version: VERSION, cycle: cycleCount, uptime: Math.floor(process.uptime()) });
});

app.get('/status', auth, async (req, res) => {
  try {
    const { rows } = await query(`SELECT key, value FROM brain_status`);
    const status = {};
    rows.forEach(r => status[r.key] = r.value);
    res.json({ ...status, uptime: Math.floor(process.uptime()), version: VERSION });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/memory', auth, async (req, res) => {
  try {
    const { branch, type, limit = 20 } = req.query;
    if (!branch) {
      // Summary of all branches
      const { rows } = await query(`
        SELECT branch, COUNT(*) as count, MAX(created_at) as last_update
        FROM brain_memory GROUP BY branch ORDER BY count DESC
      `);
      return res.json({ branches: rows });
    }
    const rows = await getMemory(branch, type || null, parseInt(limit));
    res.json({ branch, count: rows.length, items: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/opportunities', auth, async (req, res) => {
  try {
    const top = await getTopInsights(20);
    res.json({ count: top.length, items: top });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Commander calls this on Thomas startup to sync missed learning
app.get('/sync', auth, async (req, res) => {
  try {
    const since = req.query.since || new Date(Date.now() - 86400000).toISOString(); // last 24h default
    const { rows } = await query(`
      SELECT * FROM brain_memory
      WHERE created_at > $1
      ORDER BY created_at ASC
    `, [since]);
    res.json({ since, count: rows.length, items: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add a new business branch dynamically
app.post('/branch', auth, async (req, res) => {
  try {
    const { slug, name, keywords = [], news_queries = [], data_urls = [] } = req.body;
    if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
    await query(`
      INSERT INTO brain_branches (slug, name, keywords, news_queries, data_urls)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (slug) DO UPDATE SET name=$2, keywords=$3, news_queries=$4, data_urls=$5, active=true
    `, [slug, name, keywords, news_queries, data_urls]);
    res.json({ ok: true, message: `Branch "${name}" added — brain will start learning next cycle` });
    log(`BRANCH ADDED: ${slug} — ${name}`);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/branches', auth, async (req, res) => {
  try {
    const { rows } = await query(`SELECT slug, name, active, created_at FROM brain_branches ORDER BY created_at`);
    res.json({ branches: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── MOBILE WEB UI ───────────────────────────────────────────────────────────
// No auth — public read-only dashboard; write ops still require x-bridge-key

app.get('/ui', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>AIKON-OS</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--card:#12121a;--border:#1e1e2e;--accent:#7c3aed;--accent2:#06b6d4;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--text:#e2e8f0;--muted:#64748b;--font:'system-ui',-apple-system,sans-serif}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;padding:0 0 60px}
header{background:linear-gradient(135deg,#1e0a4e,#0a1e3f);padding:16px 20px;position:sticky;top:0;z-index:10;border-bottom:1px solid var(--border)}
header h1{font-size:1.1rem;font-weight:700;letter-spacing:.05em;color:#a78bfa}
header span{font-size:.75rem;color:var(--muted);display:block;margin-top:2px}
.tabs{display:flex;gap:4px;padding:12px 16px;overflow-x:auto;position:sticky;top:57px;z-index:9;background:var(--bg);border-bottom:1px solid var(--border)}
.tab{background:var(--card);border:1px solid var(--border);color:var(--muted);padding:6px 14px;border-radius:20px;font-size:.8rem;white-space:nowrap;cursor:pointer;transition:.2s}
.tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
.pane{display:none;padding:16px}
.pane.active{display:block}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px}
.card h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px}
.stat{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);font-size:.85rem}
.stat:last-child{border:none}
.badge{font-size:.7rem;padding:2px 8px;border-radius:10px;font-weight:600}
.ok{background:#14532d;color:var(--green)}
.warn{background:#713f12;color:var(--yellow)}
.err{background:#7f1d1d;color:var(--red)}
.mem-item{padding:8px 0;border-bottom:1px solid var(--border);font-size:.8rem;line-height:1.5}
.mem-item:last-child{border:none}
.mem-item .branch{font-size:.7rem;color:var(--accent2);font-weight:600;margin-bottom:2px}
.opp{background:linear-gradient(135deg,var(--card),#1a1230);border:1px solid #2d1f5e;border-radius:10px;padding:12px;margin-bottom:10px}
.opp .score{font-size:1.4rem;font-weight:700;color:var(--accent);float:right}
.opp .branch-tag{font-size:.7rem;background:#1e1e40;color:#a78bfa;padding:2px 8px;border-radius:8px;display:inline-block;margin-bottom:6px}
.opp p{font-size:.82rem;color:var(--text);line-height:1.5;clear:both}
.refresh-btn{position:fixed;bottom:20px;right:20px;background:var(--accent);color:#fff;border:none;border-radius:50%;width:52px;height:52px;font-size:1.3rem;cursor:pointer;box-shadow:0 4px 20px rgba(124,58,237,.4)}
.loading{text-align:center;color:var(--muted);padding:40px;font-size:.9rem}
.ts{font-size:.7rem;color:var(--muted);margin-top:4px}
.branch-pill{display:inline-flex;align-items:center;gap:6px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin:4px;font-size:.8rem}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green)}
.dot.off{background:var(--muted)}
#chat-out{background:#06060c;border:1px solid var(--border);border-radius:10px;padding:12px;min-height:120px;max-height:300px;overflow-y:auto;font-size:.82rem;line-height:1.6;margin-bottom:10px;white-space:pre-wrap}
#chat-in{width:100%;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px;color:var(--text);font-size:.85rem;outline:none}
#chat-in:focus{border-color:var(--accent)}
.send-btn{width:100%;margin-top:8px;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:12px;font-size:.9rem;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<header>
  <h1>⚡ AIKON-OS Commander</h1>
  <span id="last-refresh">Loading...</span>
  <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
    <span id="thomas-status" style="font-size:.75rem;color:var(--muted)">● Checking Thomas...</span>
    <button id="wake-btn" onclick="wakeThomas()" style="background:#1a0a3e;border:1px solid var(--accent);color:#a78bfa;padding:4px 12px;border-radius:12px;font-size:.75rem;cursor:pointer">⚡ Wake Thomas</button>
  </div>
</header>
<div class="tabs">
  <div class="tab active" onclick="switchTab('status')">Status</div>
  <div class="tab" onclick="switchTab('opportunities')">Opportunities</div>
  <div class="tab" onclick="switchTab('memory')">Memory</div>
  <div class="tab" onclick="switchTab('branches')">Branches</div>
  <div class="tab" onclick="switchTab('ask')">Ask</div>
</div>

<div id="pane-status" class="pane active"><div class="loading">Loading...</div></div>
<div id="pane-opportunities" class="pane"><div class="loading">Loading...</div></div>
<div id="pane-memory" class="pane"><div class="loading">Loading...</div></div>
<div id="pane-branches" class="pane"><div class="loading">Loading...</div></div>
<div id="pane-ask" class="pane">
  <div class="card">
    <h3>Ask Brain</h3>
    <div id="chat-out">Ask the Brain a question below — it will query memory and respond.</div>
    <input id="chat-in" type="text" placeholder="What opportunities exist in roblox this week?" onkeydown="if(event.key==='Enter')sendAsk()">
    <button class="send-btn" onclick="sendAsk()">Send ➤</button>
  </div>
</div>

<button class="refresh-btn" onclick="loadAll()" title="Refresh">↻</button>

<script>
const BASE = '';

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    const names = ['status','opportunities','memory','branches','ask'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.getElementById('pane-' + name).classList.add('active');
}

async function fetchJSON(path) {
  const r = await fetch(BASE + path);
  return r.json();
}

function badge(val, okTest, warnTest) {
  if (okTest(val)) return \`<span class="badge ok">✅ \${val}</span>\`;
  if (warnTest && warnTest(val)) return \`<span class="badge warn">⚠️ \${val}</span>\`;
  return \`<span class="badge err">❌ \${val}</span>\`;
}

function ts(str) {
  if (!str) return '';
  try { return new Date(str).toLocaleTimeString(); } catch(e) { return str; }
}

async function loadStatus() {
  const el = document.getElementById('pane-status');
  try {
    const d = await fetchJSON('/status');
    el.innerHTML = \`
<div class="card">
  <h3>🧠 Brain</h3>
  <div class="stat"><span>Version</span><span>v\${d.version}</span></div>
  <div class="stat"><span>Uptime</span><span>\${Math.floor(d.uptime/60)} min</span></div>
  <div class="stat"><span>Cycles</span><span>\${d.cycle_count}</span></div>
  <div class="stat"><span>Total Memories</span><span>\${d.total_memories}</span></div>
  <div class="stat"><span>Active Branches</span><span>\${d.branches_active}</span></div>
  <div class="stat"><span>Last Cycle</span><span>\${ts(d.last_cycle)}</span></div>
</div>
<div class="card">
  <h3>📊 Opportunities</h3>
  <div class="stat"><span>Scored</span><span>\${d.opportunities_scored}</span></div>
</div>
    \`;
  } catch(e) {
    el.innerHTML = \`<div class="card"><p style="color:var(--red)">\${e.message}</p></div>\`;
  }
}

async function loadOpportunities() {
  const el = document.getElementById('pane-opportunities');
  try {
    const d = await fetchJSON('/opportunities');
    if (!d.items?.length) { el.innerHTML = '<div class="loading">No opportunities yet.</div>'; return; }
    el.innerHTML = d.items.map(o => \`
<div class="opp">
  <span class="score">\${(o.score||0).toFixed(1)}</span>
  <span class="branch-tag">\${o.branch}</span>
  <p>\${o.content?.substring(0,200) || ''}</p>
  <div class="ts">\${ts(o.ts)}</div>
</div>\`).join('');
  } catch(e) {
    el.innerHTML = \`<div class="card"><p style="color:var(--red)">\${e.message}</p></div>\`;
  }
}

async function loadMemory() {
  const el = document.getElementById('pane-memory');
  try {
    const d = await fetchJSON('/memory?limit=30');
    if (!d.memories?.length) { el.innerHTML = '<div class="loading">No memories yet.</div>'; return; }
    el.innerHTML = '<div class="card"><h3>Recent Memory</h3>' +
      d.memories.map(m => \`<div class="mem-item">
        <div class="branch">\${m.branch} · \${m.memory_type}</div>
        \${(m.content||m.insight||'').substring(0,200)}
        <div class="ts">\${ts(m.created_at)}</div>
      </div>\`).join('') + '</div>';
  } catch(e) {
    el.innerHTML = \`<div class="card"><p style="color:var(--red)">\${e.message}</p></div>\`;
  }
}

async function loadBranches() {
  const el = document.getElementById('pane-branches');
  try {
    const d = await fetchJSON('/branches');
    el.innerHTML = '<div class="card"><h3>Business Branches</h3>' +
      (d.branches||[]).map(b => \`
<div class="branch-pill">
  <span class="dot \${b.active ? '' : 'off'}"></span>
  <span>\${b.name}</span>
  <span style="color:var(--muted);font-size:.7rem">\${b.slug}</span>
</div>\`).join('') + '</div>';
  } catch(e) {
    el.innerHTML = \`<div class="card"><p style="color:var(--red)">\${e.message}</p></div>\`;
  }
}

async function sendAsk() {
  const inp = document.getElementById('chat-in');
  const out = document.getElementById('chat-out');
  const q = inp.value.trim();
  if (!q) return;
  inp.value = '';
  out.textContent += \`\\nYou: \${q}\\n\`;
  out.textContent += 'Brain: thinking...\\n';
  out.scrollTop = out.scrollHeight;
  try {
    const r = await fetch('/ask', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q})});
    const d = await r.json();
    const lines = out.textContent.split('\\n');
    lines.pop(); lines.pop(); // remove "thinking..." and blank
    out.textContent = lines.join('\\n') + '\\nBrain: ' + (d.answer||d.error||'No response') + '\\n';
    out.scrollTop = out.scrollHeight;
  } catch(e) {
    out.textContent += 'Error: ' + e.message + '\\n';
  }
}

async function checkThomas() {
  const el = document.getElementById('thomas-status');
  const btn = document.getElementById('wake-btn');
  try {
    const r = await fetch('/ping-thomas');
    const d = await r.json();
    if (d.online) {
      el.style.color = 'var(--green)';
      el.textContent = '● Thomas online';
      btn.style.display = 'none';
    } else {
      el.style.color = 'var(--red)';
      el.textContent = '● Thomas offline';
      btn.style.display = 'inline-block';
    }
  } catch(e) {
    el.style.color = 'var(--muted)';
    el.textContent = '● Thomas unknown';
  }
}

async function wakeThomas() {
  const btn = document.getElementById('wake-btn');
  const el  = document.getElementById('thomas-status');
  btn.textContent = '⚡ Sending...';
  btn.disabled = true;
  try {
    const r = await fetch('/wake', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    const d = await r.json();
    if (d.ok) {
      el.style.color = 'var(--yellow)';
      el.textContent = '● Magic packet sent — booting...';
      btn.textContent = '⚡ Sent!';
      // Re-check after 30s
      setTimeout(() => { checkThomas(); btn.textContent = '⚡ Wake Thomas'; btn.disabled = false; }, 30000);
    } else {
      btn.textContent = '⚡ Wake Thomas';
      btn.disabled = false;
    }
  } catch(e) {
    btn.textContent = '⚡ Wake Thomas';
    btn.disabled = false;
  }
}

async function loadAll() {
  document.getElementById('last-refresh').textContent = 'Refreshed ' + new Date().toLocaleTimeString();
  await Promise.all([loadStatus(), loadOpportunities(), loadMemory(), loadBranches(), checkThomas()]);
}

loadAll();
// Check Thomas status every 60s
setInterval(checkThomas, 60000);
</script>
</body>
</html>`);
});

// /message — Phone PWA relay: forwards to Commander /message on Thomas, falls back to Brain memory
app.post('/message', async (req, res) => {
  const { message, source = 'bridge' } = req.body || {};
  if (!message) return res.json({ error: 'No message' });
  const commanderPort = process.env.THOMAS_COMMANDER_PORT || 3000;
  // Try to forward to Commander on Thomas
  try {
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ message, source });
      const opts = {
        hostname: THOMAS_IP, port: commanderPort,
        path: '/message', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-bridge-key': process.env.BRIDGE_KEY || '' },
        timeout: 8000
      };
      const req2 = http.request(opts, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(d));
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
      req2.write(body);
      req2.end();
    });
    const parsed = JSON.parse(response);
    return res.json(parsed);
  } catch(e) {
    // Thomas offline — fall back to Brain memory response
    log(`MESSAGE_RELAY: Thomas unreachable (${e.message}) — falling back to Brain`);
    try {
      const { rows } = await query(
        `SELECT branch, content FROM brain_memory WHERE content ILIKE $1 ORDER BY created_at DESC LIMIT 5`,
        [`%${message.substring(0,50).replace(/%/g,'')}%`]
      );
      const context = rows.length
        ? rows.map(r => `[${r.branch}] ${r.content}`).join('\n')
        : 'No matching memory found.';
      return res.json({
        response: `[Brain offline-mode]\n${context}\n\nThomas is offline — wake it via the ⚡ button to reach Commander directly.`,
        offline: true
      });
    } catch(dbErr) {
      return res.json({ error: 'Brain unavailable', offline: true });
    }
  }
});

// /ask endpoint for mobile UI chat
app.post('/ask', async (req, res) => {
  const { q } = req.body || {};
  if (!q) return res.json({ error: 'No question' });
  try {
    const { rows } = await query(
      `SELECT branch, content, insight FROM brain_memory
       WHERE content ILIKE $1 OR insight ILIKE $1
       ORDER BY created_at DESC LIMIT 5`,
      [`%${q.substring(0,50).replace(/%/g,'')}%`]
    );
    const context = rows.length
      ? rows.map(r => `[${r.branch}] ${r.content || r.insight}`).join('\n')
      : 'No specific memory found.';
    res.json({ answer: `Based on brain memory:\n\n${context}\n\nAsk Commander directly for deeper analysis.` });
  } catch(e) { res.json({ error: e.message }); }
});

// ─── JARVIS HUD ───────────────────────────────────────────────────────────────
// Fullscreen futuristic display — served at /jarvis
// Connects to Commander's WebSocket on Thomas for live feed
app.get('/jarvis', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(JARVIS_HUD_HTML);
});

// ─── PHONE VOICE PWA ─────────────────────────────────────────────────────────
// Installable PWA — served at /app
app.get('/app', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PHONE_PWA_HTML);
});

// PWA manifest
app.get('/app.webmanifest', (req, res) => {
  res.json({
    name: 'AIKON Commander',
    short_name: 'Commander',
    description: 'Voice interface to AIKON-OS Commander',
    start_url: '/app',
    display: 'standalone',
    background_color: '#050510',
    theme_color: '#7c3aed',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

// SVG icon for PWA (purple lightning bolt)
app.get('/icon-192.png', (req, res) => {
  // Return an SVG that browsers can use as a fallback
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#050510"/><text x="96" y="130" text-anchor="middle" font-size="100" fill="#7c3aed">⚡</text></svg>`);
});
app.get('/icon-512.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="80" fill="#050510"/><text x="256" y="340" text-anchor="middle" font-size="260" fill="#7c3aed">⚡</text></svg>`);
});

// ─── STATIC HTML ─────────────────────────────────────────────────────────────
const JARVIS_HUD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIKON-OS — JARVIS HUD</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#000005;--panel:rgba(10,8,25,.82);--border:rgba(255,165,0,.18);
  --gold:#ffaa00;--gold2:#ff8800;--gold3:#ffdd88;
  --amber:#ff6600;--core:#fff8e0;
  --cyan:#00f5ff;--green:#00ff88;--red:#ff3366;--dim:#554422;
  --font-hud:'Orbitron',monospace;--font-mono:'Share Tech Mono',monospace;
  --glow-gold:0 0 30px #ffaa0066,0 0 60px #ff880033;
}
html,body{width:100%;height:100%;background:var(--bg);color:var(--gold);font-family:var(--font-hud);overflow:hidden}
body{display:grid;grid-template-rows:auto 1fr auto;grid-template-columns:1fr;height:100vh}

/* ── STARS ── */
#stars{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
.star{position:absolute;border-radius:50%;background:#fff;animation:twinkle var(--d,3s) ease-in-out infinite}
@keyframes twinkle{0%,100%{opacity:.1}50%{opacity:var(--op,.7)}}

/* ── TOP BAR ── */
#topbar{
  position:relative;z-index:10;
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 28px;
  background:linear-gradient(180deg,rgba(255,140,0,.06) 0%,transparent 100%);
  border-bottom:1px solid rgba(255,140,0,.2);
}
.logo{font-size:1rem;font-weight:900;letter-spacing:.22em;color:var(--gold);text-shadow:var(--glow-gold)}
.subtitle{font-size:.55rem;color:rgba(255,170,0,.5);letter-spacing:.18em;margin-top:2px}
.clock{font-size:1.3rem;font-weight:700;color:var(--gold3);font-family:var(--font-mono);letter-spacing:.08em;text-align:center}
.date-line{font-size:.55rem;color:rgba(255,140,0,.4);letter-spacing:.12em;text-align:center;margin-top:2px}
#conn-status{font-size:.6rem;letter-spacing:.12em;padding:3px 12px;border-radius:14px;border:1px solid;transition:.4s;text-align:right}
#conn-status.connected{color:var(--green);border-color:var(--green);box-shadow:0 0 10px #00ff8833;text-shadow:0 0 8px var(--green)}
#conn-status.disconnected{color:var(--red);border-color:var(--red)}
#conn-status.connecting{color:var(--gold);border-color:var(--gold);animation:connPulse 1.5s ease-in-out infinite}
@keyframes connPulse{0%,100%{opacity:.6}50%{opacity:1}}

/* ── MAIN LAYOUT ── */
#main{
  position:relative;z-index:5;
  display:grid;grid-template-columns:260px 1fr 260px;
  gap:10px;padding:10px 14px;overflow:hidden;height:100%
}

/* ── PANELS ── */
.panel{
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:6px;padding:12px;
  position:relative;overflow:hidden;
  display:flex;flex-direction:column;gap:7px;
  backdrop-filter:blur(6px);
}
.panel::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:.7;
}
.panel.amber::before{background:linear-gradient(90deg,transparent,var(--amber),transparent)}
.panel.green::before{background:linear-gradient(90deg,transparent,var(--green),transparent)}
.panel::after{
  content:'';position:absolute;top:5px;right:5px;width:5px;height:5px;
  border-top:1px solid var(--gold);border-right:1px solid var(--gold);opacity:.5;pointer-events:none
}
.panel-title{
  font-size:.55rem;letter-spacing:.22em;
  color:rgba(255,165,0,.55);text-transform:uppercase;
  margin-bottom:2px;display:flex;align-items:center;gap:6px
}
.panel-title::after{content:'';flex:1;height:1px;background:rgba(255,140,0,.15)}

/* ── STAT ROWS ── */
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,140,0,.08);font-size:.68rem}
.stat-row:last-child{border:none}
.stat-label{color:rgba(255,140,0,.4);letter-spacing:.05em}
.stat-val{color:var(--gold3);font-family:var(--font-mono)}
.stat-val.ok{color:var(--green);text-shadow:0 0 8px var(--green)}
.stat-val.off{color:var(--red)}

/* ── TRADER ── */
.trader-price{
  font-size:1.5rem;font-weight:700;
  color:var(--gold);font-family:var(--font-mono);
  text-shadow:var(--glow-gold);text-align:center;padding:6px 0;
  animation:priceGlow 2.5s ease-in-out infinite
}
@keyframes priceGlow{0%,100%{text-shadow:0 0 20px #ffaa0055}50%{text-shadow:0 0 40px #ffaa00aa,0 0 80px #ff880044}}
.trader-row{display:flex;justify-content:space-between;font-size:.68rem;padding:3px 0;border-bottom:1px solid rgba(255,140,0,.08)}
.trader-row:last-child{border:none}
.trader-row span:first-child{color:rgba(255,140,0,.4)}
.trader-row span:last-child{font-family:var(--font-mono);color:var(--gold3)}

/* ── ORB CENTER ── */
#orb-wrap{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:0;padding:0;position:relative;overflow:visible
}
#orb-scene{
  position:relative;width:260px;height:260px;
  display:flex;align-items:center;justify-content:center;
  flex-shrink:0;
}
/* Core glow */
#orb-core{
  position:absolute;width:70px;height:70px;border-radius:50%;
  background:radial-gradient(circle at 38% 36%,#fffde0 0%,#ffd060 30%,#ff9900 60%,#ff6600 85%,#aa3300 100%);
  box-shadow:0 0 20px 8px #ffcc4499,0 0 50px 20px #ff880066,0 0 100px 40px #ff440033;
  z-index:10;animation:coreBreath 3s ease-in-out infinite
}
@keyframes coreBreath{
  0%,100%{transform:scale(1);box-shadow:0 0 20px 8px #ffcc4499,0 0 50px 20px #ff880066,0 0 100px 40px #ff440033}
  50%{transform:scale(1.08);box-shadow:0 0 30px 12px #ffcc44cc,0 0 70px 30px #ff8800aa,0 0 140px 55px #ff440055}
}
/* Particle aura */
#orb-aura{
  position:absolute;width:100px;height:100px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,170,0,.12) 0%,transparent 70%);
  animation:auraBreath 3s ease-in-out infinite;z-index:9
}
@keyframes auraBreath{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.3);opacity:1}}

/* Orbital rings */
.ring{
  position:absolute;border-radius:50%;border:2px solid;
  top:50%;left:50%;transform-origin:center center;
}
.ring-1{
  width:150px;height:150px;margin:-75px 0 0 -75px;
  border-color:rgba(255,165,0,.55);box-shadow:0 0 10px rgba(255,140,0,.3);
  animation:orbit1 5s linear infinite
}
.ring-2{
  width:190px;height:190px;margin:-95px 0 0 -95px;
  border-color:rgba(255,120,0,.4);box-shadow:0 0 8px rgba(255,100,0,.2);
  animation:orbit2 8s linear infinite
}
.ring-3{
  width:230px;height:230px;margin:-115px 0 0 -115px;
  border-color:rgba(255,80,0,.3);box-shadow:0 0 6px rgba(255,60,0,.15);
  animation:orbit3 12s linear infinite
}
@keyframes orbit1{from{transform:rotateX(72deg) rotateZ(0deg)}to{transform:rotateX(72deg) rotateZ(360deg)}}
@keyframes orbit2{from{transform:rotateX(20deg) rotateY(45deg) rotateZ(0deg)}to{transform:rotateX(20deg) rotateY(45deg) rotateZ(360deg)}}
@keyframes orbit3{from{transform:rotateX(55deg) rotateY(-30deg) rotateZ(0deg)}to{transform:rotateX(55deg) rotateY(-30deg) rotateZ(360deg)}}

/* Orbital dots */
.dot{position:absolute;width:6px;height:6px;border-radius:50%;margin:-3px 0 0 -3px;top:50%;left:50%}
.dot-1{background:#ffdd00;box-shadow:0 0 10px #ffdd00;animation:dotOrbit1 5s linear infinite}
.dot-2{background:#ff8800;box-shadow:0 0 8px #ff8800;animation:dotOrbit2 8s linear infinite}
.dot-3{background:#ff4400;box-shadow:0 0 6px #ff4400;animation:dotOrbit3 12s linear infinite}
@keyframes dotOrbit1{from{transform:rotateX(72deg) rotateZ(0deg) translateX(75px) rotateX(-72deg) rotateZ(0deg)}to{transform:rotateX(72deg) rotateZ(360deg) translateX(75px) rotateX(-72deg) rotateZ(-360deg)}}
@keyframes dotOrbit2{from{transform:rotateX(20deg) rotateY(45deg) rotateZ(0deg) translateX(95px) rotateY(-45deg) rotateX(-20deg)}to{transform:rotateX(20deg) rotateY(45deg) rotateZ(360deg) translateX(95px) rotateY(-45deg) rotateX(-20deg)}}
@keyframes dotOrbit3{from{transform:rotateX(55deg) rotateY(-30deg) rotateZ(0deg) translateX(115px) rotateY(30deg) rotateX(-55deg)}to{transform:rotateX(55deg) rotateY(-30deg) rotateZ(360deg) translateX(115px) rotateY(30deg) rotateX(-55deg)}}

/* Orb label area */
#orb-label{text-align:center;margin-top:2px}
.orb-title{font-size:.7rem;font-weight:900;letter-spacing:.3em;color:var(--gold);text-shadow:var(--glow-gold)}
.orb-sub{font-size:.5rem;letter-spacing:.2em;color:rgba(255,140,0,.5);margin-top:2px}

/* Mini stat strip below orb */
#orb-stats{
  display:flex;gap:16px;justify-content:center;margin-top:4px;
  font-family:var(--font-mono);font-size:.6rem
}
.os-item{text-align:center}
.os-val{color:var(--gold3);font-size:.75rem;display:block}
.os-key{color:rgba(255,140,0,.4);font-size:.5rem;letter-spacing:.1em}

/* Feed beneath orb */
#panel-feed{flex:1;min-height:0}
#feed-log{
  flex:1;overflow-y:auto;font-family:var(--font-mono);font-size:.7rem;
  line-height:1.55;min-height:0;max-height:100%;
  scrollbar-width:thin;scrollbar-color:rgba(255,140,0,.2) transparent
}
#feed-log::-webkit-scrollbar{width:3px}
#feed-log::-webkit-scrollbar-thumb{background:rgba(255,140,0,.2);border-radius:2px}
.feed-line{padding:2px 0;border-bottom:1px solid rgba(255,140,0,.05);animation:fadeIn .3s ease}
.feed-line.cmd{color:var(--gold)}
.feed-line.log{color:rgba(255,220,120,.8)}
.feed-line.err{color:var(--red)}
.feed-line.sys{color:rgba(255,140,0,.35)}
.feed-line .feed-ts{color:rgba(255,140,0,.25);margin-right:8px;font-size:.6rem}
@keyframes fadeIn{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:none}}

/* Opp panel */
#panel-opp{max-height:170px}
.opp-item{font-size:.67rem;padding:4px 0;border-bottom:1px solid rgba(255,140,0,.08);line-height:1.4}
.opp-item:last-child{border:none}
.opp-score{color:var(--gold);font-weight:700;float:right;font-family:var(--font-mono)}
.opp-branch{font-size:.55rem;color:rgba(255,100,0,.7);margin-bottom:2px;letter-spacing:.08em}
.opp-text{color:rgba(255,220,160,.7)}

/* Teams */
.team-item{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,140,0,.08);font-size:.68rem}
.team-item:last-child{border:none}
.team-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,140,0,.2);flex-shrink:0}
.team-dot.active{background:var(--green);box-shadow:0 0 8px var(--green)}
.team-name{color:var(--gold3)}
.team-model{font-size:.55rem;color:rgba(255,140,0,.35);margin-left:auto;font-family:var(--font-mono)}

/* Memory */
#panel-memory{flex:1;min-height:0}
#memory-scroll{flex:1;overflow-y:auto;font-family:var(--font-mono);font-size:.65rem;line-height:1.5;min-height:0;scrollbar-width:thin;scrollbar-color:rgba(255,140,0,.15) transparent}
.mem-line{padding:2px 0;border-bottom:1px solid rgba(255,140,0,.06)}
.mem-branch{color:rgba(255,100,0,.6);font-size:.55rem;letter-spacing:.08em}
.mem-text{color:rgba(255,200,120,.55)}

/* ── BOTTOM BAR ── */
#bottombar{
  position:relative;z-index:10;
  padding:7px 24px;
  background:linear-gradient(0deg,rgba(255,140,0,.04) 0%,transparent 100%);
  border-top:1px solid rgba(255,140,0,.18);
  display:flex;align-items:center;gap:14px;
  font-size:.55rem;letter-spacing:.12em;color:rgba(255,140,0,.35)
}
.sep{color:rgba(255,140,0,.2)}
.uptime-val{color:var(--green);font-family:var(--font-mono)}
.version-val{color:rgba(255,140,0,.6)}

/* ── SCANLINES ── */
body::after{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:999;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.025) 2px,rgba(0,0,0,.025) 4px);
}
/* Vignette */
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;z-index:1;
  background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.7) 100%);
}
</style>
</head>
<body>

<!-- STARS -->
<div id="stars"></div>

<!-- TOP BAR -->
<div id="topbar">
  <div>
    <div class="logo">⬡ AIKON-OS COMMANDER</div>
    <div class="subtitle">JARVIS HUD v3.2 · REAL-TIME SYSTEM MONITOR</div>
  </div>
  <div>
    <div class="clock" id="clock">--:--:--</div>
    <div class="date-line" id="date">...</div>
  </div>
  <div style="text-align:right">
    <div id="conn-status" class="connecting">◉ CONNECTING</div>
  </div>
</div>

<!-- MAIN -->
<div id="main">

  <!-- LEFT: STATUS + TRADER -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow:hidden">
    <div class="panel" id="panel-status">
      <div class="panel-title">◈ SYSTEM STATUS</div>
      <div class="stat-row"><span class="stat-label">VERSION</span><span class="stat-val" id="sv-version">--</span></div>
      <div class="stat-row"><span class="stat-label">UPTIME</span><span class="stat-val" id="sv-uptime">--</span></div>
      <div class="stat-row"><span class="stat-label">DEEPSEEK R1</span><span class="stat-val" id="sv-ds">--</span></div>
      <div class="stat-row"><span class="stat-label">TTS VOICE</span><span class="stat-val" id="sv-tts">--</span></div>
      <div class="stat-row"><span class="stat-label">WAKE WORD</span><span class="stat-val" id="sv-wake">--</span></div>
      <div class="stat-row"><span class="stat-label">BRAIN LINK</span><span class="stat-val" id="sv-brain">--</span></div>
      <div class="stat-row"><span class="stat-label">HUD CLIENTS</span><span class="stat-val" id="sv-clients">--</span></div>
    </div>
    <div class="panel amber" id="panel-trader" style="flex:1">
      <div class="panel-title">◈ XAU/USD TRADER</div>
      <div class="trader-price" id="t-price">$-.--</div>
      <div class="trader-row"><span>STATUS</span><span id="t-status">--</span></div>
      <div class="trader-row"><span>BALANCE</span><span id="t-balance">--</span></div>
      <div class="trader-row"><span>WIN RATE</span><span id="t-winrate">--</span></div>
      <div class="trader-row"><span>OPEN TRADES</span><span id="t-open">--</span></div>
      <div class="trader-row"><span>CONSEC LOSSES</span><span id="t-losses">--</span></div>
      <div class="trader-row"><span>LAST UPDATE</span><span id="t-ts">--</span></div>
    </div>
  </div>

  <!-- CENTER: ORB + FEED + OPPORTUNITIES -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow:hidden;min-height:0">
    <!-- ORB PANEL -->
    <div class="panel" id="orb-wrap" style="align-items:center;padding-top:16px;padding-bottom:12px">
      <div id="orb-scene">
        <div id="orb-aura"></div>
        <div id="orb-core"></div>
        <div class="ring ring-1"></div>
        <div class="ring ring-2"></div>
        <div class="ring ring-3"></div>
        <div class="dot dot-1"></div>
        <div class="dot dot-2"></div>
        <div class="dot dot-3"></div>
      </div>
      <div id="orb-label">
        <div class="orb-title">AIKON-OS</div>
        <div class="orb-sub">COMMANDER ACTIVE</div>
      </div>
      <div id="orb-stats">
        <div class="os-item"><span class="os-val" id="os-uptime">--</span><span class="os-key">UPTIME</span></div>
        <div class="os-item"><span class="os-val" id="os-cycles">--</span><span class="os-key">CYCLES</span></div>
        <div class="os-item"><span class="os-val" id="os-memories">--</span><span class="os-key">MEMORIES</span></div>
        <div class="os-item"><span class="os-val" id="os-version">--</span><span class="os-key">BUILD</span></div>
      </div>
    </div>
    <!-- LIVE FEED -->
    <div class="panel" id="panel-feed" style="flex:1;min-height:0">
      <div class="panel-title">◈ LIVE COMMANDER FEED</div>
      <div id="feed-log"></div>
    </div>
    <!-- OPPORTUNITIES -->
    <div class="panel green" id="panel-opp">
      <div class="panel-title">◈ TOP OPPORTUNITIES</div>
      <div id="opp-list"><div style="color:rgba(255,140,0,.35);font-size:.67rem">Loading...</div></div>
    </div>
  </div>

  <!-- RIGHT: TEAMS + MEMORY -->
  <div style="display:flex;flex-direction:column;gap:10px;overflow:hidden">
    <div class="panel amber" id="panel-teams">
      <div class="panel-title">◈ ACTIVE TEAMS</div>
      <div class="team-item"><span class="team-dot active"></span><span class="team-name">TRADER</span><span class="team-model">deepseek-r1</span></div>
      <div class="team-item"><span class="team-dot active"></span><span class="team-name">RESEARCH</span><span class="team-model">phi3:mini</span></div>
      <div class="team-item"><span class="team-dot active"></span><span class="team-name">BIZ</span><span class="team-model">phi3:mini</span></div>
      <div class="team-item"><span class="team-dot"></span><span class="team-name">ROBLOX</span><span class="team-model">phi3:mini</span></div>
    </div>
    <div class="panel" id="panel-memory" style="flex:1;min-height:0">
      <div class="panel-title">◈ BRAIN MEMORY FEED</div>
      <div id="memory-scroll"></div>
    </div>
  </div>

</div>

<!-- BOTTOM BAR -->
<div id="bottombar">
  <span>AIKON-OS COMMANDER HUD</span>
  <span class="sep">|</span>
  <span>UPTIME <span class="uptime-val" id="b-uptime">--</span></span>
  <span class="sep">|</span>
  <span>BRAIN CYCLES <span class="uptime-val" id="b-cycles">--</span></span>
  <span class="sep">|</span>
  <span>MEMORIES <span class="uptime-val" id="b-memories">--</span></span>
  <span class="sep">|</span>
  <span class="version-val" id="b-version">v--</span>
  <span style="margin-left:auto;color:rgba(255,140,0,.2)">AL iKON UNLIMITED LLC</span>
</div>

<script>
// ── CONFIG ──
const BRAIN_URL  = location.origin;
const BRIDGE_KEY = '';
const BRAIN_WS   = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

// ── STARS ──
(function(){
  const c = document.getElementById('stars');
  for (let i = 0; i < 180; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const sz = Math.random() * 2 + .5;
    s.style.cssText = \`width:\${sz}px;height:\${sz}px;top:\${Math.random()*100}%;left:\${Math.random()*100}%;--d:\${(Math.random()*4+2).toFixed(1)}s;--op:\${(Math.random()*.7+.1).toFixed(2)};animation-delay:\${(Math.random()*5).toFixed(1)}s\`;
    c.appendChild(s);
  }
})();

// ── CLOCK ──
function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toTimeString().slice(0,8);
  document.getElementById('date').textContent  = now.toDateString().toUpperCase();
}
setInterval(tickClock, 1000);
tickClock();

// ── FEED ──
const feedLog = document.getElementById('feed-log');
const MAX_FEED = 150;
function addFeed(cls, text) {
  if (!text) return;
  const ts = new Date().toTimeString().slice(0,8);
  const line = document.createElement('div');
  line.className = \`feed-line \${cls}\`;
  line.innerHTML = \`<span class="feed-ts">\${ts}</span>\${escapeHtml(text)}\`;
  feedLog.appendChild(line);
  while (feedLog.children.length > MAX_FEED) feedLog.removeChild(feedLog.firstChild);
  feedLog.scrollTop = feedLog.scrollHeight;
}
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── WEBSOCKET ──
let ws = null, wsRetry = 0, wsRetryMax = 20;
const connEl = document.getElementById('conn-status');

function connectWS() {
  if (ws && ws.readyState < 2) return;
  connEl.className = 'connecting';
  connEl.textContent = '◉ CONNECTING';
  addFeed('sys', 'Connecting via Brain relay…');
  try { ws = new WebSocket(BRAIN_WS); }
  catch(e) { scheduleReconnect('WebSocket not supported'); return; }
  ws.onopen = () => {
    wsRetry = 0;
    connEl.className = 'connected';
    connEl.textContent = '◉ LIVE';
    addFeed('sys', 'Commander feed connected ✓');
  };
  ws.onmessage = (ev) => { try { handleWsMsg(JSON.parse(ev.data)); } catch(e) {} };
  ws.onclose   = () => { connEl.className='disconnected'; connEl.textContent='◉ OFFLINE'; scheduleReconnect('Connection lost'); };
  ws.onerror   = () => {};
}

function scheduleReconnect(reason) {
  wsRetry++;
  if (wsRetry > wsRetryMax) { addFeed('sys', 'Max reconnect attempts — Commander offline'); return; }
  const delay = Math.min(3000 * wsRetry, 30000);
  addFeed('sys', \`\${reason} — retry #\${wsRetry} in \${(delay/1000).toFixed(0)}s\`);
  setTimeout(connectWS, delay);
}

function handleWsMsg(d) {
  if (d.t === 'log')    { addFeed('log', d.msg); return; }
  if (d.t === 'cmd')    { addFeed('cmd', '▶ ' + d.input); return; }
  if (d.t === 'err')    { addFeed('err', '✖ ' + d.msg); return; }
  if (d.t === 'sys')    { addFeed('sys', d.msg); return; }
  if (d.t === 'offline'){ addFeed('err', '⚠ Thomas offline — HUD in standby'); return; }
  if (d.t === 'buffer') { (d.items||[]).forEach(item => handleWsMsg(item)); return; }
  if (d.t === 'hello' || d.t === 'stats') { setStatus(d); if(d.t==='hello') addFeed('sys',\`Commander v\${d.version} handshake ✓\`); return; }
}

function setStatus(d) {
  const set = (id, val, okTest) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (okTest != null) el.className = 'stat-val ' + (okTest ? 'ok' : 'off');
  };
  if (d.version) {
    set('sv-version', 'v'+d.version);
    document.getElementById('b-version').textContent = 'v'+d.version;
    document.getElementById('os-version').textContent = 'v'+d.version;
  }
  if (d.uptime != null) {
    const u = formatUptime(d.uptime);
    set('sv-uptime', u);
    document.getElementById('b-uptime').textContent = u;
    document.getElementById('os-uptime').textContent = u;
  }
  if (d.deepseek != null) set('sv-ds',    d.deepseek ? 'READY'  : 'OFFLINE', d.deepseek);
  if (d.tts      != null) set('sv-tts',   d.tts     ? 'ACTIVE' : 'OFFLINE', d.tts);
  if (d.wake     != null) set('sv-wake',  d.wake    ? 'ACTIVE' : 'OFFLINE', d.wake);
  if (d.brain    != null) set('sv-brain', d.brain   ? 'LINKED' : 'OFFLINE', d.brain);
  if (d.clients  != null) set('sv-clients', d.clients);
}

function formatUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return [h,m,sec].map(n=>String(n).padStart(2,'0')).join(':');
}

// ── TRADER ──
async function loadTrader() {
  try {
    const r = await fetch('https://xauusd-trader-80p0.onrender.com/api/state');
    const d = await r.json();
    document.getElementById('t-price').textContent   = '$' + (d.currentPrice||0).toFixed(2);
    document.getElementById('t-status').textContent  = d.status || '--';
    document.getElementById('t-balance').textContent = '$' + (d.balance||0).toFixed(2);
    document.getElementById('t-winrate').textContent = (d.winRate||0).toFixed(1) + '%';
    document.getElementById('t-open').textContent    = d.openTrades || 0;
    document.getElementById('t-losses').textContent  = d.consecutiveLosses || 0;
    document.getElementById('t-ts').textContent      = new Date().toTimeString().slice(0,8);
  } catch(e) { document.getElementById('t-price').textContent = 'OFFLINE'; }
}

// ── BRAIN DATA ──
async function loadBrainData() {
  try {
    const headers = BRIDGE_KEY ? {'x-bridge-key': BRIDGE_KEY} : {};
    const r = await fetch(\`\${BRAIN_URL}/status\`, {headers});
    const d = await r.json();
    const cycles = d.cycle_count || '--';
    const mems   = d.total_memories || '--';
    document.getElementById('b-cycles').textContent   = cycles;
    document.getElementById('b-memories').textContent = mems;
    document.getElementById('os-cycles').textContent  = cycles;
    document.getElementById('os-memories').textContent = mems;
  } catch(e) {}
}

async function loadOpportunities() {
  try {
    const headers = BRIDGE_KEY ? {'x-bridge-key': BRIDGE_KEY} : {};
    const r = await fetch(\`\${BRAIN_URL}/opportunities\`, {headers});
    const d = await r.json();
    const list = document.getElementById('opp-list');
    if (!d.items?.length) { list.innerHTML = '<div style="color:rgba(255,140,0,.3);font-size:.67rem">No opportunities scored yet.</div>'; return; }
    list.innerHTML = d.items.slice(0,4).map(o=>\`
<div class="opp-item">
  <span class="opp-score">\${(o.score||0).toFixed(1)}</span>
  <div class="opp-branch">\${(o.branch||'').toUpperCase()}</div>
  <div class="opp-text">\${escapeHtml((o.content||'').substring(0,120))}</div>
</div>\`).join('');
  } catch(e) {}
}

async function loadMemoryFeed() {
  try {
    const r = await fetch(\`\${BRAIN_URL}/memory?limit=20\`);
    const d = await r.json();
    const scroll = document.getElementById('memory-scroll');
    const items  = d.items || d.memories || [];
    if (!items.length) { scroll.innerHTML = '<div style="color:rgba(255,140,0,.3);font-size:.67rem">No memories yet.</div>'; return; }
    scroll.innerHTML = items.map(m=>\`<div class="mem-line">
      <div class="mem-branch">\${(m.branch||'').toUpperCase()} · \${m.type||m.memory_type||''}</div>
      <div class="mem-text">\${escapeHtml((m.content||m.insight||'').substring(0,120))}</div>
    </div>\`).join('');
  } catch(e) {}
}

// ── INIT ──
connectWS();
loadTrader();
loadBrainData();
loadOpportunities();
loadMemoryFeed();
setInterval(loadTrader,        60000);
setInterval(loadBrainData,     30000);
setInterval(loadOpportunities, 60000);
setInterval(loadMemoryFeed,    45000);
</script>
</body>
</html>`;

// ─── PHONE VOICE PWA ─────────────────────────────────────────────────────────
const PHONE_PWA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#050510">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Commander">
<link rel="manifest" href="/app.webmanifest">
<title>Commander Voice</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Share+Tech+Mono&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#050510;--card:#0a0a1e;--border:#1a1a4e;
  --purple:#9333ea;--cyan:#22d3ee;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;
  --text:#e2e8f0;--muted:#64748b;
  --safe-top:env(safe-area-inset-top,0px);
  --safe-bot:env(safe-area-inset-bottom,0px);
  --font:'Orbitron',sans-serif;--mono:'Share Tech Mono',monospace;
}
html,body{width:100%;height:100%;background:var(--bg);color:var(--text);font-family:var(--font);overflow:hidden}
body{display:flex;flex-direction:column;height:100%;padding-top:var(--safe-top);padding-bottom:var(--safe-bot)}

/* ── HEADER ── */
header{padding:14px 20px 10px;text-align:center;background:linear-gradient(180deg,rgba(147,51,234,.15),transparent)}
header h1{font-size:1rem;font-weight:700;letter-spacing:.15em;color:var(--purple)}
#online-pill{display:inline-flex;align-items:center;gap:5px;font-size:.6rem;letter-spacing:.1em;padding:3px 10px;border-radius:12px;border:1px solid;margin-top:4px;transition:.3s}
#online-pill.online{color:var(--green);border-color:var(--green)}
#online-pill.offline{color:var(--red);border-color:var(--red)}
#online-pill.checking{color:var(--yellow);border-color:var(--yellow)}
.pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor}

/* ── CONVERSATION ── */
#convo{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px;min-height:0}
.bubble{max-width:85%;padding:10px 14px;border-radius:14px;font-family:var(--mono);font-size:.82rem;line-height:1.5;word-break:break-word;animation:popIn .2s ease}
.bubble.you{background:linear-gradient(135deg,#2d1b69,#1e1b4b);border:1px solid var(--purple);align-self:flex-end;border-bottom-right-radius:4px}
.bubble.cmd{background:linear-gradient(135deg,#0a2a2a,#071e1e);border:1px solid var(--cyan);align-self:flex-start;border-bottom-left-radius:4px;color:var(--cyan)}
.bubble.sys{align-self:center;font-size:.7rem;color:var(--muted);background:transparent;padding:4px 0}
.bubble.err{background:#2a0a0a;border:1px solid var(--red);align-self:flex-start;color:var(--red);border-bottom-left-radius:4px}
@keyframes popIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:none}}

/* ── MIC BUTTON ── */
#mic-area{padding:16px;display:flex;flex-direction:column;align-items:center;gap:10px}
#mic-btn{
  width:88px;height:88px;border-radius:50%;border:none;cursor:pointer;
  background:radial-gradient(circle,#9333ea,#5b21b6);
  box-shadow:0 0 0 0 rgba(147,51,234,.5);
  transition:.2s;position:relative;
  display:flex;align-items:center;justify-content:center;
}
#mic-btn svg{width:38px;height:38px;fill:#fff}
#mic-btn.listening{
  background:radial-gradient(circle,#ef4444,#b91c1c);
  animation:ripple 1.2s ease-out infinite;
}
@keyframes ripple{
  0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}
  70%{box-shadow:0 0 0 24px rgba(239,68,68,0)}
  100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}
}
#mic-hint{font-size:.65rem;letter-spacing:.1em;color:var(--muted);text-align:center}

/* ── BOTTOM CONTROLS ── */
#controls{display:flex;gap:8px;padding:0 16px 12px}
#text-in{flex:1;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 14px;color:var(--text);font-family:var(--mono);font-size:.82rem;outline:none}
#text-in:focus{border-color:var(--purple)}
#send-btn{background:var(--purple);border:none;border-radius:12px;padding:10px 18px;color:#fff;font-family:var(--font);font-size:.75rem;cursor:pointer;white-space:nowrap}

/* ── WAKE BTN ── */
#wake-btn{width:calc(100% - 32px);margin:0 16px 10px;background:transparent;border:1px solid var(--border);border-radius:10px;padding:10px;color:var(--muted);font-family:var(--font);font-size:.7rem;letter-spacing:.1em;cursor:pointer;transition:.2s}
#wake-btn:hover{border-color:var(--purple);color:var(--purple)}

/* ── TTS SPEAKING INDICATOR ── */
#speaking-bar{display:none;padding:4px 16px;text-align:center;font-size:.65rem;color:var(--cyan);letter-spacing:.15em;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
</style>
</head>
<body>

<header>
  <h1>⚡ COMMANDER</h1>
  <div id="online-pill" class="checking"><span class="pill-dot"></span><span id="pill-text">CHECKING THOMAS…</span></div>
</header>

<div id="convo">
  <div class="bubble sys">Commander Voice v3.2 — Ready</div>
  <div class="bubble sys">Tap the mic to speak, or type below</div>
</div>

<div id="speaking-bar" id="speaking-bar">🔊 SPEAKING…</div>

<div id="mic-area">
  <button id="mic-btn" onclick="toggleMic()">
    <svg viewBox="0 0 24 24"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm7 11a1 1 0 0 1 2 0 9 9 0 0 1-8 8.94V23h-2v-2.06A9 9 0 0 1 3 12a1 1 0 0 1 2 0 7 7 0 0 0 14 0z"/></svg>
  </button>
  <div id="mic-hint">TAP TO SPEAK</div>
</div>

<div id="controls">
  <input id="text-in" type="text" placeholder="Type a command…" autocomplete="off" autocorrect="off">
  <button id="send-btn" onclick="sendText()">SEND</button>
</div>
<button id="wake-btn" onclick="wakeThomas()">⚡ WAKE THOMAS</button>

<script>
// ── CONFIG ──
const BRIDGE_URL = location.origin;      // Brain acts as Bridge
const THOMAS_IP  = '100.91.204.20';
const BRIDGE_KEY = '';                   // Set if BRIDGE_KEY is configured

// ── STATE ──
let isListening = false, thomasOnline = false, speechRecog = null, isSpeaking = false;
const convo = document.getElementById('convo');

// ── HELPERS ──
function addBubble(cls, text) {
  const b = document.createElement('div');
  b.className = 'bubble ' + cls;
  b.textContent = text;
  convo.appendChild(b);
  convo.scrollTop = convo.scrollHeight;
  return b;
}

// ── THOMAS STATUS ──
async function checkThomas() {
  const pill = document.getElementById('online-pill');
  const txt  = document.getElementById('pill-text');
  try {
    const r = await fetch('/ping-thomas');
    const d = await r.json();
    thomasOnline = d.online;
    if (d.online) {
      pill.className = 'online';
      txt.textContent = 'THOMAS ONLINE';
    } else {
      pill.className = 'offline';
      txt.textContent = 'THOMAS OFFLINE';
    }
  } catch(e) {
    pill.className = 'offline';
    txt.textContent = 'BRAIN UNREACHABLE';
    thomasOnline = false;
  }
}
setInterval(checkThomas, 60000);
checkThomas();

// ── SEND MESSAGE TO COMMANDER ──
async function sendToCommander(text) {
  if (!text.trim()) return;
  addBubble('you', text);
  const loadBubble = addBubble('sys', '◈ processing…');
  try {
    let responseText = '';
    if (thomasOnline) {
      // Send direct to Commander via Bridge /message endpoint
      const headers = { 'Content-Type': 'application/json' };
      if (BRIDGE_KEY) headers['x-bridge-key'] = BRIDGE_KEY;
      const r = await fetch('/message', {
        method: 'POST', headers,
        body: JSON.stringify({ message: text, source: 'phone_voice' })
      });
      const d = await r.json();
      responseText = d.response || d.reply || d.answer || d.message || JSON.stringify(d);
    } else {
      // Offline fallback: query Brain memory
      const r = await fetch('/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text })
      });
      const d = await r.json();
      responseText = '[OFFLINE MODE — Brain reply]\n' + (d.answer || d.error || 'No response');
    }
    loadBubble.remove();
    addBubble('cmd', responseText);
    speak(responseText);
  } catch(e) {
    loadBubble.remove();
    addBubble('err', 'Error: ' + e.message);
  }
}

// ── TEXT-TO-SPEECH ──
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  // Strip markdown and truncate for speech
  const clean = text.replace(/[*_#\`]/g,'').replace(/\[.*?\]/g,'').substring(0, 300);
  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = 1.05; utt.pitch = 0.95; utt.volume = 1;
  // Prefer a clear English voice
  const voices = window.speechSynthesis.getVoices();
  const pref = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Microsoft')));
  if (pref) utt.voice = pref;
  const bar = document.getElementById('speaking-bar');
  utt.onstart  = () => { isSpeaking = true;  bar.style.display = 'block'; };
  utt.onend    = () => { isSpeaking = false; bar.style.display = 'none'; };
  utt.onerror  = () => { isSpeaking = false; bar.style.display = 'none'; };
  window.speechSynthesis.speak(utt);
}

// ── SPEECH RECOGNITION ──
function setupSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { addBubble('err', 'Speech recognition not supported on this browser/device.'); return null; }
  const r = new SR();
  r.lang = 'en-US'; r.continuous = false; r.interimResults = false; r.maxAlternatives = 1;
  r.onresult = (e) => {
    const t = e.results[0][0].transcript;
    stopListening();
    sendToCommander(t);
  };
  r.onerror = (e) => { stopListening(); addBubble('err', 'Mic error: ' + e.error); };
  r.onend   = () => { if (isListening) stopListening(); };
  return r;
}

function toggleMic() {
  if (window.speechSynthesis?.speaking) { window.speechSynthesis.cancel(); return; }
  if (isListening) { stopListening(); return; }
  startListening();
}

function startListening() {
  if (!speechRecog) speechRecog = setupSpeech();
  if (!speechRecog) return;
  try { speechRecog.start(); } catch(e) { speechRecog = setupSpeech(); if(speechRecog) speechRecog.start(); return; }
  isListening = true;
  document.getElementById('mic-btn').classList.add('listening');
  document.getElementById('mic-hint').textContent = 'LISTENING…';
}

function stopListening() {
  if (speechRecog) try { speechRecog.stop(); } catch(e) {}
  isListening = false;
  document.getElementById('mic-btn').classList.remove('listening');
  document.getElementById('mic-hint').textContent = 'TAP TO SPEAK';
}

// ── TEXT INPUT ──
function sendText() {
  const inp = document.getElementById('text-in');
  const t = inp.value.trim();
  if (!t) return;
  inp.value = '';
  sendToCommander(t);
}
document.getElementById('text-in').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });

// ── WAKE THOMAS ──
async function wakeThomas() {
  const btn = document.getElementById('wake-btn');
  btn.textContent = '⚡ SENDING MAGIC PACKET…';
  btn.disabled = true;
  try {
    const headers = BRIDGE_KEY ? { 'x-bridge-key': BRIDGE_KEY, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    const r = await fetch('/wake', { method: 'POST', headers, body: '{}' });
    const d = await r.json();
    addBubble('sys', d.ok ? '⚡ Magic packet sent — Thomas booting in ~30s' : '✖ Wake failed: ' + (d.error||'unknown'));
    setTimeout(() => { checkThomas(); btn.textContent = '⚡ WAKE THOMAS'; btn.disabled = false; }, 30000);
  } catch(e) {
    addBubble('err', 'Wake error: ' + e.message);
    btn.textContent = '⚡ WAKE THOMAS'; btn.disabled = false;
  }
}

// ── LOAD VOICES (async on some browsers) ──
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices(); // prime
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}
</script>
</body>
</html>`;

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function main() {
  log(`AIKON-OS Commander Brain v${VERSION} starting...`);

  try {
    await initDB();
    log(`DB: connected and ready`);
  } catch(e) {
    log(`DB_FATAL: ${e.message}`);
    process.exit(1);
  }

  const server = require('http').createServer(app);

  // ─── REVERSE RELAY ARCHITECTURE (v1.1) ───────────────────────────────────────
  // Thomas dials OUT to Brain /relay on startup — no Tailscale inbound needed.
  // Brain holds that socket as the live Commander feed.
  // HUD browsers connect to /ws and receive the feed from Brain's buffer + relay.
  if (WS) {
    const { WebSocketServer } = WS;

    // Persistent Commander relay socket (Thomas → Brain)
    let commanderRelayWs = null;
    let commanderConnected = false;

    // /relay — Commander connects here on startup
    // handleProtocols strips Sec-WebSocket-Extensions so Railway nginx proxy compression is rejected
    const relayWss = new WebSocketServer({
      server,
      path: '/relay',
      perMessageDeflate: false,
      handleProtocols: (protocols, req) => {
        // Strip any compression extension the proxy may have injected
        delete req.headers['sec-websocket-extensions'];
        return false; // no subprotocol
      }
    });
    relayWss.on('connection', (ws, req) => {
      // Auth check
      const key = req.headers['x-bridge-key'] || new URL('http://x' + req.url).searchParams.get('key');
      if (process.env.BRIDGE_KEY && key !== process.env.BRIDGE_KEY) {
        ws.close(4401, 'unauthorized');
        log('RELAY: rejected unauthorized connection');
        return;
      }

      // Replace any old relay socket — null it out FIRST so its close event doesn't clear the new one
      if (commanderRelayWs && commanderRelayWs !== ws) {
        const old = commanderRelayWs;
        commanderRelayWs = null;
        if (old._keepAlive) clearInterval(old._keepAlive);
        try { if (old.readyState < 2) old.close(); } catch(e) {}
      }
      commanderRelayWs = ws;
      commanderConnected = true;
      log('RELAY: Commander connected from Thomas ✓');

      // Brain-side keep-alive: ping Commander every 8s to prevent Render proxy idle timeout
      ws._keepAlive = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.ping(); } catch(e) {}
        } else {
          clearInterval(ws._keepAlive);
        }
      }, 8000);

      // Notify all HUD browsers
      hudWss.clients.forEach(browser => {
        if (browser.readyState === 1)
          browser.send(JSON.stringify({ t: 'sys', msg: 'Commander connected via Brain relay ✓' }));
      });

      ws.on('message', (data) => {
        try {
          const msg = data.toString();
          const parsed = JSON.parse(msg);
          // Ignore keep-alive pings — don't buffer or forward them
          if (parsed.t === 'ping') return;
          bufferFeed(parsed);
          // Forward to all HUD browsers
          hudWss.clients.forEach(browser => {
            if (browser.readyState === 1) browser.send(msg);
          });
        } catch(e) {}
      });

      ws.on('close', () => {
        if (ws._keepAlive) clearInterval(ws._keepAlive);
        // Only clear if this is still the active relay socket (not already replaced)
        if (commanderRelayWs === ws) {
          commanderConnected = false;
          commanderRelayWs = null;
        }
        log('RELAY: Commander disconnected');
        hudWss.clients.forEach(browser => {
          if (browser.readyState === 1)
            browser.send(JSON.stringify({ t: 'offline', msg: 'Thomas offline — HUD in standby' }));
        });
      });

      ws.on('error', () => {});
    });

    // /ws — HUD browsers connect here
    const hudWss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });
    hudWss.on('connection', (browserWs) => {
      log(`HUD: browser connected (${hudWss.clients.size} total)`);

      // Replay buffer so HUD isn't blank on fresh connect
      if (feedBuffer.length) {
        browserWs.send(JSON.stringify({ t: 'buffer', items: feedBuffer }));
      }

      if (commanderConnected) {
        browserWs.send(JSON.stringify({ t: 'sys', msg: 'Commander connected via Brain relay ✓' }));
      } else {
        browserWs.send(JSON.stringify({ t: 'offline', msg: 'Thomas offline — HUD in standby' }));
      }

      // Forward browser commands to Commander relay
      browserWs.on('message', (data) => {
        if (commanderRelayWs && commanderRelayWs.readyState === 1) {
          try { commanderRelayWs.send(data.toString()); } catch(e) {}
        }
      });

      browserWs.on('close', () => log('HUD: browser disconnected'));
      browserWs.on('error', () => {});
    });

    log('HUD: reverse relay ready — /relay (Commander) + /ws (browsers)');
  }

  server.listen(PORT, () => log(`HTTP: listening on port ${PORT}`));

  // First cycle after 5s, then every 5 minutes
  setTimeout(learnCycle, 5000);
  setInterval(learnCycle, 5 * 60 * 1000);

  log(`BRAIN: 24/7 learning active — ${5} min cycle`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });

// Graceful shutdown — Railway sends SIGTERM before killing container
process.on('SIGTERM', () => {
  log('BRAIN: SIGTERM received — shutting down gracefully');
  process.exit(0);
});
