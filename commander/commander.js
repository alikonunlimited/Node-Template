#!/usr/bin/env node
// AIKON-OS Commander v3.0 — Learning Edition
// Location: D:\AIKON-OS\commander\commander.js
// Start: node D:\AIKON-OS\commander\commander.js
// Update: /update  — pulls latest from GitHub and restarts

const readline  = require('readline');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const { execSync, spawn } = require('child_process');

// WebSocket — built-in ws module (ship ws in package.json, fallback to no-ws)
let WebSocketServer = null;
try { WebSocketServer = require('ws').Server; } catch(e) { /* ws not installed — HUD disabled */ }

// Live HUD broadcast — all connected WebSocket clients
const hudClients = new Set();
function hudBroadcast(type, payload) {
  if (!hudClients.size) return;
  const msg = JSON.stringify({ t: type, ts: Date.now(), ...payload });
  for (const ws of hudClients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch(e) { hudClients.delete(ws); }
  }
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  brainUrl:      process.env.BRAIN_URL || '',
  ollamaHost:    '127.0.0.1',
  ollamaPort:    11434,
  ollamaModel:   'phi3:mini',
  deepseekModel: 'deepseek-r1:7b',
  traderUrl:     'https://xauusd-trader-80p0.onrender.com/api/state',
  bridgeUrl:     process.env.BRIDGE_URL || '',
  bridgeKey:     process.env.BRIDGE_KEY || '',
  logFile:       path.join(__dirname, 'commander.log'),
  memoryFile:    path.join(__dirname, 'memory.json'),
  chromaFile:    path.join('D:\\AIKON-OS', 'chroma', 'memory.json'),
  modelsDir:     'D:\\AIKON-OS\\models',
  pollInterval:  30000,
  learnInterval: 300000,  // 5 min background learn cycle
  // Self-update
  updateRepo:    'alikonunlimited/Node-Template',
  updateFile:    'commander/commander.js',
  updateBranch:  'main',
  version:       '3.2',
  // Voice
  voiceRecorder: path.join(__dirname, 'voice_record.py'),
  voiceWav:      path.join(__dirname, 'voice_input.wav'),
  whisperModel:  'base',
  voiceEnabled:  true,
  whisperPaths:  [
    'C:\\Python314\\Scripts\\whisper.exe',
    'C:\\Python313\\Scripts\\whisper.exe',
    'C:\\Python312\\Scripts\\whisper.exe',
    'C:\\Python311\\Scripts\\whisper.exe',
    (process.env.USERPROFILE || '') + '\\AppData\\Roaming\\Python\\Python314\\Scripts\\whisper.exe',
    (process.env.USERPROFILE || '') + '\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\whisper.exe',
  ],
  // TTS / Wake word
  voiceSpeak:    path.join(__dirname, 'voice_speak.py'),
  wakeWord:      path.join(__dirname, 'wake_word.py'),
  ttsEnabled:    true,
  ttsRate:       175,
  wakeEnabled:   false,  // enable with /wake on after vosk model downloaded
  // Push notifications (ntfy.sh — free, no account needed)
  ntfyTopic:     process.env.NTFY_TOPIC || '',  // set to your unique topic e.g. aikon-commander-abc123
  // Teams
  teams: {
    trader:   { name: 'Trader Team',   model: 'deepseek-r1:7b', branch: 'trader',   active: true },
    biz:      { name: 'Biz Team',      model: 'deepseek-r1:7b', branch: 'opportunities', active: true },
    research: { name: 'Research Team', model: 'phi3:mini',       branch: 'opportunities', active: true },
    roblox:   { name: 'Roblox Team',   model: 'phi3:mini',       branch: 'roblox',   active: true },
  },
  // Approval queue — big decisions wait here
  pendingApprovals: [],
  deepseekReady: false,
};

// ─── BUSINESS BRANCHES ────────────────────────────────────────────────────────
const BRANCHES = {
  trader:       { name: 'XAU/USD Trader',       keywords: ['gold','xau','trade','price','signal','market','forex'] },
  roblox:       { name: 'Roblox Games',          keywords: ['roblox','game','silent santa','magic moments','castle kings','dead to dawn','lemonade','stick fights'] },
  agency:       { name: 'Restaurant Agency',     keywords: ['restaurant','web','agency','client','lead','demo','outreach'] },
  aikon_os:     { name: 'AIKON-OS',              keywords: ['commander','system','ollama','model','update','bridge','voice'] },
  opportunities:{ name: 'New Opportunities',     keywords: ['business','automate','passive','income','saas','app','tool','grant','opportunity','revenue'] },
};

function detectBranch(text) {
  const lower = text.toLowerCase();
  for (const [key, branch] of Object.entries(BRANCHES)) {
    if (branch.keywords.some(k => lower.includes(k))) return key;
  }
  return 'aikon_os';
}

// ─── CHROMA MEMORY (flat-file vector simulation — real ChromaDB via Python) ──
let chromaMemory = { collections: {} };

function loadChroma() {
  try {
    const dir = path.dirname(CONFIG.chromaFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(CONFIG.chromaFile))
      chromaMemory = JSON.parse(fs.readFileSync(CONFIG.chromaFile, 'utf8'));
  } catch(e) { chromaMemory = { collections: {} }; }
}

function saveChroma() {
  try {
    const dir = path.dirname(CONFIG.chromaFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.chromaFile, JSON.stringify(chromaMemory, null, 2));
  } catch(e) {}
}

function chromaAdd(collection, entry) {
  if (!chromaMemory.collections[collection]) chromaMemory.collections[collection] = [];
  chromaMemory.collections[collection].push({
    ...entry,
    ts: new Date().toISOString(),
    id: Date.now()
  });
  // Keep last 500 per collection
  if (chromaMemory.collections[collection].length > 500)
    chromaMemory.collections[collection] = chromaMemory.collections[collection].slice(-500);
  saveChroma();
}

function chromaQuery(collection, query, limit = 5) {
  const col = chromaMemory.collections[collection] || [];
  if (!query) return col.slice(-limit);
  const q = query.toLowerCase();
  return col
    .filter(e => (e.content || '').toLowerCase().includes(q) || (e.insight || '').toLowerCase().includes(q))
    .slice(-limit);
}

function chromaStats() {
  return Object.entries(chromaMemory.collections)
    .map(([k, v]) => `  ${BRANCHES[k]?.name || k}: ${v.length} entries`)
    .join('\n');
}

// ─── APPROVAL QUEUE ───────────────────────────────────────────────────────────
function queueApproval(action, details, executeFn) {
  const id = Date.now();
  CONFIG.pendingApprovals.push({ id, action, details, executeFn, ts: new Date().toISOString() });
  print(`\n⚠️  APPROVAL NEEDED [#${id}]:`);
  print(`   Action:  ${action}`);
  print(`   Details: ${details}`);
  print(`   Run: /approve ${id}  or  /deny ${id}`);
  log(`APPROVAL_QUEUED: [${id}] ${action} — ${details}`);
}

// ─── MEMORY ───────────────────────────────────────────────────────────────────
let memory = [];
try {
  if (fs.existsSync(CONFIG.memoryFile))
    memory = JSON.parse(fs.readFileSync(CONFIG.memoryFile, 'utf8'));
} catch(e) { memory = []; }

function saveMemory() {
  try { fs.writeFileSync(CONFIG.memoryFile, JSON.stringify(memory.slice(-500), null, 2)); } catch(e) {}
}

