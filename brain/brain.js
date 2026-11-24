#!/usr/bin/env node
// AIKON-OS Commander Brain v1.0
// 24/7 learning worker — runs on Render, independent of Thomas
// Learns for ALL business branches, current and future
// Commander on Thomas syncs on startup and picks up everything missed

const https   = require('https');
const http    = require('http');
const { Pool } = require('pg');

const VERSION = '1.0';

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

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-bridge-key'] || req.query.key;
  if (process.env.BRIDGE_KEY && key !== process.env.BRIDGE_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

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

async function loadAll() {
  document.getElementById('last-refresh').textContent = 'Refreshed ' + new Date().toLocaleTimeString();
  await Promise.all([loadStatus(), loadOpportunities(), loadMemory(), loadBranches()]);
}

loadAll();
</script>
</body>
</html>`);
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

  app.listen(PORT, () => log(`HTTP: listening on port ${PORT}`));

  // First cycle after 5s, then every 5 minutes
  setTimeout(learnCycle, 5000);
  setInterval(learnCycle, 5 * 60 * 1000);

  log(`BRAIN: 24/7 learning active — ${5} min cycle`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