function remember(role, content, branch) {
  const entry = { role, content, ts: new Date().toISOString() };
  memory.push(entry);
  saveMemory();
  // Also index in ChromaDB
  if (branch || role === 'user' || role === 'assistant') {
    const col = branch || detectBranch(content);
    chromaAdd(col, { role, content: content.substring(0, 500) });
  }
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch(e) {}
}
function print(msg) {
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
  process.stdout.write('\r' + msg + '\n> ');
  hudBroadcast('log', { msg: clean });
  if (typeof global._phonePrintHook === 'function') global._phonePrintHook(clean);
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers, timeout: 10000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const req  = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// ─── BRIDGE ───────────────────────────────────────────────────────────────────
function bridgeHeaders() { return { 'x-bridge-key': CONFIG.bridgeKey }; }

async function bridgeSend(type, content, to = 'claude') {
  if (!CONFIG.bridgeUrl) return false;
  try {
    await httpPost(`${CONFIG.bridgeUrl}/send`,
      { from: 'commander', to, type, content }, bridgeHeaders());
    return true;
  } catch(e) { log(`BRIDGE_SEND_ERR: ${e.message}`); return false; }
}

async function bridgePoll() {
  if (!CONFIG.bridgeUrl) return [];
  try {
    const raw  = await httpGet(`${CONFIG.bridgeUrl}/poll?to=commander`, bridgeHeaders());
    const data = JSON.parse(raw);
    return data.messages || [];
  } catch(e) { log(`BRIDGE_POLL_ERR: ${e.message}`); return []; }
}

async function bridgeHeartbeat() {
  if (!CONFIG.bridgeUrl) return;
  try {
    const trader = await httpGet(CONFIG.traderUrl).then(r => JSON.parse(r)).catch(() => null);
    await httpPost(`${CONFIG.bridgeUrl}/status`, {
      uptime:     Math.floor(process.uptime()),
      version:    CONFIG.version,
      memory:     memory.length,
      chroma:     Object.entries(chromaMemory.collections).reduce((a,[,v]) => a + v.length, 0),
      trader:     trader ? { balance: trader.balance, status: trader.status, price: trader.currentPrice } : null,
      voice:      CONFIG.voiceEnabled ? 'enabled' : 'disabled',
      deepseek:   CONFIG.deepseekReady ? 'ready' : 'not loaded',
      approvals:  CONFIG.pendingApprovals.length,
      lastAction: memory[memory.length - 1]?.content?.substring(0, 80) || 'idle'
    }, bridgeHeaders());
  } catch(e) {}
}

function startBridgeLoop() {
  if (!CONFIG.bridgeUrl || !CONFIG.bridgeKey) {
    log('BRIDGE: not configured — set BRIDGE_URL and BRIDGE_KEY env vars');
    return;
  }
  log(`BRIDGE: connected to ${CONFIG.bridgeUrl}`);

  setInterval(async () => {
    await bridgeHeartbeat();
    const msgs = await bridgePoll();
    for (const msg of msgs) {
      print(`\n📨 MESSAGE FROM ${msg.from.toUpperCase()} [${msg.type}]:\n${msg.content}`);
      log(`BRIDGE_MSG: from=${msg.from} type=${msg.type} content=${msg.content.substring(0,100)}`);
      remember('bridge_in', `[${msg.from}/${msg.type}] ${msg.content}`);

      if (msg.type === 'command' && msg.content.startsWith('/')) {
        print(`⚙️  Auto-executing bridge command: ${msg.content}`);
        await handleCommand(msg.content, null);
      }
    }
  }, CONFIG.pollInterval);

  setTimeout(bridgeHeartbeat, 2000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── OLLAMA / MODEL ROUTING ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Route: use DeepSeek for heavy reasoning, Phi-3 for quick tasks
function pickModel(prompt) {
  if (!CONFIG.deepseekReady) return CONFIG.ollamaModel;
  const heavy = ['analyze','why','how should','plan','strategy','compare','evaluate',
                 'opportunity','should i','what if','research','forecast','decide','recommend'];
  const lower = prompt.toLowerCase();
  if (heavy.some(k => lower.includes(k))) return CONFIG.deepseekModel;
  if (prompt.length > 200) return CONFIG.deepseekModel;
  return CONFIG.ollamaModel;
}

async function askOllama(prompt, context = [], forceModel = null) {
  const model = forceModel || pickModel(prompt);
  const branch = detectBranch(prompt);

  // Inject relevant ChromaDB context
  const related = chromaQuery(branch, prompt, 3);
  const chromaContext = related.length
    ? '\n\nRELEVANT MEMORY:\n' + related.map(e => `- [${e.ts?.split('T')[0]}] ${e.content || e.insight}`).join('\n')
    : '';

  const messages = [
    {
      role: 'system',
      content: `You are Commander, the AI operations hub for AIKON-OS (Al iKon Unlimited LLC).
You manage: XAU/USD Trader, Roblox Games (Silent Santa, Magic Moments, Castle Kings, Dead to Dawn, Lemonade Rush, Stick Fights), Restaurant Web Agency, and all business operations.
You actively scout new automated business opportunities and surface the best ones.
You are direct, efficient, action-oriented. Big decisions (spending money, major code changes, new business moves) require Al iKon's approval — queue them with a clear summary.
Bridge: ${CONFIG.bridgeUrl ? 'CONNECTED' : 'not configured'}
Voice: ${CONFIG.voiceEnabled ? 'ENABLED' : 'disabled'}
Model: ${model} | Version: ${CONFIG.version}
Date: ${new Date().toLocaleDateString()}
Active Branch: ${BRANCHES[branch]?.name || branch}${chromaContext}`
    },
    ...context.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: prompt }
  ];

  const body = JSON.stringify({ model, messages, stream: false });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: CONFIG.ollamaHost, port: CONFIG.ollamaPort,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ reply: JSON.parse(d).message?.content || 'No response', model }); }
        catch(e) { resolve({ reply: d, model }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${model} timeout`)); });
    req.write(body); req.end();
  });
}

async function checkDeepseek() {
  try {
    const raw = await httpGet(`http://${CONFIG.ollamaHost}:${CONFIG.ollamaPort}/api/tags`);
    const data = JSON.parse(raw);
    const models = (data.models || []).map(m => m.name);
    CONFIG.deepseekReady = models.some(m => m.includes('deepseek-r1'));
    return CONFIG.deepseekReady;
  } catch(e) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SETUP: DEEPSEEK + MODELS DIR ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function setupDeepseek() {
  print('🔧 Setting up DeepSeek R1 on D: drive...');

  // 1. Set OLLAMA_MODELS env var to D: drive
  print('⚙️  Step 1/3 — Setting OLLAMA_MODELS to D:\\AIKON-OS\\models...');
  const setEnv = runShell(`setx OLLAMA_MODELS "D:\\AIKON-OS\\models" /M`);
  print(`   ${setEnv}`);
  log(`SETUP: OLLAMA_MODELS set to D:\\AIKON-OS\\models`);

  // 2. Create models dir
  if (!fs.existsSync(CONFIG.modelsDir)) {
    fs.mkdirSync(CONFIG.modelsDir, { recursive: true });
    print('   📁 Created D:\\AIKON-OS\\models');
  }

  // 3. Pull DeepSeek R1 7b (streams progress)
  print(`⬇️  Step 2/3 — Pulling ${CONFIG.deepseekModel} (~4.7GB, this takes a while)...`);
  print('   Progress will stream below. Commander stays running.');

  return new Promise((resolve) => {
    const proc = spawn('ollama', ['pull', CONFIG.deepseekModel], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OLLAMA_MODELS: CONFIG.modelsDir }
    });

    let lastLine = '';
    proc.stdout.on('data', d => {
      const line = d.toString().trim();
      if (line && line !== lastLine) {
        process.stdout.write(`\r   ${line}                    `);
        lastLine = line;
      }
    });
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line && line !== lastLine) {
        process.stdout.write(`\r   ${line}                    `);
        lastLine = line;
      }
    });
    proc.on('close', async code => {
      process.stdout.write('\n');
      if (code === 0) {
        CONFIG.deepseekReady = true;
        print(`✅ Step 3/3 — DeepSeek R1 7b ready!`);
        print(`   Model routing: Phi-3 (fast) ↔ DeepSeek (reasoning)`);
        chromaAdd('aikon_os', { insight: 'DeepSeek R1 7b installed on D: drive. Model routing active.' });
        log('SETUP: deepseek-r1:7b installed');
        resolve(true);
      } else {
        print(`❌ Pull failed (exit ${code}). Ollama must be running. Try: ollama serve`);
        resolve(false);
      }
    });
    proc.on('error', e => {
      print(`❌ ollama not found: ${e.message}`);
      resolve(false);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── 24/7 BACKGROUND LEARNER ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const LEARN_SOURCES = [
  { url: 'https://xauusd-trader-80p0.onrender.com/api/state', branch: 'trader', label: 'Trader State' },
];

// Free news sources (no API key needed)
const NEWS_QUERIES = [
  { q: 'gold price XAU USD forecast',         branch: 'trader' },
  { q: 'Roblox game monetization trends 2024', branch: 'roblox' },
  { q: 'automated business ideas passive income 2024', branch: 'opportunities' },
  { q: 'restaurant local business web marketing', branch: 'agency' },
  { q: 'AI automation small business tools 2024', branch: 'opportunities' },
];

async function learnFromTrader() {
  try {
    const s = JSON.parse(await httpGet(CONFIG.traderUrl));
    const insight = `Trader: balance=$${s.balance?.toFixed(2)}, winRate=${s.winRate}%, status=${s.status}, price=$${s.currentPrice}, openTrades=${s.openTrades}`;
    chromaAdd('trader', { insight, source: 'trader_api' });
    log(`LEARN: trader snapshot logged`);
  } catch(e) { log(`LEARN_ERR trader: ${e.message}`); }
}

async function learnOpportunities() {
  // Use DeepSeek (or Phi-3) to generate opportunity insights from memory
  if (memory.length < 10) return;
  try {
    const recentOps = chromaQuery('opportunities', '', 5);
    const prompt = `Based on AIKON-OS context (Al iKon Unlimited LLC, solo founder, Columbus OH, stack: Node.js/Render/Roblox/Flutter):
List 3 specific automated business opportunities worth exploring. For each give:
1. Business idea (1 line)
2. Why it fits Al iKon's stack (1 line)
3. First automated step to test it (1 line)
Be specific and actionable. Focus on low-cost, high-automation potential.`;

    const { reply, model } = await askOllama(prompt, [], CONFIG.deepseekReady ? CONFIG.deepseekModel : null);
    chromaAdd('opportunities', { insight: reply, source: 'commander_analysis', model });
    log(`LEARN: opportunity analysis generated (${model})`);
    // Surface to user if significant
    if (reply.length > 100) {
      print(`\n💡 OPPORTUNITY SCAN [${new Date().toLocaleTimeString()}]:\n${reply.substring(0,400)}...\n   (Full report: /opportunities)`);
    }
  } catch(e) { log(`LEARN_ERR opportunities: ${e.message}`); }
}

async function learnCycle() {
  log('LEARN: background cycle starting');
  await learnFromTrader();

  // Rotate through news/research queries
  const q = NEWS_QUERIES[Math.floor(Math.random() * NEWS_QUERIES.length)];
  try {
    // DuckDuckGo instant answer (free, no key)
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q.q)}&format=json&no_html=1&skip_disambig=1`;
    const raw = await httpGet(url);
    const data = JSON.parse(raw);
    const insight = data.AbstractText || data.Answer || '';
    if (insight && insight.length > 20) {
      chromaAdd(q.branch, { insight: insight.substring(0, 400), source: 'duckduckgo', query: q.q });
      log(`LEARN: indexed "${q.q}" → ${insight.substring(0,80)}`);
    }
  } catch(e) { log(`LEARN_ERR ddg: ${e.message}`); }

  // Every 10 cycles, run opportunity analysis
  if (!learnCycle._count) learnCycle._count = 0;
  learnCycle._count++;
  if (learnCycle._count % 10 === 0) await learnOpportunities();
}

function startLearner() {
  log('LEARNER: 24/7 background learning started');
  setTimeout(learnCycle, 10000); // first run after 10s
  setInterval(learnCycle, CONFIG.learnInterval);
}

// ─── BRAIN SYNC ───────────────────────────────────────────────────────────────
async function syncFromBrain() {
  if (!CONFIG.brainUrl) return;
  try {
    const lastSync = (() => {
      try {
        const f = path.join('D:\\AIKON-OS', 'brain_sync.json');
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')).last_sync;
      } catch(e) {}
      return new Date(Date.now() - 86400000).toISOString(); // default: last 24h
    })();

    print(`\n🧠 Brain sync — fetching memories since ${lastSync.split('T')[0]}...`);
    const url = `${CONFIG.brainUrl}/sync?since=${encodeURIComponent(lastSync)}`;
    const raw = await httpGet(url, { 'x-bridge-key': CONFIG.bridgeKey });
    const data = JSON.parse(raw);

    if (data.count > 0) {
      for (const item of data.items) {
        chromaAdd(item.branch, { content: item.content, source: item.source, score: item.score });
      }
      // Save sync timestamp
      try {
        const f = path.join('D:\\AIKON-OS', 'brain_sync.json');
        fs.writeFileSync(f, JSON.stringify({ last_sync: new Date().toISOString() }));
      } catch(e) {}
      print(`🧠 Brain sync complete — ${data.count} new memories loaded across all branches`);
      log(`BRAIN_SYNC: imported ${data.count} items`);
    } else {
      print(`🧠 Brain sync — up to date`);
    }
  } catch(e) {
    log(`BRAIN_SYNC_ERR: ${e.message}`);
  }
}

// ─── TRADER CHECK ─────────────────────────────────────────────────────────────
async function checkTrader() {
  try {
    const s = JSON.parse(await httpGet(CONFIG.traderUrl));
    return [
      `📊 TRADER — ${new Date().toLocaleTimeString()}`,
      `Balance:       $${s.balance?.toFixed(2) ?? 'N/A'}`,
      `Win Rate:      ${s.winRate ?? 'N/A'}%`,
      `Open Trades:   ${s.openTrades ?? 0}`,
      `Consec Losses: ${s.consecutiveLosses ?? 0}`,
      `Price:         $${s.currentPrice ?? 'N/A'}`,
      `Status:        ${s.status ?? 'N/A'}`,
    ].join('\n');
  } catch(e) {
    return `❌ Trader unreachable: ${e.message}`;
  }
}

// ─── GITHUB ───────────────────────────────────────────────────────────────────
async function fetchLatestVersion(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${CONFIG.updateRepo}/contents/${CONFIG.updateFile}?ref=${CONFIG.updateBranch}`,
      headers: {
        'Authorization': `token ${token}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'AIKON-Commander'
      },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (!json.content) { reject(new Error(json.message || 'No content')); return; }
          const code = Buffer.from(json.content, 'base64').toString('utf8');
          resolve({ code, sha: json.sha });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function extractVersion(code) {
  const m = code.match(/version:\s*['"]([^'"]+)['"]/);
  return m ? m[1] : 'unknown';
}

async function selfUpdate(token) {
  print(`⬇️  Checking GitHub for updates (${CONFIG.updateRepo}/${CONFIG.updateFile})...`);
  try {
    const { code, sha } = await fetchLatestVersion(token);
    const latestVer = extractVersion(code);
    if (latestVer === CONFIG.version) {
      print(`✅ Already on latest version (v${CONFIG.version}). No update needed.`);
      return;
    }
    print(`🆕 Update found: v${CONFIG.version} → v${latestVer}`);
    const selfPath   = __filename;
    const backupPath = selfPath + '.backup';
    fs.copyFileSync(selfPath, backupPath);
    fs.writeFileSync(selfPath, code, 'utf8');
    print(`✅ Updated to v${latestVer}. Restarting Commander...`);
    log(`SELF_UPDATE: v${CONFIG.version} → v${latestVer} sha=${sha.substring(0,8)}`);
    await bridgeSend('status', `Commander self-updated v${CONFIG.version} → v${latestVer}. Restarting.`, 'claude');
    const child = spawn(process.execPath, [selfPath], { detached: true, stdio: 'inherit', cwd: __dirname });
    child.unref();
    process.exit(0);
  } catch(e) {
    print(`❌ Update failed: ${e.message}`);
    log(`SELF_UPDATE_ERR: ${e.message}`);
  }
}

async function githubGetFile(token, repo, file) {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'api.github.com', path: `/repos/${repo}/contents/${file}`,
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AIKON-Commander' },
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    }).on('error', reject).end();
  });
}

async function githubPushFile(token, repo, file, content, sha, message) {
  const body = JSON.stringify({ message, content: Buffer.from(content).toString('base64'), sha });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${repo}/contents/${file}`, method: 'PUT',
      headers: {
        'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AIKON-Commander', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─── SHELL ────────────────────────────────────────────────────────────────────
function runShell(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim() || '(no output)'; }
  catch(e) { return `Error: ${e.message}`; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TTS — COMMANDER TALKS BACK ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function speak(text) {
  if (!CONFIG.ttsEnabled) return;
  if (!fs.existsSync(CONFIG.voiceSpeak)) return;
  // Truncate very long responses for speech
  const spoken = text.replace(/[*_`#]/g, '').substring(0, 300);
  try {
    spawn('python', [CONFIG.voiceSpeak, spoken, String(CONFIG.ttsRate)], {
      stdio: 'ignore', detached: false
    });
  } catch(e) { log(`TTS_ERR: ${e.message}`); }
}

function ttsAvailable() {
  return fs.existsSync(CONFIG.voiceSpeak);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PUSH NOTIFICATIONS — ntfy.sh ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function notify(title, message, priority = 'default') {
  if (!CONFIG.ntfyTopic) return;
  try {
    const body = message.substring(0, 500);
    const req = https.request({
      hostname: 'ntfy.sh',
      path: `/${CONFIG.ntfyTopic}`,
      method: 'POST',
      headers: {
        'Title':    title,
        'Priority': priority,  // min low default high urgent
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 8000
    }, res => { res.resume(); });
    req.on('error', e => log(`NTFY_ERR: ${e.message}`));
    req.write(body);
    req.end();
    log(`NTFY: [${priority}] ${title} — ${body.substring(0,80)}`);
  } catch(e) { log(`NTFY_ERR: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WAKE WORD ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

let wakeProc = null;

function startWakeWord() {
  if (!CONFIG.wakeEnabled) return;
  if (!fs.existsSync(CONFIG.wakeWord)) return;
  if (wakeProc) return; // already running

  print('👂 Wake word active — say "Commander" to speak');
  wakeProc = spawn('python', [CONFIG.wakeWord], { stdio: ['ignore', 'pipe', 'pipe'] });

  wakeProc.stdout.on('data', async d => {
    const line = d.toString().trim();
    if (line.startsWith('WAKE:') || line.startsWith('WAKE_PARTIAL:')) {
      print('\n🎙️  Wake word detected! Listening...');
      speak('Yes?');
      const text = await voiceInput(5);
      if (text) {
        if (text.trim().toLowerCase().startsWith('/')) {
          await handleCommand(text.trim(), null);
        } else {
          print('🤔 Thinking...');
          remember('user', `[wake] ${text}`);
          try {
            const { reply, model } = await askOllama(text, memory.filter(m => m.role !== 'note'));
            print(`\nCommander [${model}]: ${reply}\n`);
            speak(reply);
            remember('assistant', reply);
          } catch(e) { print(`❌ ${e.message}`); }
        }
      }
    } else if (line === 'VOSK_MISSING') {
      print('⚠️  vosk not installed: pip install vosk sounddevice');
      CONFIG.wakeEnabled = false;
    } else if (line.startsWith('MODEL_MISSING:')) {
      print(`⚠️  Vosk model missing. Download vosk-model-small-en-us from alphacephei.com/vosk/models`);
      print(`    Extract to: D:\\AIKON-OS\\models\\vosk-model-small-en-us`);
      CONFIG.wakeEnabled = false;
    }
  });

  wakeProc.on('close', code => {
    wakeProc = null;
    if (CONFIG.wakeEnabled) {
      log(`WAKE: process exited (${code}), restarting in 5s`);
      setTimeout(startWakeWord, 5000);
    }
  });
  wakeProc.on('error', e => { log(`WAKE_ERR: ${e.message}`); wakeProc = null; });
}

function stopWakeWord() {
  CONFIG.wakeEnabled = false;
  if (wakeProc) { wakeProc.kill(); wakeProc = null; }
  print('👂 Wake word disabled.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TEAMS ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function runTeam(teamKey, task) {
  const team = CONFIG.teams[teamKey];
  if (!team) return `Unknown team: ${teamKey}`;
  if (!team.active) return `${team.name} is inactive.`;

  print(`\n🤖 ${team.name} working on: ${task}`);
  log(`TEAM [${teamKey}]: ${task}`);

  // Pull relevant memory from ChromaDB
  const context = chromaQuery(team.branch, task, 5);
  const contextStr = context.length
    ? '\n\nRELEVANT MEMORY:\n' + context.map(e => `- ${e.content || e.insight}`).join('\n')
    : '';

  const systemPrompt = {
    trader:   `You are the Trader Team for AIKON-OS. You analyze XAU/USD market conditions, evaluate trade signals, and recommend actions. You are precise and data-driven. Big trades require Al iKon approval.`,
    biz:      `You are the Biz Team for AIKON-OS. You evaluate business opportunities, draft plans, and identify revenue actions across all Al iKon businesses. Flag anything requiring budget or major commitment for approval.`,
    research: `You are the Research Team for AIKON-OS. You research markets, competitors, trends, and opportunities. Provide concise, actionable summaries with sources when possible.`,
    roblox:   `You are the Roblox Team for AIKON-OS. You manage Silent Santa, Magic Moments, Castle Kings, Dead to Dawn, Lemonade Rush, and Stick Fights. You optimize game mechanics, monetization, and updates.`,
  }[teamKey] || `You are the ${team.name} for AIKON-OS.`;

  const model = (teamKey === 'trader' || teamKey === 'biz') && CONFIG.deepseekReady
    ? CONFIG.deepseekModel : CONFIG.ollamaModel;

  try {
    const messages = [
      { role: 'system', content: systemPrompt + contextStr },
      { role: 'user',   content: task }
    ];
    const body = JSON.stringify({ model, messages, stream: false });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: CONFIG.ollamaHost, port: CONFIG.ollamaPort,
        path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 120000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d).message?.content || 'No response'); } catch(e) { resolve(d); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });

    // Check if approval needed
    const needsApproval = /\b(deploy|send|post|publish|buy|sell|spend|charge|delete|remove|create account|wire)\b/i.test(result);
    if (needsApproval) {
      queueApproval(`${team.name}: ${task.substring(0,60)}`, result.substring(0,200), async () => {
        print(`✅ ${team.name} action approved.`);
        await notify(`${team.name} Approved`, result.substring(0, 200), 'high');
      });
    }

    chromaAdd(team.branch, { content: `[${team.name}] Task: ${task} → ${result.substring(0,200)}`, source: 'team' });
    log(`TEAM [${teamKey}/${model}]: ${result.substring(0,200)}`);
    return `🤖 ${team.name} [${model}]:\n${result}`;
  } catch(e) {
    log(`TEAM_ERR [${teamKey}]: ${e.message}`);
    return `❌ ${team.name} error: ${e.message}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VOICE / WHISPER STT ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ensureVoiceRecorder() {
  if (fs.existsSync(CONFIG.voiceRecorder)) return;
  const script = `# AIKON-OS Voice Recorder
import sys, sounddevice as sd, soundfile as sf, numpy as np
SAMPLE_RATE = 16000
DURATION    = int(sys.argv[1]) if len(sys.argv) > 1 else 5
print(f"[VOICE] Recording {DURATION}s... speak now", flush=True)
audio = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype='int16')
sd.wait()
sf.write(sys.argv[2] if len(sys.argv) > 2 else "voice_input.wav", audio, SAMPLE_RATE)
print("[VOICE] Done.", flush=True)
`;
  fs.writeFileSync(CONFIG.voiceRecorder, script);
}

function findWhisper() {
  const candidates = [
    'C:\\Python314\\Scripts\\whisper.exe',
    'C:\\Python313\\Scripts\\whisper.exe',
    'C:\\Python312\\Scripts\\whisper.exe',
    'C:\\Python311\\Scripts\\whisper.exe',
    (process.env.USERPROFILE || '') + '\\AppData\\Roaming\\Python\\Python314\\Scripts\\whisper.exe',
    (process.env.USERPROFILE || '') + '\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\whisper.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { cmd: p, args: [] };
  }
  try {
    const found = execSync('where whisper', { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0].trim();
    if (found && fs.existsSync(found)) return { cmd: found, args: [] };
  } catch(e) {}
  return null;
}

function whisperAvailable() { return !!findWhisper(); }

function spawnWhisper(whisper, wavPath, extraArgs) {
  return spawn(whisper.cmd, [...whisper.args, wavPath, ...extraArgs]);
}

function recordVoice(seconds = 5) {
  return new Promise((resolve, reject) => {
    ensureVoiceRecorder();
    print(`🎙️  Listening for ${seconds}s — speak now...`);
    const proc = spawn('python', [CONFIG.voiceRecorder, String(seconds), CONFIG.voiceWav]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); process.stdout.write('\r' + d.toString().trim()); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(CONFIG.voiceWav)) resolve(CONFIG.voiceWav);
      else reject(new Error(`Recorder exited ${code}: ${out}`));
    });
    proc.on('error', reject);
  });
}

function transcribeWhisper(wavPath) {
  return new Promise((resolve, reject) => {
    print('⚙️  Transcribing...');
    const whisper = findWhisper();
    if (!whisper) { reject(new Error('Whisper not found. Run: pip install openai-whisper')); return; }
    const outDir = path.dirname(wavPath);
    const proc = spawnWhisper(whisper, wavPath, [
      '--model', CONFIG.whisperModel,
      '--language', 'en',
      '--output_format', 'txt',
      '--output_dir', outDir
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      const txtFile = wavPath.replace(/\.wav$/i, '.txt');
      if (fs.existsSync(txtFile)) {
        const text = fs.readFileSync(txtFile, 'utf8').trim();
        try { fs.unlinkSync(txtFile); } catch(e) {}
        resolve(text || null);
      } else if (out.trim()) {
        const lines = out.trim().split('\n').filter(l => l.trim() && !l.startsWith('['));
        resolve(lines.join(' ').trim() || null);
      } else {
        reject(new Error(`Whisper failed (${code}): ${err.substring(0,200)}`));
      }
    });
    proc.on('error', e => reject(new Error(`Whisper not found: ${e.message}`)));
  });
}

async function voiceInput(seconds = 5) {
  if (!CONFIG.voiceEnabled) { print('🔇 Voice disabled. Run /voice on to enable.'); return null; }
  try {
    const wavPath = await recordVoice(seconds);
    const text    = await transcribeWhisper(wavPath);
    try { fs.unlinkSync(wavPath); } catch(e) {}
    if (!text) { print('❌ No speech detected.'); return null; }
    print(`🎤 Heard: "${text}"`);
    log(`VOICE: "${text}"`);
    return text;
  } catch(e) {
    print(`❌ Voice error: ${e.message}`);
    log(`VOICE_ERR: ${e.message}`);
    return null;
  }
}

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
async function handleCommand(input, rl) {
  const parts = input.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1).join(' ');

  hudBroadcast('cmd', { input: input.trim() });

  switch(cmd) {

    // ── SELF-UPDATE ──────────────────────────────────────────────────────────
    case '/update': {
      const token = args.trim() || process.env.GITHUB_TOKEN || '';
      if (!token) {
        print('❌ No token. Set GITHUB_TOKEN env var or run /update <token>');
        break;
      }
      await selfUpdate(token);
      break;
    }

    // ── SETUP ────────────────────────────────────────────────────────────────
    case '/setup': {
      if (args === 'deepseek' || args === '') {
        await setupDeepseek();
      } else {
        print('Usage: /setup deepseek');
      }
      break;
    }

    // ── APPROVE / DENY ───────────────────────────────────────────────────────
    case '/approve': {
      const id = parseInt(args);
      const idx = CONFIG.pendingApprovals.findIndex(a => a.id === id);
      if (idx === -1) { print(`❌ No pending approval #${id}`); break; }
      const approval = CONFIG.pendingApprovals.splice(idx, 1)[0];
      print(`✅ Approved: ${approval.action}`);
      log(`APPROVAL: approved [${id}] ${approval.action}`);
      chromaAdd('aikon_os', { insight: `Approved: ${approval.action} — ${approval.details}` });
      try { await approval.executeFn(); } catch(e) { print(`❌ Execution failed: ${e.message}`); }
      break;
    }

    case '/deny': {
      const id = parseInt(args);
      const idx = CONFIG.pendingApprovals.findIndex(a => a.id === id);
      if (idx === -1) { print(`❌ No pending approval #${id}`); break; }
      const approval = CONFIG.pendingApprovals.splice(idx, 1)[0];
      print(`🚫 Denied: ${approval.action}`);
      log(`APPROVAL: denied [${id}] ${approval.action}`);
      break;
    }

    case '/approvals': {
      if (CONFIG.pendingApprovals.length === 0) { print('✅ No pending approvals.'); break; }
      print(`⏳ PENDING APPROVALS (${CONFIG.pendingApprovals.length}):`);
      CONFIG.pendingApprovals.forEach(a => {
        print(`  [#${a.id}] ${a.action}\n        ${a.details}\n        /approve ${a.id}  or  /deny ${a.id}`);
      });
      break;
    }

    // ── LEARN ────────────────────────────────────────────────────────────────
    case '/learn': {
      print('⚙️  Running learn cycle now...');
      await learnCycle();
      print('✅ Learn cycle complete.');
      break;
    }

    case '/memory':
    case '/chroma': {
      if (args) {
        const branch = args.split(' ')[0];
        const query  = args.split(' ').slice(1).join(' ');
        const results = chromaQuery(branch, query, 10);
        if (!results.length) { print(`No memory in branch "${branch}"`); break; }
        print(`📚 ${BRANCHES[branch]?.name || branch} memory (${results.length}):`);
        results.forEach(e => print(`  [${e.ts?.split('T')[0]}] ${(e.content || e.insight || '').substring(0,120)}`));
      } else {
        print(`📚 CHROMA MEMORY STATS:\n${chromaStats()}`);
        print(`\nSession memory: ${memory.length} entries`);
        print(`Usage: /memory <branch> [query]  — branches: ${Object.keys(BRANCHES).join(', ')}`);
      }
      break;
    }

    // ── OPPORTUNITIES ────────────────────────────────────────────────────────
    case '/opportunities':
    case '/scout': {
      print('🔍 Analyzing opportunities...');
      const stored = chromaQuery('opportunities', '', 10);
      if (stored.length) {
        print(`\n💡 STORED OPPORTUNITIES (${stored.length} insights):`);
        stored.slice(-5).forEach(e => print(`\n[${e.ts?.split('T')[0]}]:\n${(e.insight || e.content || '').substring(0,300)}`));
      }
      // Run fresh analysis
      print('\n⚙️  Running fresh opportunity scan...');
      await learnOpportunities();
      break;
    }

    // ── MODELS ───────────────────────────────────────────────────────────────
    case '/models': {
      const ready = await checkDeepseek();
      try {
        const raw = await httpGet(`http://${CONFIG.ollamaHost}:${CONFIG.ollamaPort}/api/tags`);
        const data = JSON.parse(raw);
        const models = (data.models || []).map(m => `  ${m.name} (${(m.size/1e9).toFixed(1)}GB)`).join('\n');
        print(`🤖 LOADED MODELS:\n${models || '  none'}`);
        print(`\nRouting: Phi-3 (fast commands) ↔ DeepSeek (reasoning${ready ? ' ✅' : ' — run /setup deepseek'})`);
      } catch(e) { print(`❌ Ollama unreachable: ${e.message}`); }
      break;
    }

    // ── VOICE ────────────────────────────────────────────────────────────────
    case '/v':
    case '/voice': {
      if (args === 'on')  { CONFIG.voiceEnabled = true;  print('🎙️  Voice enabled.'); break; }
      if (args === 'off') { CONFIG.voiceEnabled = false; print('🔇 Voice disabled.'); break; }
      if (args === 'setup') {
        const pyCheck = runShell('python --version');
        const sdCheck = runShell('python -c "import sounddevice; print(sounddevice.__version__)"');
        const sfCheck = runShell('python -c "import soundfile; print(soundfile.__version__)"');
        const whisperFound = findWhisper();
        const wsCheck = whisperFound
          ? `found ✅  (${whisperFound.cmd})`
          : 'NOT FOUND ❌  →  pip install openai-whisper';
        print([
          `Python:       ${pyCheck}`,
          `sounddevice:  ${sdCheck}`,
          `soundfile:    ${sfCheck}`,
          `whisper CLI:  ${wsCheck}`,
          '',
          'Install all:  pip install openai-whisper sounddevice soundfile numpy',
        ].join('\n'));
        break;
      }
      const secs = parseInt(args) || 5;
      const text = await voiceInput(secs);
      if (!text) break;
      if (text.trim().toLowerCase().startsWith('/')) {
        await handleCommand(text.trim(), rl);
      } else {
        print('🤔 Thinking...');
        remember('user', `[voice] ${text}`);
        try {
          const { reply, model } = await askOllama(text, memory.filter(m => m.role !== 'note'));
          print(`\nCommander [${model}]: ${reply}\n`);
          speak(reply);
          remember('assistant', reply);
          log(`OLLAMA (voice/${model}): ${reply.substring(0,200)}`);
        } catch(e) { print(`❌ Ollama error: ${e.message}`); }
      }
      break;
    }

    // ── TTS / WAKE / NOTIFY / TEAMS ──────────────────────────────────────────
    case '/tts': {
      if (args === 'on')  { CONFIG.ttsEnabled = true;  print('🔊 TTS enabled — Commander will speak responses.'); break; }
      if (args === 'off') { CONFIG.ttsEnabled = false; print('🔇 TTS disabled.'); break; }
      if (args.startsWith('say ')) {
        const msg = args.slice(4);
        speak(msg); print(`🔊 Speaking: "${msg}"`);
        break;
      }
      if (args === 'check') {
        const pyOk = runShell('python --version').includes('Python');
        const ttsOk = fs.existsSync(CONFIG.voiceSpeak);
        const pkgOk = runShell('python -c "import pyttsx3; print(pyttsx3.__version__)"');
        print([
          `voice_speak.py: ${ttsOk ? '✅ found' : '❌ missing'}`,
          `Python:         ${pyOk ? '✅' : '❌'}`,
          `pyttsx3:        ${pkgOk.includes('.') ? '✅ ' + pkgOk : '❌  → pip install pyttsx3'}`,
          `TTS enabled:    ${CONFIG.ttsEnabled ? '✅' : '⬜'}`,
        ].join('\n'));
        break;
      }
      print('TTS: /tts on|off|check | /tts say <text>');
      break;
    }

    case '/wake': {
      if (args === 'on')  { CONFIG.wakeEnabled = true;  startWakeWord(); break; }
      if (args === 'off') { stopWakeWord(); break; }
      if (args === 'check') {
        const model = fs.existsSync('D:\\AIKON-OS\\models\\vosk-model-small-en-us');
        const voskCheck = runShell('python -c "from vosk import Model; print(\'ok\')"');
        const sdCheck   = runShell('python -c "import sounddevice; print(sounddevice.__version__)"');
        print([
          `vosk model:     ${model ? '✅ found' : '❌ missing — download from alphacephei.com/vosk/models'}`,
          `vosk pkg:       ${voskCheck === 'ok' ? '✅' : '❌  → pip install vosk'}`,
          `sounddevice:    ${sdCheck.includes('.') ? '✅ ' + sdCheck : '❌  → pip install sounddevice'}`,
          `Wake enabled:   ${CONFIG.wakeEnabled ? '✅' : '⬜'}`,
          '',
          'Model path: D:\\AIKON-OS\\models\\vosk-model-small-en-us',
          'Download:   https://alphacephei.com/vosk/models → vosk-model-small-en-us-0.22.zip',
        ].join('\n'));
        break;
      }
      print('Wake: /wake on | /wake off | /wake check');
      break;
    }

    case '/notify': {
      if (!CONFIG.ntfyTopic) {
        print('❌ ntfy not configured. Set NTFY_TOPIC env var:\n  setx NTFY_TOPIC "aikon-commander-<yourname>"\nThen subscribe in ntfy app to that topic.');
        break;
      }
      if (args.startsWith('test')) {
        await notify('Commander Test', 'Push notifications working! 🚀', 'default');
        print(`✅ Test notification sent to topic: ${CONFIG.ntfyTopic}`);
        break;
      }
      if (args) {
        await notify('Commander', args, 'default');
        print(`📱 Sent: ${args}`);
        break;
      }
      print(`📱 ntfy topic: ${CONFIG.ntfyTopic}\n/notify test | /notify <message>`);
      break;
    }

    case '/team': {
      const [teamKey, ...taskParts] = args.split(' ');
      const task = taskParts.join(' ');
      if (!teamKey) {
        print('Teams: ' + Object.entries(CONFIG.teams)
          .map(([k,v]) => `${v.active ? '✅' : '⬜'} ${k}: ${v.name}`)
          .join('\n       '));
        print('/team <key> <task>  — run a team on a task');
        print('/team <key> on|off  — activate/deactivate team');
        break;
      }
      if (task === 'on')  { if (CONFIG.teams[teamKey]) { CONFIG.teams[teamKey].active = true;  print(`✅ ${CONFIG.teams[teamKey].name} activated.`);  } break; }
      if (task === 'off') { if (CONFIG.teams[teamKey]) { CONFIG.teams[teamKey].active = false; print(`⬜ ${CONFIG.teams[teamKey].name} deactivated.`); } break; }
      if (!task) { print('Usage: /team <trader|biz|research|roblox> <task>'); break; }
      const result = await runTeam(teamKey, task);
      print(result);
      if (CONFIG.ttsEnabled) speak(result.substring(0, 200));
      break;
    }

    case '/trader':
    case '/report': {
      print('⏳ Fetching trader...');
      print(await checkTrader());
      break;
    }

    case '/bridge': {
      if (!CONFIG.bridgeUrl) { print('❌ Bridge not configured. Set BRIDGE_URL and BRIDGE_KEY env vars.'); break; }
      if (args === 'status') {
        try { print('🌉 BRIDGE STATUS:\n' + await httpGet(`${CONFIG.bridgeUrl}/status`, bridgeHeaders())); }
        catch(e) { print(`❌ Bridge unreachable: ${e.message}`); }
        break;
      }
      if (args === 'history') {
        try {
          const data = JSON.parse(await httpGet(`${CONFIG.bridgeUrl}/history?limit=10`, bridgeHeaders()));
          print(`📜 Last ${data.messages.length} bridge messages:`);
          data.messages.forEach(m => print(`  [${m.ts.split('T')[1].split('.')[0]}] ${m.from}→${m.to} [${m.type}]: ${m.content.substring(0,80)}`));
        } catch(e) { print(`❌ ${e.message}`); }
        break;
      }
      if (args.startsWith('send ')) {
        const ok = await bridgeSend('response', args.slice(5), 'claude');
        print(ok ? `✅ Sent to bridge: ${args.slice(5)}` : '❌ Bridge send failed');
        break;
      }
      print('Bridge: /bridge status | /bridge history | /bridge send <msg>');
      break;
    }

    case '/status': {
      const dsReady = await checkDeepseek();
      const teamsStr = Object.entries(CONFIG.teams)
        .map(([k,v]) => `${v.active ? '✅' : '⬜'} ${k}`)
        .join(' | ');
      print([
        '🖥️  AIKON-OS STATUS',
        `Commander:  ✅ v${CONFIG.version} running`,
        `Bridge:     ${CONFIG.bridgeUrl ? '✅ ' + CONFIG.bridgeUrl : '❌ not configured'}`,
        `Brain:      ${CONFIG.brainUrl ? '✅ ' + CONFIG.brainUrl : '⬜ not configured'}`,
        `Phi-3:      ✅ ${CONFIG.ollamaModel} (fast routing)`,
        `DeepSeek:   ${dsReady ? '✅ ' + CONFIG.deepseekModel + ' (reasoning)' : '⬜ not loaded — run /setup deepseek'}`,
        `Voice STT:  ${CONFIG.voiceEnabled ? '🎙️  enabled' : '🔇 disabled'}`,
        `TTS:        ${CONFIG.ttsEnabled ? '🔊 enabled' : '🔇 disabled'} — /tts on|off|check`,
        `Wake word:  ${CONFIG.wakeEnabled ? '👂 listening' : '⬜ disabled'} — /wake on|check`,
        `Push ntfy:  ${CONFIG.ntfyTopic ? '📱 ' + CONFIG.ntfyTopic : '⬜ not set — set NTFY_TOPIC'}`,
        `Teams:      ${teamsStr}`,
        `Learner:    ✅ running (every ${CONFIG.learnInterval/60000}min)`,
        `Memory:     ${memory.length} session entries`,
        `Chroma:     ${Object.entries(chromaMemory.collections).reduce((a,[,v]) => a + v.length, 0)} indexed entries`,
        `Approvals:  ${CONFIG.pendingApprovals.length} pending`,
        `Uptime:     ${Math.floor(process.uptime())}s`,
      ].join('\n'));
      break;
    }

    // ── BRAIN ────────────────────────────────────────────────────────────────
    case '/brain': {
      if (!CONFIG.brainUrl) { print('❌ Brain not configured. Set BRAIN_URL env var.'); break; }
      if (args === 'sync') {
        await syncFromBrain();
        break;
      }
      if (args === 'status') {
        try {
          const raw = await httpGet(`${CONFIG.brainUrl}/status`, { 'x-bridge-key': CONFIG.bridgeKey });
          const data = JSON.parse(raw);
          print([
            '🧠 BRAIN STATUS (Render — 24/7)',
            `Version:    v${data.version}`,
            `Uptime:     ${Math.floor(data.uptime/60)}min`,
            `Cycles:     ${data.cycle_count}`,
            `Memories:   ${data.total_memories}`,
            `Branches:   ${data.branches_active} active`,
            `Last cycle: ${data.last_cycle?.split('T')[1]?.split('.')[0] || 'N/A'}`,
          ].join('\n'));
        } catch(e) { print(`❌ Brain unreachable: ${e.message}`); }
        break;
      }
      if (args === 'opportunities') {
        try {
          const raw = await httpGet(`${CONFIG.brainUrl}/opportunities`, { 'x-bridge-key': CONFIG.bridgeKey });
          const data = JSON.parse(raw);
          print(`💡 TOP OPPORTUNITIES (${data.count}):`);
          data.items.slice(0,5).forEach(i =>
            print(`  [${i.branch}] score=${i.score?.toFixed(1)} — ${i.content.substring(0,150)}`)
          );
        } catch(e) { print(`❌ ${e.message}`); }
        break;
      }
      print('Brain: /brain status | /brain sync | /brain opportunities');
      break;
    }

    // ── BRANCH ───────────────────────────────────────────────────────────────
    case '/branch': {
      if (args.startsWith('add ')) {
        const parts = args.slice(4).split('|').map(s => s.trim());
        const [slug, name, ...kwds] = parts;
        if (!slug || !name) { print('Usage: /branch add <slug> | <name> | keyword1,keyword2'); break; }
        const keywords = kwds[0] ? kwds[0].split(',').map(s=>s.trim()) : [];
        // Add to local ChromaDB branches
        BRANCHES[slug] = { name, keywords };
        chromaAdd('aikon_os', { insight: `New branch added: ${slug} — ${name}` });
        print(`✅ Branch "${name}" added locally.`);
        // Also add to Brain on Render if configured
        if (CONFIG.brainUrl) {
          try {
            const body = JSON.stringify({ slug, name, keywords, news_queries: [`${name} business 2024`, `${name} automation opportunities`] });
            await new Promise((resolve, reject) => {
              const u = new URL(`${CONFIG.brainUrl}/branch`);
              const req = https.request({
                hostname: u.hostname, port: 443, path: u.pathname,
                method: 'POST',
                headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body), 'x-bridge-key': CONFIG.bridgeKey },
                timeout: 10000
              }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); });
              req.on('error', reject); req.write(body); req.end();
            });
            print(`🧠 Branch also registered with Brain — 24/7 learning starts next cycle.`);
          } catch(e) { print(`⚠️  Local only (Brain sync failed: ${e.message})`); }
        }
        break;
      }
      if (args === 'list') {
        print('📋 LOCAL BRANCHES:');
        Object.entries(BRANCHES).forEach(([k,v]) => print(`  ${k}: ${v.name}`));
        if (CONFIG.brainUrl) {
          try {
            const raw = await httpGet(`${CONFIG.brainUrl}/branches`, { 'x-bridge-key': CONFIG.bridgeKey });
            const data = JSON.parse(raw);
            print(`\n🧠 BRAIN BRANCHES (${data.branches.length}):`);
            data.branches.forEach(b => print(`  ${b.active ? '✅' : '⬜'} ${b.slug}: ${b.name}`));
          } catch(e) {}
        }
        break;
      }
      print('Branch: /branch add <slug> | <Name> | keyword1,keyword2\n        /branch list');
      break;
    }

    case '/shell': {
      if (!args) { print('Usage: /shell <command>'); break; }
      print(`⚙️  Running: ${args}`);
      print(runShell(args));
      break;
    }

    case '/migrate': {
      const dest = args || 'D:\\AIKON-OS';
      print(`⏳ Migrating AIKON-OS F:\\AIKON-OS → ${dest}...`);
      print(runShell(`xcopy "F:\\AIKON-OS" "${dest}" /E /I /H /Y`));
      print(runShell(`dir "${dest}" /B`));
      print(`✅ Done.`);
      log(`MIGRATE: F:\\AIKON-OS → ${dest}`);
      break;
    }

    case '/note':  { if (!args) { print('Usage: /note <text>'); break; } remember('note', args); print('📝 Noted: ' + args); break; }
    case '/notes': { const n = memory.filter(m => m.role === 'note'); n.length ? n.slice(-20).forEach(x => print(`  [${x.ts.split('T')[0]}] ${x.content}`)) : print('No notes.'); break; }
    case '/clear': { console.clear(); printBanner(); break; }

    case '/help': {
      print(`
COMMANDER v${CONFIG.version} COMMANDS:
  /update              — 🔄 Self-update from GitHub
  /setup deepseek      — ⬇️  Install DeepSeek R1 7b on D: drive (one-time)
  /models              — 🤖 Show loaded models + routing
  /v [seconds]         — 🎙️  Voice input (default 5s)
  /voice on|off|setup  — Voice STT control
  /tts on|off|check    — 🔊 Text-to-speech (Commander talks back)
  /tts say <text>      — Speak any text aloud now
  /wake on|off|check   — 👂 Wake word ("Commander" triggers listening)
  /notify <msg>        — 📱 Push notification to your phone (ntfy.sh)
  /notify test         — Test push notification
  /team                — 🤖 List teams (Trader/Biz/Research/Roblox)
  /team <key> <task>   — Run a team on a task
  /trader, /report     — 📊 Live trader status
  /learn               — 🧠 Run background learn cycle now
  /memory [branch]     — 📚 Show ChromaDB memory
  /chroma [branch]     — 📚 Same as /memory
  /opportunities       — 💡 Opportunity scan + history
  /scout               — 💡 Same as /opportunities
  /approvals           — ⏳ Show pending approvals
  /approve <id>        — ✅ Approve a queued action
  /deny <id>           — 🚫 Deny a queued action
  /bridge status|history|send — 🌉 Bridge control
  /brain status|sync|opportunities — 🧠 Brain (Render 24/7) control
  /branch add|list     — 🌿 Manage business branches
  /status              — 🖥️  Full system status
  /shell <cmd>         — ⚙️  Run shell command
  /note <text>         — 📝 Save a note
  /notes               — Show notes
  /clear               — Clear screen
  /exit                — Quit

Teams: trader | biz | research | roblox
Branches: trader | roblox | agency | aikon_os | opportunities

SETUP (one-time):
  TTS:       pip install pyttsx3
  Wake word: pip install vosk sounddevice
             Download: alphacephei.com/vosk/models → vosk-model-small-en-us
             Extract to: D:\\AIKON-OS\\models\\vosk-model-small-en-us
  Push ntfy: setx NTFY_TOPIC "aikon-commander-<yourname>"
             Install ntfy app → subscribe to your topic
`);
      break;
    }

    case '/exit':
    case '/quit': {
      await bridgeSend('status', 'Commander going offline', 'claude');
      print('Commander offline. AIKON-OS standing by.');
      log('COMMANDER: shutdown');
      if (rl) rl.close();
      process.exit(0);
    }

    default:
      print(`Unknown command: ${cmd}. Type /help`);
  }
}

// ─── BANNER ───────────────────────────────────────────────────────────────────
function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║       AIKON-OS COMMANDER v${CONFIG.version}                      ║
║       Al iKon Unlimited LLC  🧠 🎙️ 🔊 📱 🤖        ║
╠══════════════════════════════════════════════════════╣
║  Trader:   xauusd-trader-80p0.onrender.com           ║
║  Models:   phi3:mini → deepseek-r1:7b (routing)      ║
║  Brain:    Render 24/7 learner (all businesses)       ║
║  Teams:    Trader | Biz | Research | Roblox           ║
╠══════════════════════════════════════════════════════╣
║  /tts on  |  /wake on  |  /notify test  |  /update   ║
╚══════════════════════════════════════════════════════╝
`);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function backgroundStartup() {
  log(`COMMANDER: startup v${CONFIG.version}`);
  loadChroma();

  setTimeout(async () => {
    try {
      const s = JSON.parse(await httpGet(CONFIG.traderUrl));
      print(`\n📡 Trader online — $${s.balance?.toFixed(2) ?? '?'} | ${s.status ?? 'unknown'}`);
    } catch(e) { print(`\n⚠️  Trader unreachable (${e.message})`); }
  }, 1500);

  // DeepSeek auto-detect with retry — Ollama needs time to initialize after reboot
  async function autoDetectDeepseek(attempt = 1) {
    const dsReady = await checkDeepseek();
    if (dsReady) {
      CONFIG.deepseekReady = true;
      print('🤖 DeepSeek R1 ready — smart routing active');
    } else if (attempt < 6) {
      // Retry every 15s for up to 75s
      setTimeout(() => autoDetectDeepseek(attempt + 1), 15000);
      if (attempt === 1) print('⏳ DeepSeek not ready yet — will retry automatically...');
    } else {
      print('💡 DeepSeek not loaded. Run /setup deepseek to enable reasoning mode.');
    }
  }
  setTimeout(() => autoDetectDeepseek(), 5000);

  setTimeout(() => {
    const total = Object.entries(chromaMemory.collections).reduce((a,[,v]) => a + v.length, 0);
    print(`📚 Chroma loaded — ${total} indexed entries across ${Object.keys(chromaMemory.collections).length} branches`);
  }, 2500);

  if (CONFIG.bridgeUrl && CONFIG.bridgeKey) {
    setTimeout(async () => {
      await bridgeSend('status',
        `Commander v${CONFIG.version} online. Learning layer active. Voice + DeepSeek routing enabled.`, 'claude');
      print('📡 Bridge: online — announced to Claude');
    }, 3000);
  }

  setTimeout(() => {
    if (!whisperAvailable()) {
      print('⚠️  Whisper not found. Run:  pip install openai-whisper sounddevice soundfile numpy');
    } else {
      print('🎙️  Voice ready. /v to speak.');
    }
  }, 3500);

  // Sync from Brain (Render 24/7 learner) — picks up everything missed while Thomas was off
  setTimeout(async () => {
    if (CONFIG.brainUrl) {
      await syncFromBrain();
    } else {
      print('💡 Set BRAIN_URL env var to enable 24/7 cloud learning sync.');
    }
  }, 5000);

  // TTS startup check
  setTimeout(() => {
    if (ttsAvailable()) {
      print('🔊 TTS ready — /tts on to enable voice responses');
      if (CONFIG.ttsEnabled) speak('Commander online. All systems ready.');
    } else {
      print('💡 TTS not set up. Run: pip install pyttsx3  then /tts check');
    }
  }, 4000);

  // Push notifications check
  setTimeout(() => {
    if (CONFIG.ntfyTopic) {
      print(`📱 Push notifications active — topic: ${CONFIG.ntfyTopic}`);
      notify('Commander Online', `v${CONFIG.version} started. All systems ready.`, 'low');
    } else {
      print('💡 Push notifications: set NTFY_TOPIC env var + install ntfy app');
    }
  }, 4500);

  // Wake word — start if enabled
  setTimeout(() => {
    if (CONFIG.wakeEnabled) startWakeWord();
    else print('💡 Wake word available — /wake on (requires vosk + model download)');
  }, 6000);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout,
    terminal: process.stdout.isTTY || true, prompt: '> '
  });

  rl.prompt();

  rl.on('line', async input => {
    input = input.trim();
    if (!input) { rl.prompt(); return; }
    log(`INPUT: ${input}`);

    if (input.startsWith('/')) {
      await handleCommand(input, rl);
    } else {
      print('🤔 Thinking...');
      remember('user', input);
      try {
        const { reply, model } = await askOllama(input, memory.filter(m => m.role !== 'note'));
        print(`\nCommander [${model}]: ${reply}\n`);
        remember('assistant', reply);
        log(`OLLAMA [${model}]: ${reply.substring(0,200)}`);
      } catch(e) { print(`❌ Ollama error: ${e.message}`); }
    }
    rl.prompt();
  });

  rl.on('close', () => { print('Commander offline.'); process.exit(0); });

  backgroundStartup();
  startBridgeLoop();
  startLearner();

  // Health + HUD WebSocket server + Phone relay
  const healthPort = process.env.COMMANDER_PORT || 3000;
  const healthServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-bridge-key');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: CONFIG.version, uptime: Math.floor(process.uptime()) }));

    } else if (req.url === '/message' && req.method === 'POST') {
      // Phone PWA / Bridge relay — receives a message string, runs handleCommand, returns response
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { message } = JSON.parse(body);
          if (!message) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'No message'})); return; }
          // Capture output by temporarily overriding print
          const lines = [];
          const origPrint = global._phonePrintHook;
          global._phonePrintHook = (msg) => lines.push(msg);
          // Process the command (use the existing rl-less path for voice commands)
          try {
            await handleCommand(message, null);
          } catch(e) { lines.push('Error: ' + e.message); }
          global._phonePrintHook = origPrint;
          const response = lines.join('\n') || 'Command received.';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response, ok: true }));
        } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ error: e.message }));
        }
      });

    } else {
      res.writeHead(404); res.end();
    }
  });

  // WebSocket for JARVIS HUD live feed
  if (WebSocketServer) {
    const wss = new WebSocketServer({ server: healthServer });
    wss.on('connection', (ws) => {
      hudClients.add(ws);
      // Send initial snapshot
      ws.send(JSON.stringify({ t: 'hello', version: CONFIG.version, uptime: Math.floor(process.uptime()), ts: Date.now() }));
      ws.on('close', () => hudClients.delete(ws));
      ws.on('error', () => hudClients.delete(ws));
    });
    // Broadcast live stats every 5s
    setInterval(() => {
      hudBroadcast('stats', {
        version: CONFIG.version,
        uptime: Math.floor(process.uptime()),
        deepseek: CONFIG.deepseekReady || false,
        tts: CONFIG.ttsAvail || false,
        wake: CONFIG.wakeActive || false,
        brain: CONFIG.brainConnected || false,
        clients: hudClients.size,
      });
    }, 5000);
    log(`HEALTH: WebSocket HUD feed enabled`);
  }

  healthServer.listen(healthPort, '0.0.0.0', () => {
    log(`HEALTH: listening on port ${healthPort}`);
  });
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
