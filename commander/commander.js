#!/usr/bin/env node
// AIKON-OS Commander v3.24 — Tiered Ollama: Phi-3 fast path, DeepSeek heavy reasoning only:
//   HMAC signing, replay prevention, rate limiting, IP allowlist, token expiry,
//   shell whitelist, process watchdog, tamper-evident logs, encrypted backup, kill switch
// Location: D:\AIKON-OS\commander\commander.js
// Start: node D:\AIKON-OS\commander\commander.js
// Update: /update  — pulls latest from GitHub and restarts

const readline  = require('readline');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { execSync, spawn } = require('child_process');

// Load .env from D:\AIKON-OS\.env so BRAIN_URL/BRIDGE_KEY survive restarts
(function loadEnv() {
  const envPath = path.join('D:\\AIKON-OS', '.env');
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch(e) { /* .env not found — env vars must be set externally */ }
})()

// WebSocket — built-in ws module (ship ws in package.json, fallback to no-ws)
let WebSocketServer = null;
try { WebSocketServer = require('ws').Server; } catch(e) { /* ws not installed — HUD disabled */ }

// Live HUD broadcast — all connected WebSocket clients + Brain relay (HTTP POST)
const hudClients = new Set();
function hudBroadcast(type, payload) {
  const msg = JSON.stringify({ t: type, ts: Date.now(), ...payload });
  // Local WS clients (direct connections)
  for (const ws of hudClients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch(e) { hudClients.delete(ws); }
  }
  // Brain relay — enqueue for next HTTP POST (fire-and-forget)
  if (CONFIG.brainConnected && CONFIG._relayQueue) {
    CONFIG._relayQueue.push(JSON.parse(msg));
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
  version:       '3.24',
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
    trader:   { name: 'Trader Team',   model: 'deepseek-r1:7b', branch: 'trader',         active: true },
    biz:      { name: 'Biz Team',      model: 'deepseek-r1:7b', branch: 'opportunities',  active: true },
    research: { name: 'Research Team', model: 'phi3:mini',       branch: 'opportunities',  active: true },
    roblox:   { name: 'Roblox Team',   model: 'phi3:mini',       branch: 'roblox',         active: true },
    social:   { name: 'Social Team',   model: 'phi3:mini',       branch: 'social',         active: true },
  },
  // Social Media — credentials loaded from env, never hardcoded
  social: {
    tiktok: {
      handle:   '@al.ikon.unlimited',
      focus:    'Al iKon Unlimited LLC brand — Roblox, KnowYourBallot, business tips',
      apiKey:   process.env.TIKTOK_CLIENT_KEY    || '',
      apiSecret:process.env.TIKTOK_CLIENT_SECRET || '',
      accessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
    },
    twitter: {
      handle:      '@Al_ikonunltd',
      focus:       'Al iKon Unlimited LLC — business, tech, Roblox, trading insights',
      apiKey:      process.env.TWITTER_API_KEY        || '',
      apiSecret:   process.env.TWITTER_API_SECRET     || '',
      accessToken: process.env.TWITTER_ACCESS_TOKEN   || '',
      accessSecret:process.env.TWITTER_ACCESS_SECRET  || '',
      bearerToken: process.env.TWITTER_BEARER_TOKEN   || '',
    },
    instagram: {
      accounts: {
        alikon_marketing: { handle: 'alikon_marketing', focus: 'Al iKon Unlimited LLC marketing', accessToken: process.env.IG_ALIKON_TOKEN || '' },
        onairnetwork_inc: { handle: 'onairnetwork_inc', focus: 'StreamNet / OnAir Network streaming hub', accessToken: process.env.IG_ONAIR_TOKEN  || '' },
        tjsdemoreels:     { handle: 'tjsdemoreels',     focus: 'Personal/demo reel — creative showcase',  accessToken: process.env.IG_TJS_TOKEN   || '' },
      },
    },
    // Autonomous post queue — Social Team drops packages here, Commander deploys
    postQueue: [],
    // Last run timestamp per platform
    lastRun: {},
  },
  // Approval queue — big decisions wait here
  pendingApprovals: [],
  // ── MOVEMENT LEARNING ─────────────────────────────────────────────────────
  // Commander observes Al iKon's activity patterns to learn timing, preferences,
  // and decision style. Used to anticipate needs and time autonomous actions.
  movement: {
    file:         path.join('D:\\AIKON-OS', 'memory', 'movement.json'),
    sessions:     [],       // { ts, hour, day, action, context, duration }
    hourlyActive: Array(24).fill(0),  // activity count per hour of day
    dailyActive:  Array(7).fill(0),   // activity count per day of week
    decisionLog:  [],       // { ts, type, approved, timeToDecide }
    lastSeen:     null,     // last phone/terminal activity timestamp
    awayThreshMs: 1800000,  // 30min without activity = away
    patterns:     {},       // learned: peak hours, avg decision time, etc.
  },
  deepseekReady: false,
  // ── SECURITY PROTOCOL LAYER ────────────────────────────────────────────────
  security: {
    enabled:          true,
    lockoutFile:      path.join('D:\\AIKON-OS', 'security', 'lockout.json'),
    auditFile:        path.join('D:\\AIKON-OS', 'security', 'audit.log'),
    threatFile:       path.join('D:\\AIKON-OS', 'security', 'threats.json'),
    failedAttempts:   {},         // IP/source → count
    lockedSources:    new Set(),  // blocked sources
    maxFails:         5,          // S-01: brute-force threshold
    keyRotateMs:      86400000,   // S-04: 24hr key rotation window check
    lastKeyCheck:     0,
    anomalyLog:       [],         // S-06: anomaly events
    integrityHashes:  {},         // S-07: file hash registry
    ragLog:           [],         // S-08: RAG access log
    encryptionFlag:   true,       // S-09: data-at-rest flag
    threatLevel:      'GREEN',    // S-10: GREEN / YELLOW / RED
    // ── S-11 through S-20 ───────────────────────────────────────────────────
    hmacSecret:       process.env.HMAC_SECRET || process.env.BRIDGE_KEY || 'default-change-me',
    usedNonces:       new Set(),   // S-12: replay prevention nonce store
    nonceTtlMs:       300000,      // S-12: nonces expire after 5 min
    nonceLog:         [],          // S-12: timestamp-keyed nonce entries
    rateLimitMap:     {},          // S-13: IP → { count, windowStart }
    rateLimitMax:     60,          // S-13: max requests per window
    rateLimitWindowMs:60000,       // S-13: 1-minute window
    ipAllowlist:      new Set(['127.0.0.1','::1','::ffff:127.0.0.1']), // S-14
    ipAllowlistEnabled: false,     // S-14: off until user adds IPs
    sessionTokens:    {},          // S-15: token → { created, expires, source }
    tokenTtlMs:       86400000,    // S-15: tokens expire after 24hr
    shellWhitelist:   [            // S-16: allowed /shell command prefixes
      'node --version', 'node -e', 'npm list', 'npm run',
      'git status', 'git log', 'git pull', 'git diff',
      'dir ', 'ls ', 'type ', 'cat ',
      'ping ', 'curl --head', 'netstat',
      'tasklist', 'wmic', 'systeminfo',
      'ollama list', 'ollama ps',
    ],
    shellBlocklist:   [            // S-16: always blocked regardless of whitelist
      'rm ', 'del ', 'rmdir', 'format', 'shutdown', 'reboot',
      'reg delete', 'reg add', 'netsh', 'iptables',
      'dd if=', 'mkfs', '> /dev/', 'wget ', 'curl -O',
      'powershell -enc', 'cmd /c', '&& del', '| del',
    ],
    watchdogPid:      process.pid, // S-17: our own PID for watchdog
    watchdogFile:     path.join('D:\\AIKON-OS','security','watchdog.json'),
    lastWatchdogPing: 0,           // S-17: last heartbeat write
    auditChainHash:   '',          // S-18: rolling hash of audit log
    auditChainFile:   path.join('D:\\AIKON-OS','security','audit.chain'),
    backupDir:        'E:\\AIKON-OS-BACKUP',  // S-19: encrypted backup destination
    backupIntervalMs: 3600000,     // S-19: backup every hour
    lastBackup:       0,
    killswitchArmed:  false,       // S-20: requires /killswitch arm first
  },
  // ── INTELLIGENCE PROTOCOL LAYER ───────────────────────────────────────────
  intel: {
    ragSources:       [],         // I-02: indexed knowledge documents
    sentimentHistory: [],         // I-04: market sentiment log
    patternLog:       [],         // I-05: detected patterns
    forecastLog:      [],         // I-06: forecast snapshots
    kpiSnapshot:      {},         // I-07: live KPI cache
    competitorLog:    [],         // I-08: competitor/market scan log
    decisionLog:      [],         // I-09: Commander decisions for review
    feedUrls: [                   // I-03: free live feeds
      'https://feeds.finance.yahoo.com/rss/2.0/headline?s=XAUUSD=X&region=US&lang=en-US',
      'https://www.investing.com/rss/news_25.rss',
    ],
    scanInterval:     900000,     // I-01: deep scan every 15 min
    lastScan:         0,
  },
  // ── COMMUNICATION PROTOCOL LAYER ──────────────────────────────────────────
  comms: {
    webhookUrl:       process.env.WEBHOOK_URL || '',   // C-02: outbound webhook
    slackUrl:         process.env.SLACK_URL   || '',   // C-03: Slack webhook
    discordUrl:       process.env.DISCORD_URL || '',   // C-04: Discord webhook
    emailEnabled:     false,                            // C-05: SMTP alert (future)
    broadcastLog:     [],                               // C-01: all outbound msgs
    peerNodes:        [],                               // C-07: peer Commander nodes
    heartbeatMs:      60000,                            // C-08: peer heartbeat
    lastHeartbeat:    {},                               // C-08: per-peer ts
    messageQueue:     [],                               // C-09: outbound queue
    maxQueueSize:     100,
    channelPriority:  ['ntfy','webhook','slack','discord'], // C-10: delivery order
  },
  // ── AUTONOMY ENGINE ───────────────────────────────────────────────────────
  autonomy: {
    enabled:          true,
    loopIntervalMs:   900000,       // master loop every 15 min
    selfAskIntervalMs:3600000,      // AI self-questions every 1 hr
    dailyReportHour:  8,            // daily summary push at 8am local
    weeklyReportDay:  1,            // Monday = 1
    lastDailyReport:  0,
    lastWeeklyReport: 0,
    lastSelfAsk:      0,
    lastLoopRun:      0,
    loopCount:        0,
    decisionQueue:    [],           // pending autonomous actions
    selfAskHistory:   [],           // questions Commander asked itself
    incidentCount:    0,
    reportDir:        'F:\\AIKON-OS\\logs\\reports',
    // AI peers Commander can query
    aiPeers: [
      { id: 'ollama-local',  type: 'ollama',  url: 'http://localhost:11434', model: 'phi3:mini',       active: true  },
      { id: 'deepseek-local',type: 'ollama',  url: 'http://localhost:11434', model: 'deepseek-r1:7b',  active: false },
      { id: 'claude-api',    type: 'groq',    url: 'https://api.groq.com',       model: 'llama-3.1-8b-instant', active: true },
    ],
    // Questions Commander asks itself autonomously
    selfAskTopics: [
      // ── 20 FROM CLAUDE (deep reasoning, business-specific) ──────────────────
      // XAU/USD Trader
      'The XAU/USD trader has a 25% win rate and scalp-only mode. What specific entry filter changes would raise win rate above 40%?',
      'The trader fires low-confidence scalps at 45% confidence with RSI 95 overbought. What minimum confidence floor and RSI gate would prevent these bad entries?',
      'HTF conflict (H1/H4 bullish, D1 bearish) locks out swing/day/intraday modes. How should Commander auto-detect and report HTF conflict to Al iKon each session?',
      'The FundedNext Step 2 account has a 3% daily loss limit ($150/day) and $4,600 max loss floor. How should Commander auto-pause the trader when daily loss hits $120 as a buffer?',
      'XAU/USD scalp trades lose 75% of the time. What 3 technical conditions (RSI, spread, session time) should ALL be met before any scalp entry fires?',
      // Silent Santa Roblox
      'Silent Santa has gamepasses (Golden Sleigh 75R$, Nice List Plus 150R$) and an ad campaign live. What daily metrics should Commander pull from Roblox Analytics and report to Al iKon?',
      'Silent Santa needs a leaderboard and cosmetic items added this week. Break this into the 3 smallest Luau script changes that deliver visible player-facing value fastest.',
      'Roblox holiday traffic peaks Christmas week. What retention mechanic (login streak, daily gift, limited event) would have the highest impact on D1/D7 retention for Silent Santa?',
      'Silent Santa runs ads targeting All Players. What audience split test (All vs Under-13 vs 13-17) would reveal the best-converting segment for Christmas game marketing?',
      'The belief meter in Silent Santa makes reindeer faster with good play. How should Commander monitor Roblox visit count and avg session length daily and alert when either drops 20%?',
      // StreamNet / OnAir Network
      'The Instagram post pipeline uses IG_ONAIR_TOKEN for onairnetwork_inc. What 3-step daily content schedule (post type, time, caption formula) maximizes Reel reach for a streaming hub?',
      'The alikon_marketing IG account has no token yet. What is the fastest path to get a Page Access Token for it using the existing Meta App setup?',
      'StreamNet is a Twitch/YouTube hub. What automated clip-surfacing workflow (pull top clip → post to IG Reels → log engagement) can Commander run daily with zero manual steps?',
      // Restaurant Web Agency
      'The restaurant web agency targets Columbus-area restaurants. What 5 outreach signals (new Google Maps listing, Yelp review surge, no website, low star rating, holiday hours posted) indicate a hot prospect Commander should alert Al iKon about?',
      'Restaurant websites need recurring revenue. What service tier (hosting + updates + social posts for $99/mo) could Commander auto-invoice and track via Google Sheets with no manual work?',
      // Cross-business systems
      'Al iKon has 8GB RAM on Thomas and runs Ollama. What RAM allocation rule (Ollama cap, Commander limit, OS reserve) keeps the system stable under full load without swapping?',
      'Commander needs to push notifications to Al iKon\'s phone via ntfy.sh. What 5 event types (trade loss streak, Roblox visit drop, IG post failure, Brain down, daily report ready) should trigger a push?',
      'The autonomous loop runs every 15 minutes. What lightweight health check (trader ping, Brain ping, Roblox analytics pull, IG token validity) should run every loop without overloading Thomas?',
      'Commander has a decision queue for actions needing Al iKon sign-off. What 4 categories of decisions (spend money, push code, post publicly, contact a business) should always require approval before executing?',
      'AIKON-OS has ChromaDB for vector memory. What tagging schema (branch, source, confidence, date, outcome) on each chromaAdd call makes future semantic queries most accurate and useful?',
      // ── 20 FROM EXTERNAL SOURCES (live systems, public knowledge) ───────────
      // Trading mechanics (public knowledge)
      'What is the RSI divergence pattern on XAU/USD and how is it identified on a 15-minute chart when price makes a higher high but RSI makes a lower high?',
      'What are the three London session time windows (pre-open, open, close) in UTC, and why does XAU/USD volatility typically spike at each one?',
      'What is the difference between a scalp trade (target <10 pips) and an intraday trade (target 20-50 pips) in terms of stop loss placement on XAU/USD?',
      'What are the key US economic news events (NFP, CPI, FOMC) that cause XAU/USD spreads to widen, and what is the safest rule for avoiding trades 5 minutes before each?',
      'What is a prop firm funded account daily drawdown rule and how does a 3% daily loss limit work on a $5,000 account with a $10,000 starting balance?',
      // Roblox game development (public knowledge)
      'What is the Roblox DataStore API and how does a Luau script save and load a player\'s coin balance across sessions using DataStoreService:GetDataStore()?',
      'What is Roblox\'s PlayerAdded event and how should a game script use it to initialize a new player\'s stats (health, coins, level) when they join a server?',
      'What are the top 3 Roblox monetization methods (gamepasses, developer products, subscriptions) and what is the Robux-to-USD conversion rate developers receive after Roblox\'s 30% cut?',
      'What is Roblox\'s Creator Hub analytics dashboard and what 5 metrics (visits, playtime, revenue, DAU, retention) should a game developer check daily to judge a game\'s health?',
      'What is the Roblox TweenService and how is it used to smoothly animate a part moving from position A to position B over 2 seconds in Luau?',
      // Instagram / Meta Graph API (public knowledge)
      'What is the difference between a Facebook Page Access Token and a User Access Token in the Meta Graph API, and why does Instagram posting require a Page token?',
      'What is the Meta Graph API endpoint for creating an Instagram Reel media container, and what fields (video_url, caption, media_type) are required in the POST request?',
      'What is the Instagram Graph API rate limit for media publishing, and how many posts per 24-hour period can a Business account publish via the API before hitting the limit?',
      'What is the best caption formula for an Instagram Reel from a streaming/gaming hub account to maximize reach: hook length, hashtag count, and CTA placement?',
      'What is Meta\'s webhook system for Instagram and how can Commander subscribe to get notified when a Reel is published, liked, or commented on without polling?',
      // Node.js / system skills (public knowledge)
      'What is the Node.js child_process spawn vs exec difference, and when should Commander use spawn (long-running process) vs exec (one-shot command) for running shell tasks?',
      'What is the ntfy.sh API and how does a Node.js script send a push notification to a topic using a simple HTTP POST with a text body and priority header?',
      'What is SQLite\'s WAL (Write-Ahead Logging) mode and how does enabling it with PRAGMA journal_mode=WAL improve concurrent read/write performance for Commander\'s memory.json replacement?',
      'What is the Windows Task Scheduler schtasks command syntax to check if a task is running, start it manually, and delete it, using the task name "AIKON-OS Commander"?',
      'What is an exponential backoff retry pattern in Node.js and how should Commander implement it when retrying a failed Brain relay connection (1s, 2s, 4s, 8s, max 60s)?',
    ],
    topicIndex: 0,
  },
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

// ═══════════════════════════════════════════════════════════════════════════════
// ══  SECURITY PROTOCOLS  S-01 through S-10  ════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// S-01: Brute-force / access lockout — track failed calls by source key
function secTrackFail(source) {
  const s = CONFIG.security;
  s.failedAttempts[source] = (s.failedAttempts[source] || 0) + 1;
  if (s.failedAttempts[source] >= s.maxFails) {
    s.lockedSources.add(source);
    secAudit(`LOCKOUT`, `Source ${source} locked after ${s.failedAttempts[source]} failures`);
    setThreatLevel('YELLOW', `Lockout triggered: ${source}`);
    sendComms(`🔒 SECURITY LOCKOUT: ${source} blocked after repeated failures`, 'security');
  }
}
function secIsLocked(source) { return CONFIG.security.lockedSources.has(source); }
function secResetFails(source) { delete CONFIG.security.failedAttempts[source]; CONFIG.security.lockedSources.delete(source); }

// S-02: Audit trail — every command and action is logged with timestamp + source
function secAudit(event, detail, source = 'commander') {
  const entry = `[${new Date().toISOString()}] [${event}] [${source}] ${detail}`;
  log(`AUDIT: ${entry}`);
  try {
    const dir = path.dirname(CONFIG.security.auditFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(CONFIG.security.auditFile, entry + '\n');
  } catch(e) {}
  CONFIG.security.anomalyLog.push({ ts: Date.now(), event, detail, source });
  if (CONFIG.security.anomalyLog.length > 500) CONFIG.security.anomalyLog = CONFIG.security.anomalyLog.slice(-500);
}

// S-03: Input sanitization — strip shell injection from any string Commander acts on
function secSanitize(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[;&|`$><\\]/g, '').substring(0, 2000);
}

// S-04: Key rotation check — warn if .env hasn't changed in >24h (reminder only, no auto-change)
function secKeyRotationCheck() {
  const s = CONFIG.security;
  const now = Date.now();
  if (now - s.lastKeyCheck < s.keyRotateMs) return;
  s.lastKeyCheck = now;
  try {
    const stat = fs.statSync('D:\\AIKON-OS\\.env');
    const ageMs = now - stat.mtimeMs;
    if (ageMs > s.keyRotateMs * 7) { // >7 days
      const days = Math.floor(ageMs / 86400000);
      print(`🔑 [S-04] Key rotation reminder: .env unchanged for ${days} days. Consider rotating BRIDGE_KEY.`);
      secAudit('KEY_AGE_WARNING', `.env unchanged for ${days} days`);
    }
  } catch(e) {}
}

// S-05: Sensitive data masking — masks keys/tokens before logging or printing
function secMask(text) {
  return text.replace(/([A-Za-z0-9_-]{20,})/g, (m) => m.substring(0,4) + '****' + m.slice(-4));
}

// S-06: Anomaly detection — flag unusual patterns (high error rate, unexpected URLs)
function secCheckAnomaly(event, value) {
  const recentErrors = CONFIG.security.anomalyLog.filter(e => e.ts > Date.now() - 300000 && e.event.includes('ERR'));
  if (recentErrors.length >= 10) {
    setThreatLevel('YELLOW', `High error rate: ${recentErrors.length} errors in 5 min`);
    secAudit('ANOMALY', `High error rate detected: ${recentErrors.length} in 5min`);
  }
}

// S-07: File integrity check — hash key files; alert if they change unexpectedly
function secIntegrityCheck() {
  const files = [
    path.join(__dirname, 'commander.js'),
    path.join(__dirname, 'claude-poller.js'),
  ];
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      const hash = content.length + ':' + content.slice(0, 64).replace(/\s/g,'');
      if (CONFIG.security.integrityHashes[f] && CONFIG.security.integrityHashes[f] !== hash) {
        secAudit('INTEGRITY_CHANGE', `File changed outside /update: ${path.basename(f)}`);
        print(`⚠️  [S-07] File changed outside /update: ${path.basename(f)}`);
      }
      CONFIG.security.integrityHashes[f] = hash;
    } catch(e) {}
  }
}

// S-08: RAG access control — log every memory read with who asked
function secRagLog(branch, query, source = 'user') {
  CONFIG.security.ragLog.push({ ts: new Date().toISOString(), branch, query: query.substring(0,80), source });
  if (CONFIG.security.ragLog.length > 200) CONFIG.security.ragLog = CONFIG.security.ragLog.slice(-200);
}

// S-09: Data-at-rest flag — log that sensitive memory is on encrypted D: drive
function secDataAtRest(action) {
  secAudit('DATA_AT_REST', `${action} — memory path: ${CONFIG.chromaFile}`);
}

// S-10: Threat level management — GREEN / YELLOW / RED; RED triggers full lockdown mode
function setThreatLevel(level, reason) {
  const prev = CONFIG.security.threatLevel;
  CONFIG.security.threatLevel = level;
  if (level !== prev) {
    secAudit('THREAT_LEVEL', `${prev} → ${level}: ${reason}`);
    const emoji = level === 'RED' ? '🚨' : level === 'YELLOW' ? '⚠️' : '✅';
    print(`${emoji} [S-10] THREAT LEVEL: ${prev} → ${level} | ${reason}`);
    if (level === 'RED') {
      sendComms(`🚨 AIKON-OS THREAT LEVEL RED: ${reason}`, 'security');
      print(`🔴 RED ALERT: Commander entering defensive mode. All external actions require manual /approve.`);
    }
    // AUTO: chain threat response (autonomousThreatResponse defined in autonomy engine)
    if (typeof autonomousThreatResponse === 'function') {
      autonomousThreatResponse(level).catch(e => log(`THREAT_CHAIN_ERR: ${e.message}`));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ══  ANTI-HACKING SECURITY  S-11 through S-20  ═════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// S-11: HMAC request signing — sign/verify Bridge payloads to prevent tampering
function secHmacSign(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', CONFIG.security.hmacSecret).update(body).digest('hex');
}
function secHmacVerify(payload, signature) {
  const expected = secHmacSign(payload);
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// S-12: Nonce / replay prevention — reject duplicate or stale requests
function secCheckNonce(nonce, ts) {
  const now = Date.now();
  if (!nonce || !ts) return false;
  if (Math.abs(now - Number(ts)) > CONFIG.security.nonceTtlMs) return false; // too old
  if (CONFIG.security.usedNonces.has(nonce)) return false; // replay
  CONFIG.security.usedNonces.add(nonce);
  CONFIG.security.nonceLog.push({ nonce, ts: now });
  return true;
}
function secPruneNonces() {
  const cutoff = Date.now() - CONFIG.security.nonceTtlMs;
  CONFIG.security.nonceLog = CONFIG.security.nonceLog.filter(n => n.ts > cutoff);
  CONFIG.security.usedNonces = new Set(CONFIG.security.nonceLog.map(n => n.nonce));
}

// S-13: Rate limiter — max 60 req/min per IP on port 3000
function secRateLimit(ip) {
  const now = Date.now();
  let entry = CONFIG.security.rateLimitMap[ip];
  if (!entry || now - entry.windowStart > CONFIG.security.rateLimitWindowMs) {
    CONFIG.security.rateLimitMap[ip] = { count: 1, windowStart: now };
    return true; // allow
  }
  entry.count++;
  if (entry.count > CONFIG.security.rateLimitMax) {
    secAudit('RATE_LIMIT', `IP ${ip} exceeded ${CONFIG.security.rateLimitMax} req/min`);
    return false; // deny
  }
  return true;
}

// S-14: IP allowlist — only trusted IPs can talk to Commander's local port
function secCheckIP(ip) {
  if (!CONFIG.security.ipAllowlistEnabled) return true;
  const ok = CONFIG.security.ipAllowlist.has(ip);
  if (!ok) secAudit('IP_BLOCKED', `Rejected connection from ${ip}`);
  return ok;
}
function secAllowIP(ip) {
  CONFIG.security.ipAllowlist.add(ip);
  secAudit('IP_ALLOWED', `Added ${ip} to allowlist`);
  print(`✅ [S-14] IP ${ip} added to allowlist`);
}
function secBlockIP(ip) {
  CONFIG.security.ipAllowlist.delete(ip);
  secAudit('IP_BLOCKED', `Removed ${ip} from allowlist`);
  print(`🚫 [S-14] IP ${ip} removed from allowlist`);
}

// S-15: Session token expiry — tokens expire after 24hr
function secCreateToken(source = 'unknown') {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  CONFIG.security.sessionTokens[token] = {
    created: now,
    expires: now + CONFIG.security.tokenTtlMs,
    source
  };
  secAudit('TOKEN_CREATED', `New session token for ${source}`);
  return token;
}
function secValidateToken(token) {
  const rec = CONFIG.security.sessionTokens[token];
  if (!rec) return false;
  if (Date.now() > rec.expires) {
    delete CONFIG.security.sessionTokens[token];
    secAudit('TOKEN_EXPIRED', `Token from ${rec.source} expired`);
    return false;
  }
  return true;
}
function secPruneTokens() {
  const now = Date.now();
  let pruned = 0;
  for (const [tok, rec] of Object.entries(CONFIG.security.sessionTokens)) {
    if (now > rec.expires) { delete CONFIG.security.sessionTokens[tok]; pruned++; }
  }
  if (pruned) log(`S-15: pruned ${pruned} expired session tokens`);
}

// S-16: Shell command whitelist / blocklist — validate before execSync
function secValidateShellCmd(cmd) {
  if (!cmd || typeof cmd !== 'string') return { ok: false, reason: 'empty command' };
  const lower = cmd.toLowerCase().trim();
  for (const blocked of CONFIG.security.shellBlocklist) {
    if (lower.includes(blocked.toLowerCase())) {
      secAudit('SHELL_BLOCKED', `Blocklisted pattern "${blocked}" in: ${cmd}`);
      return { ok: false, reason: `blocked pattern: ${blocked}` };
    }
  }
  const allowed = CONFIG.security.shellWhitelist.some(prefix =>
    lower.startsWith(prefix.toLowerCase())
  );
  if (!allowed) {
    secAudit('SHELL_REJECTED', `Command not in whitelist: ${cmd}`);
    return { ok: false, reason: 'command not in whitelist' };
  }
  return { ok: true };
}

// S-17: Process watchdog — write heartbeat; alert if Commander dies unexpectedly
function secWatchdogPing() {
  const data = {
    pid: CONFIG.security.watchdogPid,
    ts: Date.now(),
    version: CONFIG.version,
    threat: CONFIG.security.threatLevel
  };
  try {
    const dir = path.dirname(CONFIG.security.watchdogFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.security.watchdogFile, JSON.stringify(data, null, 2));
    CONFIG.security.lastWatchdogPing = Date.now();
  } catch (e) { log(`S-17 watchdog write err: ${e.message}`); }
}
function secWatchdogCheck() {
  try {
    if (!fs.existsSync(CONFIG.security.watchdogFile)) return;
    const data = JSON.parse(fs.readFileSync(CONFIG.security.watchdogFile, 'utf8'));
    const age = Date.now() - data.ts;
    if (age > 120000) { // no ping in 2 min = dead
      sendComms(`⚠️ [S-17] WATCHDOG: Commander PID ${data.pid} missed heartbeat (${Math.round(age/1000)}s ago). May be dead!`, 'security');
    }
  } catch (e) { log(`S-17 watchdog check err: ${e.message}`); }
}

// S-18: Tamper-evident audit log — chained hashes; each entry hashes previous hash + content
function secChainAuditEntry(entry) {
  const content = JSON.stringify(entry);
  const chain = crypto.createHash('sha256')
    .update(CONFIG.security.auditChainHash + content)
    .digest('hex');
  CONFIG.security.auditChainHash = chain;
  const line = JSON.stringify({ ...entry, chain }) + '\n';
  try {
    const dir = path.dirname(CONFIG.security.auditChainFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(CONFIG.security.auditChainFile, line);
  } catch (e) { log(`S-18 chain write err: ${e.message}`); }
  return chain;
}
function secVerifyAuditChain() {
  try {
    if (!fs.existsSync(CONFIG.security.auditChainFile)) return { ok: true, entries: 0 };
    const lines = fs.readFileSync(CONFIG.security.auditChainFile, 'utf8').trim().split('\n').filter(Boolean);
    let runningHash = '';
    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]);
      const { chain, ...rest } = entry;
      const expected = crypto.createHash('sha256')
        .update(runningHash + JSON.stringify(rest))
        .digest('hex');
      if (expected !== chain) return { ok: false, tampered_at: i + 1, entries: lines.length };
      runningHash = chain;
    }
    return { ok: true, entries: lines.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

// S-19: Encrypted backup — hourly ChromaDB snapshot to E: drive (AES-256-CBC)
async function secEncryptedBackup() {
  const now = Date.now();
  if (now - CONFIG.security.lastBackup < CONFIG.security.backupIntervalMs) return;
  CONFIG.security.lastBackup = now;
  try {
    const srcFile = CONFIG.memory.dbPath || path.join('D:\\AIKON-OS', 'chroma', 'memory.json');
    if (!fs.existsSync(srcFile)) { log('S-19: source not found, skipping backup'); return; }
    const plaintext = fs.readFileSync(srcFile);
    const key = crypto.scryptSync(CONFIG.security.hmacSecret, 'aikon-backup-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const backupDir = CONFIG.security.backupDir;
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const filename = `memory_backup_${new Date().toISOString().replace(/[:.]/g,'-')}.enc`;
    const outPath = path.join(backupDir, filename);
    fs.writeFileSync(outPath, Buffer.concat([iv, encrypted]));
    secAudit('BACKUP_OK', `Encrypted backup saved: ${filename}`);
    log(`S-19: backup → ${outPath}`);
    // Prune old backups — keep last 24
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('memory_backup_')).sort();
    while (files.length > 24) {
      fs.unlinkSync(path.join(backupDir, files.shift()));
    }
  } catch (e) {
    secAudit('BACKUP_ERR', e.message);
    log(`S-19 backup error: ${e.message}`);
  }
}

// S-20: Kill switch — wipe tokens, lock all sources, RED alert, page operator
async function secKillSwitch() {
  print(`💀 [S-20] KILL SWITCH FIRED — locking down AIKON-OS`);
  secAudit('KILL_SWITCH', 'Kill switch activated — full lockdown initiated');

  // Wipe all session tokens
  const tokenCount = Object.keys(CONFIG.security.sessionTokens).length;
  CONFIG.security.sessionTokens = {};
  print(`  🗑️  Wiped ${tokenCount} session tokens`);

  // Clear HMAC secret from memory (force key rotation on restart)
  CONFIG.security.hmacSecret = crypto.randomBytes(32).toString('hex');
  print(`  🔑  HMAC secret rotated (restart required to restore from env)`);

  // Enable IP allowlist (block everything not explicitly trusted)
  CONFIG.security.ipAllowlistEnabled = true;
  print(`  🛡️  IP allowlist ENABLED — only localhost allowed`);

  // Max rate limit (1 req/min)
  CONFIG.security.rateLimitMax = 1;
  print(`  🚦 Rate limit set to 1 req/min`);

  // Set threat to RED
  CONFIG.security.threatLevel = 'RED';
  CONFIG.security.failCount = CONFIG.security.lockThreshold; // force locked state
  print(`  🔴 Threat level: RED — lockdown active`);

  // Page operator
  await sendComms(
    `💀 AIKON-OS KILL SWITCH FIRED\n` +
    `Time: ${new Date().toISOString()}\n` +
    `${tokenCount} tokens wiped | IP allowlist ON | Rate limit 1/min\n` +
    `Commander is locked. Restart required to restore.\n` +
    `Check audit chain: ${CONFIG.security.auditChainFile}`,
    'security', 'CRITICAL'
  );

  print(`\n💀 LOCKDOWN COMPLETE. Commander will not accept further commands.`);
  print(`   Restart Commander to restore from clean environment.\n`);

  // Write a lockfile so restart knows we were killed
  try {
    fs.writeFileSync(path.join('D:\\AIKON-OS', 'security', 'KILLSWITCH.lock'),
      JSON.stringify({ fired: Date.now(), reason: 'manual killswitch' }, null, 2));
  } catch (e) { /* non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ══  INTELLIGENCE PROTOCOLS  I-01 through I-10  ════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// I-01: Deep intel scan — runs every 15 min; queries all branches + news
async function intelDeepScan() {
  const now = Date.now();
  if (now - CONFIG.intel.lastScan < CONFIG.intel.scanInterval) return;
  CONFIG.intel.lastScan = now;
  log('INTEL: deep scan starting');
  await learnFromTrader();
  await learnOpportunities();
  intelUpdateKPI();
  intelPatternDetect();
}

// I-02: RAG (Retrieval-Augmented Generation) — enrich Ollama prompts with memory context
function intelRagContext(query, branch, limit = 5) {
  secRagLog(branch, query, 'rag');
  const results = chromaQuery(branch, query, limit);
  if (!results.length) return '';
  return '\n\n[MEMORY CONTEXT]\n' + results.map(r => `• ${r.content}`).join('\n');
}

// I-03: Live feed ingestion — parse RSS/JSON feeds into trader/opportunities branch
async function intelFeedIngestion() {
  for (const url of CONFIG.intel.feedUrls) {
    try {
      const xml = await httpGet(url).catch(() => null);
      if (!xml || typeof xml !== 'string') continue;
      const titles = [...xml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]>/g)].map(m => m[1]);
      const plain  = [...xml.matchAll(/<title>([^<]{10,})<\/title>/g)].map(m => m[1]);
      const items  = [...new Set([...titles, ...plain])].slice(0,5);
      if (items.length) {
        const branch = url.includes('XAU') || url.includes('gold') || url.includes('investing') ? 'trader' : 'opportunities';
        chromaAdd(branch, { insight: 'Feed: ' + items.join(' | '), source: url.substring(0,50) });
        log(`INTEL-FEED: ${items.length} items from ${url.substring(0,40)}`);
      }
    } catch(e) { log(`INTEL_FEED_ERR: ${e.message}`); }
  }
}

// I-04: Sentiment analysis — simple bull/bear word scoring on any text
function intelSentiment(text) {
  const bullWords = ['rally','surge','gains','bullish','breakout','support','buy','strong','recovery','upside'];
  const bearWords = ['drop','fall','crash','bearish','breakdown','resistance','sell','weak','decline','downside'];
  const lower = text.toLowerCase();
  const bull = bullWords.filter(w => lower.includes(w)).length;
  const bear = bearWords.filter(w => lower.includes(w)).length;
  const score = bull - bear;
  const signal = score > 1 ? 'BULLISH' : score < -1 ? 'BEARISH' : 'NEUTRAL';
  const entry = { ts: new Date().toISOString(), text: text.substring(0,100), bull, bear, signal };
  CONFIG.intel.sentimentHistory.push(entry);
  if (CONFIG.intel.sentimentHistory.length > 100) CONFIG.intel.sentimentHistory = CONFIG.intel.sentimentHistory.slice(-100);
  return { bull, bear, score, signal };
}

// I-05: Pattern recognition — detect repeated themes across memory branches
function intelPatternDetect() {
  const all = Object.entries(chromaMemory.collections)
    .flatMap(([,v]) => v.map(e => (e.insight || e.content || '').toLowerCase()));
  const wordCount = {};
  for (const text of all) {
    for (const word of text.split(/\W+/).filter(w => w.length > 5)) {
      wordCount[word] = (wordCount[word] || 0) + 1;
    }
  }
  const top = Object.entries(wordCount).sort((a,b) => b[1]-a[1]).slice(0,10).map(([w,c]) => `${w}(${c})`);
  const pattern = { ts: new Date().toISOString(), topTerms: top };
  CONFIG.intel.patternLog.push(pattern);
  if (CONFIG.intel.patternLog.length > 50) CONFIG.intel.patternLog = CONFIG.intel.patternLog.slice(-50);
  return top;
}

// I-06: Forecast engine — project trader balance trend from last N snapshots
function intelForecast(periods = 5) {
  const col = chromaMemory.collections['trader'] || [];
  const balances = col.slice(-10).map(e => {
    const m = (e.insight||'').match(/balance=\$([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  }).filter(Boolean);
  if (balances.length < 2) return { trend: 'insufficient data', forecast: null };
  const deltas = balances.slice(1).map((b,i) => b - balances[i]);
  const avgDelta = deltas.reduce((a,b) => a+b, 0) / deltas.length;
  const forecast = balances[balances.length-1] + avgDelta * periods;
  const trend = avgDelta > 0 ? '📈 UP' : avgDelta < 0 ? '📉 DOWN' : '➡ FLAT';
  const snap = { ts: new Date().toISOString(), avgDelta: avgDelta.toFixed(2), forecast: forecast.toFixed(2), trend, periods };
  CONFIG.intel.forecastLog.push(snap);
  if (CONFIG.intel.forecastLog.length > 50) CONFIG.intel.forecastLog = CONFIG.intel.forecastLog.slice(-50);
  return snap;
}

// I-07: KPI dashboard — live snapshot of all key metrics
function intelUpdateKPI() {
  const traderCol = chromaMemory.collections['trader'] || [];
  const lastTrader = traderCol.slice(-1)[0];
  const balMatch = lastTrader ? (lastTrader.insight||'').match(/balance=\$([0-9.]+)/) : null;
  const wrMatch  = lastTrader ? (lastTrader.insight||'').match(/winRate=([0-9.N/A]+)/) : null;
  CONFIG.intel.kpiSnapshot = {
    ts:             new Date().toISOString(),
    traderBalance:  balMatch ? parseFloat(balMatch[1]) : null,
    traderWinRate:  wrMatch  ? wrMatch[1] : null,
    memoryEntries:  Object.values(chromaMemory.collections).reduce((a,v) => a+v.length, 0),
    branches:       Object.keys(chromaMemory.collections).length,
    threatLevel:    CONFIG.security.threatLevel,
    uptime:         Math.floor(process.uptime() / 60) + ' min',
    deepseek:       CONFIG.deepseekReady ? 'READY' : 'offline',
    tts:            CONFIG.ttsEnabled ? 'ON' : 'off',
    voice:          CONFIG.voiceEnabled ? 'ON' : 'off',
  };
  return CONFIG.intel.kpiSnapshot;
}

// I-08: Competitor / market scan — search for opportunity signals vs known markets
async function intelMarketScan(topic = 'XAU USD gold trading signals') {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic)}`;
    const html = await httpGet(url).catch(() => '');
    const titles = [...(html.matchAll(/class="result__title"[^>]*>([^<]{5,80})/g) || [])].map(m => m[1].trim()).slice(0,5);
    if (titles.length) {
      const entry = { ts: new Date().toISOString(), topic, results: titles };
      CONFIG.intel.competitorLog.push(entry);
      if (CONFIG.intel.competitorLog.length > 50) CONFIG.intel.competitorLog = CONFIG.intel.competitorLog.slice(-50);
      chromaAdd('opportunities', { insight: `Market scan [${topic}]: ${titles.join(' | ')}`, source: 'duckduckgo_intel' });
    }
    return titles;
  } catch(e) { return []; }
}

// I-09: Decision logger — record every major Commander action for review
function intelLogDecision(action, reasoning, outcome = 'pending') {
  const entry = { ts: new Date().toISOString(), action, reasoning: reasoning.substring(0,200), outcome };
  CONFIG.intel.decisionLog.push(entry);
  if (CONFIG.intel.decisionLog.length > 200) CONFIG.intel.decisionLog = CONFIG.intel.decisionLog.slice(-200);
  chromaAdd('aikon_os', { insight: `DECISION: ${action} — ${reasoning.substring(0,100)}`, source: 'decision_log' });
}

// I-10: Cross-branch synthesis — combine insights from all branches into one summary
async function intelCrossBranchSynth() {
  const branches = Object.keys(chromaMemory.collections);
  const summaries = branches.map(b => {
    const col = chromaMemory.collections[b] || [];
    const last = col.slice(-3).map(e => e.insight || e.content || '').filter(Boolean).join(' | ');
    return last ? `[${b.toUpperCase()}] ${last.substring(0,120)}` : null;
  }).filter(Boolean);
  if (!summaries.length) return 'No cross-branch data yet.';
  const prompt = `Synthesize these AIKON-OS branch summaries into 3 actionable insights for Al iKon:\n${summaries.join('\n')}`;
  const { reply } = await askOllama(prompt, [], CONFIG.deepseekReady ? CONFIG.deepseekModel : null);
  chromaAdd('opportunities', { insight: `[Cross-branch] ${reply.substring(0,300)}`, source: 'cross_branch_synth' });
  intelLogDecision('cross_branch_synth', summaries.join(' | ').substring(0,150));
  return reply;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ══  COMMUNICATION PROTOCOLS  C-01 through C-10  ═══════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// C-01: Broadcast log — all outbound messages recorded before sending
function commsLog(msg, channel, priority = 'normal') {
  CONFIG.comms.broadcastLog.push({ ts: new Date().toISOString(), channel, msg: msg.substring(0,200), priority });
  if (CONFIG.comms.broadcastLog.length > 300) CONFIG.comms.broadcastLog = CONFIG.comms.broadcastLog.slice(-300);
}

// C-02: Outbound webhook — POST any event to a configured webhook URL (Zapier, Make, etc.)
async function commsSendWebhook(payload) {
  if (!CONFIG.comms.webhookUrl) return false;
  try {
    await httpPost(CONFIG.comms.webhookUrl, payload);
    commsLog(JSON.stringify(payload).substring(0,100), 'webhook');
    return true;
  } catch(e) { log(`COMMS_WEBHOOK_ERR: ${e.message}`); return false; }
}

// C-03: Slack notification — POST to Slack incoming webhook
async function commsSendSlack(text) {
  if (!CONFIG.comms.slackUrl) return false;
  try {
    await httpPost(CONFIG.comms.slackUrl, { text: `[AIKON-OS] ${text}` });
    commsLog(text, 'slack');
    return true;
  } catch(e) { log(`COMMS_SLACK_ERR: ${e.message}`); return false; }
}

// C-04: Discord notification — POST to Discord webhook
async function commsSendDiscord(content) {
  if (!CONFIG.comms.discordUrl) return false;
  try {
    await httpPost(CONFIG.comms.discordUrl, { content: `[AIKON-OS] ${content}` });
    commsLog(content, 'discord');
    return true;
  } catch(e) { log(`COMMS_DISCORD_ERR: ${e.message}`); return false; }
}

// C-05: Priority broadcast — sends to all configured channels in priority order; stops at first success
async function sendComms(message, source = 'commander', priority = 'normal') {
  commsLog(message, 'broadcast', priority);
  secAudit('COMMS_OUT', message.substring(0,80), source);
  for (const channel of CONFIG.comms.channelPriority) {
    if (channel === 'ntfy' && CONFIG.ntfyTopic) {
      const sent = await ntfySend(message, source);
      if (sent) return true;
    } else if (channel === 'webhook' && CONFIG.comms.webhookUrl) {
      const sent = await commsSendWebhook({ event: source, message, ts: new Date().toISOString() });
      if (sent) return true;
    } else if (channel === 'slack' && CONFIG.comms.slackUrl) {
      const sent = await commsSendSlack(message);
      if (sent) return true;
    } else if (channel === 'discord' && CONFIG.comms.discordUrl) {
      const sent = await commsSendDiscord(message);
      if (sent) return true;
    }
  }
  return false;
}

// C-06: Brain relay enhanced — post structured events to Brain with type tagging
async function commsRelayToBrain(eventType, payload) {
  if (!CONFIG.brainUrl) return;
  try {
    const url = CONFIG.brainUrl.replace(/\/jarvis$/, '') + '/relay/command';
    await httpPost(url, { type: eventType, payload, ts: new Date().toISOString() }, bridgeHeaders());
    commsLog(`brain:${eventType}`, 'brain');
  } catch(e) { log(`COMMS_BRAIN_ERR: ${e.message}`); }
}

// C-07: Peer Commander nodes — register/ping other Commander instances (future multi-machine)
function commsRegisterPeer(nodeId, url) {
  const existing = CONFIG.comms.peerNodes.find(p => p.id === nodeId);
  if (!existing) CONFIG.comms.peerNodes.push({ id: nodeId, url, lastSeen: null, status: 'unknown' });
  else existing.url = url;
  print(`🔗 [C-07] Peer node registered: ${nodeId} @ ${url}`);
}
async function commsPingPeers() {
  for (const peer of CONFIG.comms.peerNodes) {
    try {
      const res = await httpGet(peer.url + '/health').catch(() => null);
      peer.lastSeen = Date.now();
      peer.status = res ? 'online' : 'unreachable';
    } catch(e) { peer.status = 'unreachable'; }
    CONFIG.comms.lastHeartbeat[peer.id] = Date.now();
  }
}

// C-08: Heartbeat — broadcast Commander online status every 60s to Brain + all channels
async function commsHeartbeat() {
  const kpi = intelUpdateKPI();
  const msg = `♥ Commander v${CONFIG.version} | ${kpi.threatLevel} | Balance:${kpi.traderBalance??'?'} | Mem:${kpi.memoryEntries} entries | ${kpi.uptime}`;
  if (CONFIG.brainUrl) await commsRelayToBrain('heartbeat', kpi).catch(()=>{});
  log(`HEARTBEAT: ${msg}`);
}

// C-09: Message queue — buffer outbound messages when network is down; flush on reconnect
async function commsFlushQueue() {
  if (!CONFIG.comms.messageQueue.length) return;
  const toSend = [...CONFIG.comms.messageQueue];
  CONFIG.comms.messageQueue = [];
  for (const item of toSend) {
    await sendComms(item.message, item.source, item.priority);
  }
}
function commsQueue(message, source = 'commander', priority = 'normal') {
  if (CONFIG.comms.messageQueue.length >= CONFIG.comms.maxQueueSize) CONFIG.comms.messageQueue.shift();
  CONFIG.comms.messageQueue.push({ message, source, priority, ts: Date.now() });
}

// C-10: Channel health check — verify each configured communication channel
async function commsHealthCheck() {
  const results = [];
  results.push(`ntfy:    ${CONFIG.ntfyTopic ? '✓ configured' : '✗ not set'}`);
  results.push(`webhook: ${CONFIG.comms.webhookUrl ? '✓ configured' : '✗ not set (WEBHOOK_URL)'}`);
  results.push(`slack:   ${CONFIG.comms.slackUrl ? '✓ configured' : '✗ not set (SLACK_URL)'}`);
  results.push(`discord: ${CONFIG.comms.discordUrl ? '✓ configured' : '✗ not set (DISCORD_URL)'}`);
  results.push(`brain:   ${CONFIG.brainUrl ? '✓ configured' : '✗ not set'}`);
  results.push(`peers:   ${CONFIG.comms.peerNodes.length} node(s)`);
  results.push(`queue:   ${CONFIG.comms.messageQueue.length} pending`);
  return results.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ══  AUTONOMY ENGINE  v3.14  ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// ── INCIDENT REPORTER ─────────────────────────────────────────────────────────
// Saves structured incident JSON to F:\AIKON-OS\logs\reports\
async function saveIncidentReport(title, body, severity = 'INFO') {
  CONFIG.autonomy.incidentCount++;
  const ts    = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `incident-${ts}-${severity}.json`;
  const report = {
    id:        `INC-${String(CONFIG.autonomy.incidentCount).padStart(4,'0')}`,
    title,
    severity,
    timestamp: new Date().toISOString(),
    version:   CONFIG.version,
    threatLevel: CONFIG.security.threatLevel,
    body,
    kpi:       CONFIG.intel.kpiSnapshot,
    auditTail: CONFIG.security.anomalyLog.slice(-10),
  };
  try {
    const dir = CONFIG.autonomy.reportDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(report, null, 2));
    log(`INCIDENT: ${report.id} saved → ${fname}`);
  } catch(e) { log(`INCIDENT_SAVE_ERR: ${e.message}`); }
  // Push notification for WARN/CRITICAL
  if (severity !== 'INFO') {
    await sendComms(`🚨 ${severity}: ${title} | ${report.id}`, 'incident');
  }
  return report;
}

// ── AI-TO-AI: SELF-ASK ────────────────────────────────────────────────────────
// Commander autonomously asks AI peers questions and stores answers in memory
async function autonomousSelfAsk() {
  const cfg = CONFIG.autonomy;
  const now = Date.now();
  if (now - cfg.lastSelfAsk < cfg.selfAskIntervalMs) return;
  cfg.lastSelfAsk = now;

  // Pick next topic in rotation
  const topic = cfg.selfAskTopics[cfg.topicIndex % cfg.selfAskTopics.length];
  cfg.topicIndex++;

  log(`SELF-ASK: "${topic.substring(0,60)}"`);

  // Build enriched prompt with current system context
  const kpi    = intelUpdateKPI();
  const ragCtx = intelRagContext(topic, 'aikon_os', 3) + intelRagContext(topic, 'trader', 3);
  const prompt = `[AIKON-OS Commander Autonomous Query]
System state: v${CONFIG.version} | Threat:${kpi.threatLevel} | Balance:${kpi.traderBalance??'?'} | Uptime:${kpi.uptime}
${ragCtx}

Question: ${topic}
Answer concisely in 3-5 sentences. Focus on actionable insights for Al iKon.`;

  let answer = '';
  let usedClaude = false;
  try {
    const result = await askOllama(prompt, []);
    answer = result.reply || result;
  } catch(e) {
    log(`SELF-ASK OLLAMA_ERR: ${e.message} — trying fallback chain`);
    // Escalate through provider chain (Groq → OpenRouter → Gemini)
    try {
      const { text, provider } = await askAI(prompt);
      answer = text;
      usedClaude = provider !== 'ollama' && provider !== 'none';
      log(`SELF-ASK FALLBACK: answered via ${provider}`);
    } catch(ce) {
      answer = `[All AI unavailable: Ollama=${e.message}, chain=${ce.message}]`;
      log(`SELF-ASK ALL_FAIL: ${ce.message}`);
    }
  }

  // Store in memory + self-ask history
  const entry = { ts: new Date().toISOString(), topic, answer: answer.substring(0,400) };
  cfg.selfAskHistory.push(entry);
  if (cfg.selfAskHistory.length > 100) cfg.selfAskHistory = cfg.selfAskHistory.slice(-100);

  chromaAdd('aikon_os', {
    insight: `[SELF-ASK] Q: ${topic} | A: ${answer.substring(0,250)}`,
    source:  'autonomous_self_ask',
  });
  intelLogDecision('self_ask', topic, answer.substring(0,100));
  secAudit('SELF_ASK', `Topic: ${topic.substring(0,60)}`);
  log(`SELF-ASK ANSWERED: ${answer.substring(0,100)}`);

  // If answer contains actionable signal, queue it
  const actionWords = ['should','recommend','consider','urgent','immediately','alert','warning','opportunity'];
  if (actionWords.some(w => answer.toLowerCase().includes(w))) {
    cfg.decisionQueue.push({ ts: Date.now(), source: 'self_ask', action: answer.substring(0,200) });
    if (cfg.decisionQueue.length > 50) cfg.decisionQueue.shift();
  }
  return entry;
}

// ── AI-TO-AI: PEER QUERY ──────────────────────────────────────────────────────
// Query a specific AI peer (Ollama model, Claude API) with a question
async function queryAIPeer(peerId, question) {
  const peer = CONFIG.autonomy.aiPeers.find(p => p.id === peerId);
  if (!peer) return { error: `No peer: ${peerId}` };
  if (!peer.active) return { error: `Peer ${peerId} not active` };

  try {
    if (peer.type === 'ollama') {
      const result = await askOllama(question, [], peer.model !== CONFIG.ollamaModel ? peer.model : null);
      const answer = result.reply || result;
      chromaAdd('aikon_os', { insight: `[AI-PEER:${peerId}] Q:${question.substring(0,80)} A:${answer.substring(0,200)}`, source: 'ai_peer' });
      return { peer: peerId, model: peer.model, answer };
    }
    if (peer.type === 'groq') {
      const groqKey = process.env.GROQ_API_KEY || '';
      if (!groqKey) return { error: 'GROQ_API_KEY not set' };
      const payload = {
        model: peer.model,
        max_tokens: 400,
        messages: [
          { role: 'system', content: `You are advising AIKON-OS Commander for Al iKon (Al iKon Unlimited LLC). Be concise, actionable, 3-5 sentences.` },
          { role: 'user', content: question },
        ],
      };
      const res = await httpPost('https://api.groq.com/openai/v1/chat/completions', payload, {
        'Authorization': `Bearer ${groqKey}`,
      });
      const answer = res?.choices?.[0]?.message?.content || JSON.stringify(res).substring(0,200);
      chromaAdd('aikon_os', { insight: `[AI-PEER:groq] Q:${question.substring(0,80)} A:${answer.substring(0,200)}`, source: 'ai_peer_groq' });
      return { peer: peerId, model: peer.model, answer };
    }
  } catch(e) {
    return { error: e.message };
  }
  return { error: 'Unknown peer type' };
}

// ── AUTONOMOUS DECISION PROCESSOR ─────────────────────────────────────────────
// Processes queued autonomous decisions — evaluates and either acts or logs
async function processDecisionQueue() {
  if (!CONFIG.autonomy.decisionQueue.length) return;
  const item = CONFIG.autonomy.decisionQueue.shift();
  const age  = Date.now() - item.ts;
  if (age > 3600000) return; // skip stale (>1hr)

  log(`AUTO-DECISION: ${item.action.substring(0,80)}`);
  intelLogDecision('auto_decision', item.action, 'processed');
  chromaAdd('opportunities', {
    insight: `[AUTO] ${item.action.substring(0,250)}`,
    source:  item.source,
  });
}

// ── DAILY SUMMARY REPORT ──────────────────────────────────────────────────────
async function autonomousDailyReport() {
  const now   = new Date();
  const hour  = now.getHours();
  const today = now.toDateString();
  const cfg   = CONFIG.autonomy;

  if (hour !== cfg.dailyReportHour) return;
  if (new Date(cfg.lastDailyReport).toDateString() === today) return;
  cfg.lastDailyReport = Date.now();

  log('AUTO: generating daily summary report');
  const kpi  = intelUpdateKPI();
  const fore = intelForecast();
  const pats = intelPatternDetect();
  const sent = CONFIG.intel.sentimentHistory.slice(-5).map(s => s.signal).join(', ') || 'none';

  const summary = [
    `📊 DAILY SUMMARY — ${today}`,
    `Commander v${CONFIG.version} | Threat: ${kpi.threatLevel} | Uptime: ${kpi.uptime}`,
    `Trader Balance: ${kpi.traderBalance != null ? '$'+kpi.traderBalance : 'N/A'} | Win Rate: ${kpi.traderWinRate ?? 'N/A'}`,
    `Forecast: ${fore.trend} | Avg Δ $${fore.avgDelta ?? '?'}/cycle`,
    `Sentiment (last 5): ${sent}`,
    `Top patterns: ${pats.slice(0,5).join(', ')}`,
    `Memory: ${kpi.memoryEntries} entries | Incidents: ${cfg.incidentCount}`,
    `Self-ask questions answered: ${cfg.selfAskHistory.length}`,
    `Decisions queued/processed: ${cfg.decisionQueue.length} pending`,
  ].join('\n');

  // Push to phone
  await sendComms(summary, 'daily_report', 'high');

  // Save as incident report (INFO level)
  await saveIncidentReport('Daily Summary Report', summary, 'INFO');

  // Store in memory
  chromaAdd('aikon_os', { insight: summary.substring(0,400), source: 'daily_report' });
  log('AUTO: daily summary sent');
}

// ── WEEKLY MEMORY SYNTHESIS ───────────────────────────────────────────────────
async function autonomousWeeklyReport() {
  const now = new Date();
  const cfg = CONFIG.autonomy;
  if (now.getDay() !== cfg.weeklyReportDay) return;
  const weekStr = `week-${now.getFullYear()}-${now.getMonth()}-${Math.floor(now.getDate()/7)}`;
  if (cfg.lastWeeklyReport === weekStr) return;
  cfg.lastWeeklyReport = weekStr;

  log('AUTO: generating weekly synthesis');
  const synth = await intelCrossBranchSynth().catch(e => `Synthesis error: ${e.message}`);
  const fore  = intelForecast(20);

  const report = [
    `📅 WEEKLY SYNTHESIS — ${now.toDateString()}`,
    `Forecast (20 cycles): ${fore.trend} → $${fore.forecast}`,
    `Cross-branch insights:`,
    synth.substring(0, 500),
  ].join('\n');

  await sendComms(report, 'weekly_report', 'high');
  await saveIncidentReport('Weekly Synthesis Report', report, 'INFO');
  log('AUTO: weekly synthesis sent');
}

// ── THREAT-TRIGGERED ACTIONS ──────────────────────────────────────────────────
// Runs when threat level changes — chains protocols automatically
async function autonomousThreatResponse(level) {
  if (level === 'YELLOW') {
    await saveIncidentReport('Threat Level Elevated to YELLOW',
      `Anomaly or lockout detected. Audit log: ${CONFIG.security.anomalyLog.slice(-3).map(e=>e.detail).join(' | ')}`,
      'WARN');
    await intelDeepScan().catch(()=>{});
    intelPatternDetect();
  }
  if (level === 'RED') {
    await saveIncidentReport('THREAT LEVEL RED — Defensive Mode Active',
      `All external actions require manual /approve. Locked sources: ${[...CONFIG.security.lockedSources].join(', ')||'none'}`,
      'CRITICAL');
    await sendComms('🚨 COMMANDER RED ALERT — defensive mode active. Manual approval required for all external actions.', 'threat_response', 'high');
  }
  if (level === 'GREEN') {
    log('AUTO: threat resolved → GREEN, resuming normal operations');
  }
}

// ── TRADER DRAWDOWN WATCHER ───────────────────────────────────────────────────
// Watches for significant drawdown and auto-alerts
function autonomousDrawdownCheck(balance, prevBalance) {
  if (!prevBalance || !balance) return;
  const drawdown = prevBalance - balance;
  const pct      = (drawdown / prevBalance) * 100;
  if (pct >= 2) { // 2% drawdown triggers alert
    const msg = `⚠️ Trader drawdown: -$${drawdown.toFixed(2)} (${pct.toFixed(1)}%) | Balance: $${balance.toFixed(2)}`;
    sendComms(msg, 'drawdown_alert', 'high');
    secAudit('DRAWDOWN', msg);
    if (pct >= 5) {
      setThreatLevel('YELLOW', `Trader drawdown ${pct.toFixed(1)}%`);
      saveIncidentReport('Significant Trader Drawdown', msg, 'WARN');
    }
  }
}

// ── HEALTH MONITOR v3.20 ──────────────────────────────────────────────────────
// Runs every 5 min — checks trader, Brain, Ollama, and win rate.
// Alerts Al iKon via ntfy on any critical event. Auto-pauses trader
// when daily loss hits $120 buffer (leaves $30 before FundedNext limit).
const _healthState = {
  lastTraderBalance: null,
  dailyLossAlerted:  false,
  winRateAlerted:    false,
  brainDownAt:       null,
  ollamaDownAt:      null,
  lastHealthDate:    null,
};

async function autonomousHealthCheck() {
  const now = new Date();
  const dateStr = now.toDateString();

  // Reset daily flags at midnight
  if (_healthState.lastHealthDate !== dateStr) {
    _healthState.lastHealthDate    = dateStr;
    _healthState.dailyLossAlerted  = false;
    _healthState.winRateAlerted    = false;
  }

  // ── 1. Trader health ──────────────────────────────────────────────────────
  try {
    const raw = await httpGet(CONFIG.traderUrl);
    const s   = JSON.parse(raw);
    const bal = s.balance ?? s.accountBalance ?? null;
    const dp  = s.dailyPL ?? s.dailyPnl ?? null;
    const wr  = s.stats?.winRate ?? s.winRate ?? null;

    // Daily loss buffer alert ($120 of $150 limit)
    if (dp !== null && dp <= -120 && !_healthState.dailyLossAlerted) {
      _healthState.dailyLossAlerted = true;
      const msg = `🚨 TRADER DAILY LOSS -$${Math.abs(dp).toFixed(2)} — approaching FundedNext limit! Auto-review recommended.`;
      await notify('Trader Daily Loss Alert', msg, 'high');
      chromaAdd('trader', { insight: msg, source: 'health_monitor' });
      log(`HEALTH: trader daily loss alert — P&L=$${dp}`);
    }

    // Win rate drop alert (below 20% in session)
    if (wr !== null && parseFloat(wr) < 20 && !_healthState.winRateAlerted) {
      _healthState.winRateAlerted = true;
      const msg = `⚠️ Trader win rate dropped to ${wr}% — below 20% threshold. Review scalp filters.`;
      await notify('Trader Win Rate Low', msg, 'default');
      chromaAdd('trader', { insight: msg, source: 'health_monitor' });
      log(`HEALTH: trader win rate alert — ${wr}%`);
    }

    // Balance drawdown vs previous check
    if (_healthState.lastTraderBalance !== null && bal !== null) {
      autonomousDrawdownCheck(bal, _healthState.lastTraderBalance);
    }
    if (bal !== null) _healthState.lastTraderBalance = bal;

    // Trader recovered
    if (_healthState.traderDownAt) {
      const downMin = Math.round((Date.now() - _healthState.traderDownAt) / 60000);
      await notify('Trader Recovered', `Trader back online after ${downMin}min down.`, 'default');
      _healthState.traderDownAt = null;
    }
  } catch(e) {
    if (!_healthState.traderDownAt) {
      _healthState.traderDownAt = Date.now();
      await notify('Trader DOWN', `Trader API unreachable: ${e.message}`, 'high');
      log(`HEALTH: trader down — ${e.message}`);
    }
  }

  // ── 2. Brain relay health ─────────────────────────────────────────────────
  if (CONFIG.brainUrl) {
    try {
      await httpGet(CONFIG.brainUrl.replace(/\/$/, '') + '/relay/status');
      if (_healthState.brainDownAt) {
        const downMin = Math.round((Date.now() - _healthState.brainDownAt) / 60000);
        await notify('Brain Relay Recovered', `Brain back online after ${downMin}min.`, 'default');
        _healthState.brainDownAt = null;
        CONFIG.brainConnected = true;
      }
    } catch(e) {
      if (!_healthState.brainDownAt) {
        _healthState.brainDownAt = Date.now();
        await notify('Brain Relay DOWN', `Brain unreachable: ${e.message}`, 'default');
        CONFIG.brainConnected = false;
        log(`HEALTH: brain down — ${e.message}`);
      }
    }
  }

  // ── 3. Groq API reachability (quick check, no tokens spent) ───────────────
  const groqKey = process.env.GROQ_API_KEY || '';
  if (groqKey && !_healthState.groqOk) {
    // Just verify key format — don't spend tokens
    _healthState.groqOk = groqKey.startsWith('gsk_');
    if (!_healthState.groqOk) {
      await notify('Groq Key Invalid', 'GROQ_API_KEY format looks wrong (should start with gsk_)', 'default');
    }
  }

  log(`HEALTH-CHECK: trader=${_healthState.traderDownAt?'DOWN':'OK'} brain=${_healthState.brainDownAt?'DOWN':'OK'} groq=${groqKey?'SET':'MISSING'}`);
}

// ── MASTER AUTONOMY LOOP ──────────────────────────────────────────────────────
// The brain of v3.14 — runs every 15 min and self-directs all autonomous tasks
async function autonomousLoop() {
  const cfg = CONFIG.autonomy;
  if (!cfg.enabled) return;

  const now = Date.now();
  if (now - cfg.lastLoopRun < cfg.loopIntervalMs) return;
  cfg.lastLoopRun = now;
  cfg.loopCount++;

  log(`AUTO-LOOP #${cfg.loopCount} starting`);
  secAudit('AUTO_LOOP', `Loop #${cfg.loopCount}`);

  try {
    // 1. Update KPI snapshot
    intelUpdateKPI();

    // 2. Deep intel scan (respects its own 15-min throttle)
    await intelDeepScan().catch(e => log(`AUTO loop intelScan err: ${e.message}`));

    // 3. Self-directed AI question (hourly)
    await autonomousSelfAsk().catch(e => log(`AUTO loop selfAsk err: ${e.message}`));

    // 4. Process pending autonomous decisions
    await processDecisionQueue().catch(()=>{});

    // 5. Security scan
    secIntegrityCheck();
    secCheckAnomaly('loop', null);

    // 6. Daily/weekly reports (checks time internally)
    await autonomousDailyReport().catch(e => log(`AUTO daily err: ${e.message}`));
    await autonomousWeeklyReport().catch(e => log(`AUTO weekly err: ${e.message}`));

    // 7. Cross-branch synthesis every 4 loops (~1 hr)
    if (cfg.loopCount % 4 === 0) {
      await intelCrossBranchSynth().catch(e => log(`AUTO synth err: ${e.message}`));
    }

    // 8. Market scan every 8 loops (~2 hr)
    if (cfg.loopCount % 8 === 0) {
      await intelMarketScan().catch(()=>{});
    }

    // 9. Peer heartbeat ping
    await commsPingPeers().catch(()=>{});

    // 10. Flush message queue
    await commsFlushQueue().catch(()=>{});

    // 11. Health check (trader P&L, win rate, Brain, Groq)
    await autonomousHealthCheck().catch(e => log(`AUTO loop healthCheck err: ${e.message}`));

    log(`AUTO-LOOP #${cfg.loopCount} complete`);
  } catch(e) {
    log(`AUTO-LOOP ERR: ${e.message}`);
    secAudit('AUTO_LOOP_ERR', e.message);
  }
}

// ─── APPROVAL QUEUE ───────────────────────────────────────────────────────────
function queueApproval(action, details, executeFn) {
  const id = Date.now();
  CONFIG.pendingApprovals.push({ id, action, details, executeFn, ts: new Date().toISOString(), queuedAt: Date.now() });
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

// Bridge v2.1 ack — call after successfully processing polled messages
// Prevents message loss if Commander crashes between poll and processing
async function bridgeAck(ids) {
  if (!CONFIG.bridgeUrl || !ids || !ids.length) return;
  try {
    await httpPost(`${CONFIG.bridgeUrl}/ack`, { ids }, bridgeHeaders());
    log(`BRIDGE_ACK: ${ids.length} messages acknowledged`);
  } catch(e) { log(`BRIDGE_ACK_ERR: ${e.message}`); }
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
    if (msgs.length === 0) return;

    const processedIds = [];
    for (const msg of msgs) {
      try {
        print(`\n📨 MESSAGE FROM ${msg.from.toUpperCase()} [${msg.type}]:\n${msg.content}`);
        log(`BRIDGE_MSG: from=${msg.from} type=${msg.type} content=${msg.content.substring(0,100)}`);
        remember('bridge_in', `[${msg.from}/${msg.type}] ${msg.content}`);

        if (msg.type === 'command' && msg.content.startsWith('/')) {
          print(`⚙️  Auto-executing bridge command: ${msg.content}`);
          await handleCommand(msg.content, null);
        }
        // Only ack after successful processing
        processedIds.push(msg.id);
      } catch(e) {
        log(`BRIDGE_MSG_ERR: ${e.message} — msg ${msg.id} not acked, will retry next poll`);
      }
    }
    // Ack all successfully processed messages (FIX-7 ack-on-process)
    if (processedIds.length > 0) await bridgeAck(processedIds);
  }, CONFIG.pollInterval);

  setTimeout(bridgeHeartbeat, 2000);
}

// ─── BRAIN RELAY (v3.8 — HTTP POST + Claude↔Commander back-channel) ─────────
// Railway's nginx proxy forces WebSocket permessage-deflate at the infrastructure
// level, causing RSV1 frame errors regardless of perMessageDeflate:false settings.
// ── Claude Poller — spawns claude-poller.js as a child process ──
// Polls Brain every 60s for /claude questions, answers via Ollama
// (falls back to Claude API if set), posts responses back to Brain.
function startClaudePoller() {
  const pollerPath = path.join(__dirname, 'claude-poller.js');
  if (!require('fs').existsSync(pollerPath)) {
    log('POLLER: claude-poller.js not found in commander dir — skipping');
    return;
  }

  function launch() {
    const child = spawn(process.execPath, [pollerPath], {
      cwd:   __dirname,
      stdio: 'inherit',  // poller logs appear in same terminal
      env:   process.env,
    });
    child.on('exit', (code) => {
      log(`POLLER: exited (code ${code}) — restarting in 10s`);
      setTimeout(launch, 10_000);
    });
    child.on('error', (err) => {
      log(`POLLER: spawn error — ${err.message} — retrying in 10s`);
      setTimeout(launch, 10_000);
    });
    log('POLLER: claude-poller.js started');
  }

  launch();
}

// Fix: use plain HTTP POST to /relay/push — no WebSocket upgrade, no proxy interference.
// Commander POSTs events every 5s; Brain returns queued commands in the response.

function startBrainRelay() {
  if (!CONFIG.brainUrl) {
    log('RELAY: BRAIN_URL not set — skipping outbound relay');
    return;
  }

  const pushUrl = CONFIG.brainUrl.replace(/\/$/, '') + '/relay/push';
  CONFIG._relayQueue = [];   // events queued for next POST
  CONFIG.brainConnected = false;

  const relayHeaders = {};
  if (CONFIG.bridgeKey) relayHeaders['x-bridge-key'] = CONFIG.bridgeKey;

  // Uses top-level httpPost helper (no duplicate needed)
  async function relayTick() {
    // Drain queue — send all buffered events, plus a heartbeat if queue is empty
    const events = CONFIG._relayQueue.splice(0);
    if (events.length === 0) {
      // Send heartbeat to keep Brain's watchdog happy
      events.push({ t: 'heartbeat', uptime: Math.floor(process.uptime()), ts: Date.now() });
    }

    // POST all events in a batch (send each individually for simplicity)
    for (const event of events) {
      try {
        const result = await httpPost(pushUrl, event, relayHeaders);
        // httpPost resolves to parsed JSON body directly
        const body = result;
        if (body && body.error === 'unauthorized') {
          log('RELAY: unauthorized — check BRIDGE_KEY in .env');
          continue;
        }
        if (!CONFIG.brainConnected) {
          CONFIG.brainConnected = true;
          log('RELAY: connected to Brain via HTTP POST ✓ — HUD will show LIVE');
          // Send hello so HUD gets version info
          CONFIG._relayQueue.push({
            t: 'hello', version: CONFIG.version,
            uptime: Math.floor(process.uptime()), ts: Date.now()
          });
        }
        // Process any commands Brain queued for us
        const cmds = body.commands || [];
        for (const cmd of cmds) {
          if (cmd.command) {
            log(`RELAY: received command from HUD: ${cmd.command}`);
            handleCommand(cmd.command, null).catch(() => {});
          }
        }
        // Process any Claude responses queued for us
        const claudeResps = body.claude_responses || [];
        for (const resp of claudeResps) {
          print(`\n🤖 Claude [${resp.id}]: ${resp.response}\n`);
          log(`CLAUDE-RESPONSE [${resp.id}]: ${resp.response.substring(0, 200)}`);
        }
      } catch(e) {
        if (CONFIG.brainConnected) {
          CONFIG.brainConnected = false;
          log(`RELAY: Brain unreachable — ${e.message}`);
        }
      }
    }
  }

  // Start after a short delay, then POST every 5s
  setTimeout(() => {
    relayTick();
    setInterval(relayTick, 5000);
  }, 3000);
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

  const body = JSON.stringify({ model, messages, stream: false, keep_alive: 0 });

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
    // winRate lives in s.stats (returned by computeStats()), not at root level
    const winRate  = s.stats?.winRate ?? s.winRate ?? 'N/A';
    const status   = s.dailyPaused ? 'paused' : (s.dbConnected ? 'live' : 'no-db');
    const openCount = Array.isArray(s.openTrades) ? s.openTrades.length : 0;
    const openSummary = Array.isArray(s.openTrades) && s.openTrades.length
      ? s.openTrades.map(t => `${t.tradeType||'?'}@${t.entry||'?'}`).join(', ')
      : 'none';
    const insight = `Trader: balance=$${s.balance?.toFixed(2)}, winRate=${winRate}%, status=${status}, price=$${s.currentPrice?.toFixed(1)}, openTrades=${openCount} [${openSummary}], dailyPL=$${s.dailyPL?.toFixed(2)??'N/A'}`;
    chromaAdd('trader', { insight, source: 'trader_api' });
    log(`LEARN: trader snapshot logged — ${insight.substring(0,80)}`);

    // AUTO: drawdown detection — compare to previous KPI balance
    const prevBalance = CONFIG.intel.kpiSnapshot?.traderBalance;
    if (prevBalance && s.balance) autonomousDrawdownCheck(s.balance, prevBalance);

    // AUTO: run sentiment on trade summary
    intelSentiment(insight);
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

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SYSTEM OPTIMIZER / CPU GOVERNOR ─────────────────────────────────────────
// Keeps Thomas fast by throttling Ollama and clearing junk automatically.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Set Ollama process priority to Below Normal (reduces CPU competition) ─────
async function throttleOllama() {
  try {
    // Find ollama PID then set priority class to BelowNormal (0x4000)
    // wmic is available on all Win10/11 systems
    const pidRaw = runShell('wmic process where "name=\'ollama.exe\' or name=\'ollama app.exe\' or name=\'ollama runner.exe\'" get ProcessId /VALUE 2>nul');
    const pids = [...(pidRaw.matchAll(/ProcessId=(\d+)/g))].map(m => m[1]).filter(Boolean);
    if (!pids.length) { log('GOVERNOR: ollama process not found (may not be running)'); return 'Ollama not running.'; }
    const results = [];
    for (const pid of pids) {
      // PowerShell one-liner: set priority to BelowNormal
      const r = runShell(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PriorityClass = 'BelowNormal'"`);
      results.push(`PID ${pid}: priority → BelowNormal`);
      log(`GOVERNOR: ollama PID ${pid} throttled to BelowNormal`);
    }
    // Also set OLLAMA_NUM_PARALLEL=1 and limit threads via env — takes effect on next ollama restart
    runShell('setx OLLAMA_NUM_PARALLEL 1 /M 2>nul');
    runShell('setx OLLAMA_MAX_LOADED_MODELS 1 /M 2>nul');
    return results.join('\n');
  } catch(e) { log(`GOVERNOR_ERR: ${e.message}`); return `Error: ${e.message}`; }
}

// ── Free RAM: empty working sets of background processes ─────────────────────
async function freeRam() {
  try {
    // EmptyWorkingSet on common memory hogs (not critical processes)
    const hogs = ['SearchIndexer', 'SearchProtocolHost', 'SgrmBroker', 'RuntimeBroker', 'backgroundTaskHost'];
    for (const name of hogs) {
      runShell(`powershell -NoProfile -Command "Get-Process '${name}' -ErrorAction SilentlyContinue | ForEach-Object { $_.MinWorkingSet = $_.MinWorkingSet }" 2>nul`);
    }
    // Clear DNS cache (frees a little memory + speeds up network)
    runShell('ipconfig /flushdns >nul 2>&1');
    // Clear temp files older than 1 day
    runShell('cmd /c "forfiles /P %TEMP% /D -1 /C \"cmd /c if @isdir==FALSE del /f /q @path\" 2>nul"');
    log('GOVERNOR: RAM freed, DNS flushed, temp cleaned');
    return 'RAM freed | DNS flushed | Temp cleaned';
  } catch(e) { return `RAM free error: ${e.message}`; }
}

// ── Set power plan to High Performance ───────────────────────────────────────
async function setPowerPlan() {
  try {
    // High Performance GUID — built into Windows
    runShell('powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c 2>nul');
    log('GOVERNOR: Power plan → High Performance');
    return 'Power plan → High Performance';
  } catch(e) { return `Power plan error: ${e.message}`; }
}

// ── Kill known non-essential background hogs ──────────────────────────────────
async function killHogs() {
  const targets = [
    'OneDrive', 'Teams', 'SkypeApp', 'YourPhone', 'GameBarFTServer',
    'GameBar', 'XboxGameBarWidgets', 'SearchApp', 'Cortana'
  ];
  const killed = [];
  for (const name of targets) {
    const r = runShell(`taskkill /F /IM "${name}.exe" 2>nul`);
    if (r && !r.includes('not found') && !r.includes('ERROR')) killed.push(name);
  }
  if (killed.length) log(`GOVERNOR: killed ${killed.join(', ')}`);
  return killed.length ? `Killed: ${killed.join(', ')}` : 'No hogs running';
}

// ── Get current CPU/RAM snapshot ──────────────────────────────────────────────
function getSystemSnapshot() {
  try {
    const cpuRaw = runShell('powershell -NoProfile -Command "Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average"').trim();
    const ramRaw = runShell('powershell -NoProfile -Command "$os=Get-WmiObject Win32_OperatingSystem; [math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/$os.TotalVisibleMemorySize*100,1)"').trim();
    const topRaw = runShell('powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Desc | Select-Object -First 5 Name,@{n=\'CPU\';e={[math]::Round($_.CPU,1)}},@{n=\'RAM_MB\';e={[math]::Round($_.WorkingSet/1MB,0)}} | ConvertTo-Csv -NoTypeInformation"').trim();
    return { cpu: cpuRaw || '?', ram: ramRaw || '?', top: topRaw };
  } catch(e) { return { cpu: '?', ram: '?', top: e.message }; }
}

// ── Full optimize run ─────────────────────────────────────────────────────────
async function runOptimize(verbose = true) {
  if (verbose) print('⚡ Optimizing Thomas…');
  const snap1 = getSystemSnapshot();
  if (verbose) print(`📊 Before — CPU: ${snap1.cpu}% | RAM: ${snap1.ram}%`);

  const r1 = await throttleOllama();
  if (verbose) print(`🤖 Ollama: ${r1}`);

  const r2 = await setPowerPlan();
  if (verbose) print(`⚡ Power: ${r2}`);

  const r3 = await killHogs();
  if (verbose) print(`🗑️  Hogs: ${r3}`);

  const r4 = await freeRam();
  if (verbose) print(`🧹 RAM: ${r4}`);

  // Brief pause then re-snapshot
  await new Promise(r => setTimeout(r, 2000));
  const snap2 = getSystemSnapshot();
  if (verbose) print(`📊 After  — CPU: ${snap2.cpu}% | RAM: ${snap2.ram}%`);

  const summary = `Optimize complete | CPU: ${snap1.cpu}%→${snap2.cpu}% | RAM: ${snap1.ram}%→${snap2.ram}%`;
  log(`OPTIMIZE: ${summary}`);
  await notify('Thomas Optimized', summary, 'normal');
  return summary;
}

// ── Auto CPU monitor: runs every 3 min, self-optimizes if CPU > 70% ──────────
function startCpuMonitor() {
  setInterval(async () => {
    try {
      const snap = getSystemSnapshot();
      const cpu = parseFloat(snap.cpu);
      const ram = parseFloat(snap.ram);
      log(`MONITOR: CPU=${snap.cpu}% RAM=${snap.ram}%`);
      if (cpu > 70 || ram > 85) {
        log(`MONITOR: High load detected (CPU ${snap.cpu}% RAM ${snap.ram}%) — auto-optimizing`);
        print(`\n⚠️  High load: CPU ${snap.cpu}% | RAM ${snap.ram}% — auto-optimizing…`);
        await runOptimize(false);
      }
    } catch(e) { log(`MONITOR_ERR: ${e.message}`); }
  }, 180000); // every 3 min
  log('CPU MONITOR: started (3 min interval, auto-optimize at >70% CPU or >85% RAM)');
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
    const winRate   = s.stats?.winRate ?? s.winRate ?? 'N/A';
    const status    = s.dailyPaused ? 'PAUSED' : (s.dbConnected ? 'LIVE' : 'no-db');
    const openCount = Array.isArray(s.openTrades) ? s.openTrades.length : (s.openTrades ?? 0);
    return [
      `📊 TRADER — ${new Date().toLocaleTimeString()}`,
      `Balance:       $${s.balance?.toFixed(2) ?? 'N/A'}`,
      `Win Rate:      ${winRate}%`,
      `Open Trades:   ${openCount}`,
      `Consec Losses: ${s.activityStats?.consecutiveLosses ?? s.consecutiveLosses ?? 0}`,
      `Daily P/L:     $${s.dailyPL?.toFixed(2) ?? 'N/A'}`,
      `Price:         $${s.currentPrice?.toFixed(2) ?? 'N/A'}`,
      `Status:        ${status}`,
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
      // Still refresh claude-poller.js even if commander is current
      await updatePoller(token);
      return;
    }
    print(`🆕 Update found: v${CONFIG.version} → v${latestVer}`);
    const selfPath   = __filename;
    const backupPath = selfPath + '.backup';
    fs.copyFileSync(selfPath, backupPath);
    fs.writeFileSync(selfPath, code, 'utf8');
    print(`✅ Commander updated to v${latestVer}.`);
    log(`SELF_UPDATE: v${CONFIG.version} → v${latestVer} sha=${sha.substring(0,8)}`);
    // Also fetch claude-poller.js
    await updatePoller(token);
    print(`🔄 Restarting Commander...`);
    await bridgeSend('status', `Commander self-updated v${CONFIG.version} → v${latestVer}. Restarting.`, 'claude');
    const child = spawn(process.execPath, [selfPath], { detached: true, stdio: 'inherit', cwd: __dirname });
    child.unref();
    process.exit(0);
  } catch(e) {
    print(`❌ Update failed: ${e.message}`);
    log(`SELF_UPDATE_ERR: ${e.message}`);
  }
}

async function updatePoller(token) {
  try {
    print(`⬇️  Fetching claude-poller.js from GitHub...`);
    const pollerGithubPath = 'commander/claude-poller.js';
    const json = await githubGetFile(token, CONFIG.updateRepo, pollerGithubPath);
    if (!json.content) throw new Error(json.message || 'No content for claude-poller.js');
    const pollerCode = Buffer.from(json.content, 'base64').toString('utf8');
    const pollerPath = path.join(__dirname, 'claude-poller.js');
    fs.writeFileSync(pollerPath, pollerCode, 'utf8');
    print(`✅ claude-poller.js updated.`);
    log(`SELF_UPDATE: claude-poller.js refreshed sha=${(json.sha||'').substring(0,8)}`);
  } catch(e) {
    print(`⚠️  claude-poller.js update skipped: ${e.message}`);
    log(`SELF_UPDATE_WARN: poller update failed — ${e.message}`);
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

let _ttsProc = null; // track active TTS so we can interrupt it

function stopSpeaking() {
  if (_ttsProc) {
    try { _ttsProc.kill('SIGTERM'); } catch(e) {}
    _ttsProc = null;
  }
}

function speak(text) {
  if (!CONFIG.ttsEnabled) return;
  if (!fs.existsSync(CONFIG.voiceSpeak)) return;
  stopSpeaking(); // kill any ongoing speech before starting new one
  const spoken = text.replace(/[*_`#]/g, '').substring(0, 300);
  try {
    _ttsProc = spawn('python', [CONFIG.voiceSpeak, spoken, String(CONFIG.ttsRate)], {
      stdio: 'ignore', detached: false
    });
    _ttsProc.on('exit', () => { _ttsProc = null; });
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
    const body = JSON.stringify({ model, messages, stream: false, keep_alive: 0 });
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
// ─── SOCIAL MEDIA TEAM ───────────────────────────────────────────────────────
// Research → Create → Deploy pipeline for TikTok, X, Instagram
// Commander posts autonomously once Social Team delivers a deployable package.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Trend research per platform ───────────────────────────────────────────────
async function socialResearch(platform) {
  const cfg = CONFIG.social[platform] || {};
  const focus = cfg.focus || cfg.accounts ? Object.values(cfg.accounts || {}).map(a=>a.focus).join(', ') : 'Al iKon Unlimited LLC';
  const prompt = `You are the Social Research Agent for AIKON-OS.
Platform: ${platform.toUpperCase()}
Brand focus: ${focus}

Research task:
1. What content formats perform best on ${platform} right now for a small business / creator?
2. What trending topics or hashtags fit this brand?
3. What posting frequency and time-of-day strategy maximizes reach?
4. What monetization and sponsorship signals does ${platform} look for?
5. Give 3 specific content IDEAS ready to hand to the Content Creator Agent.

Be concise. Output as numbered sections. Focus on what's deployable THIS WEEK.`;

  return await teamLLM(prompt, 'social research');
}

// ── Content creation per platform ─────────────────────────────────────────────
async function socialCreate(platform, researchReport, accountKey) {
  const cfg     = CONFIG.social[platform] || {};
  const account = cfg.accounts ? (cfg.accounts[accountKey] || Object.values(cfg.accounts)[0]) : cfg;
  const handle  = account.handle || accountKey;
  const focus   = account.focus || 'Al iKon Unlimited LLC';

  const prompt = `You are the Social Content Creator Agent for AIKON-OS.
Platform: ${platform.toUpperCase()} | Account: ${handle}
Brand focus: ${focus}

RESEARCH REPORT:
${researchReport}

CREATE a deployable content package:
- CAPTION: (ready to post, with hashtags, under platform char limit)
- HOOK: (first line that stops the scroll)
- CTA: (clear call to action)
- HASHTAGS: (10-15 relevant tags)
- BEST POST TIME: (day + time, Eastern)
- CONTENT TYPE: (video idea / image / text post / reel / thread)
- VIDEO SCRIPT: (if video — 30-60 sec script, punchy)
- SPONSORSHIP ANGLE: (1 sentence on what sponsor this content attracts)

Format each field on its own line with the label. Make it ready to deploy — no placeholders.`;

  return await teamLLM(prompt, 'social create');
}

// ── LLM call helper (reuses ollama config) ────────────────────────────────────
async function teamLLM(prompt, label) {
  const model = CONFIG.ollamaModel;
  try {
    // Keep_alive=0 tells Ollama to unload model immediately after response — frees RAM on 8GB systems
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, keep_alive: 0 });
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: CONFIG.ollamaHost, port: CONFIG.ollamaPort,
        path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 300000, // 5 min — social content generation can be slow on 8GB
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d).message?.content || 'No response'); } catch(e) { resolve(d); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout after 5min — try /optimize first')); });
      req.write(body); req.end();
    });
  } catch(e) {
    log(`SOCIAL_LLM_ERR [${label}]: ${e.message}`);
    return `Error: ${e.message}`;
  }
}

// ── Deploy: post to platform via API ─────────────────────────────────────────
async function socialDeploy(platform, pkg, accountKey) {
  const caption = pkg.caption || pkg.content || pkg;

  if (platform === 'twitter') {
    const { apiKey, apiSecret, accessToken, accessSecret } = CONFIG.social.twitter;
    if (!apiKey || !accessToken) return '⚠️  Twitter credentials not set — add TWITTER_API_KEY / TWITTER_ACCESS_TOKEN / TWITTER_ACCESS_SECRET to .env';
    // Twitter v2 — tweet
    try {
      const tweetBody = JSON.stringify({ text: caption.substring(0, 280) });
      // OAuth 1.0a signature (simplified — requires oauth-1.0a or manual HMAC-SHA1)
      const authHeader = buildOAuth1Header('POST', 'https://api.twitter.com/2/tweets', {}, apiKey, apiSecret, accessToken, accessSecret);
      const result = await httpPostRaw('https://api.twitter.com/2/tweets', tweetBody, {
        'Authorization': authHeader, 'Content-Type': 'application/json',
      });
      log(`SOCIAL_DEPLOY [twitter]: ${result.substring(0,100)}`);
      return `✅ Tweeted: ${caption.substring(0,80)}…`;
    } catch(e) { return `❌ Twitter post failed: ${e.message}`; }
  }

  if (platform === 'instagram') {
    const acc = CONFIG.social.instagram.accounts[accountKey];
    if (!acc || !acc.accessToken) return `⚠️  Instagram token not set for ${accountKey} — add IG_${accountKey.toUpperCase()}_TOKEN to .env`;
    // Meta Graph API — image post flow: generate image → upload container → publish
    try {
      // Step 1: Generate a branded image with caption text using Canvas (via HTML+screenshot approach)
      // We use a public image URL for now — Unsplash source gives a free relevant image
      const igCaption = caption.substring(0, 2200); // IG caption limit
      const imageUrl = await generateIgBrandImage(igCaption, acc.handle);

      // Step 2: Get IG Business Account ID
      const meRes = await httpGetRaw(`https://graph.facebook.com/v18.0/me?fields=id,instagram_business_account&access_token=${acc.accessToken}`);
      const meData = JSON.parse(meRes);
      if (!meData.instagram_business_account) return `⚠️  ${accountKey} not linked to an IG Business Account on Facebook`;
      const igUserId = meData.instagram_business_account.id;

      // Step 3: Create media container
      const containerBody = new URLSearchParams({ image_url: imageUrl, caption: igCaption, access_token: acc.accessToken }).toString();
      const containerRes = await httpPostRaw(
        `https://graph.facebook.com/v18.0/${igUserId}/media`,
        containerBody,
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
      const containerData = JSON.parse(containerRes);
      if (!containerData.id) return `❌ IG media container failed for ${accountKey}: ${JSON.stringify(containerData)}`;

      // Step 4: Publish container
      const publishBody = new URLSearchParams({ creation_id: containerData.id, access_token: acc.accessToken }).toString();
      const publishRes = await httpPostRaw(
        `https://graph.facebook.com/v18.0/${igUserId}/media_publish`,
        publishBody,
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
      const publishData = JSON.parse(publishRes);
      if (publishData.id) return `✅ Posted to @${acc.handle} (IG post ID: ${publishData.id})`;
      return `❌ IG publish failed for ${accountKey}: ${JSON.stringify(publishData)}`;
    } catch(e) { return `❌ Instagram post failed for ${accountKey}: ${e.message}`; }
  }

  if (platform === 'tiktok') {
    const { accessToken } = CONFIG.social.tiktok;
    if (!accessToken) return '⚠️  TikTok credentials not set — add TIKTOK_ACCESS_TOKEN to .env';
    // TikTok Content Posting API — video only; text posts not yet available
    return `⚠️  TikTok requires video upload — script queued for recording:\n${caption}`;
  }

  return `Unknown platform: ${platform}`;
}

// ── OAuth 1.0a header builder (Twitter) ──────────────────────────────────────
function buildOAuth1Header(method, url, params, consumerKey, consumerSecret, token, tokenSecret) {
  const crypto = require('crypto');
  const nonce  = crypto.randomBytes(16).toString('hex');
  const ts     = Math.floor(Date.now() / 1000).toString();
  const oauthParams = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_token:            token,
    oauth_version:          '1.0',
  };
  const allParams   = { ...params, ...oauthParams };
  const sortedKeys  = Object.keys(allParams).sort();
  const paramStr    = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join('&');
  const baseStr     = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const signingKey  = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature   = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  oauthParams.oauth_signature = signature;
  const headerParts = Object.keys(oauthParams).map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`);
  return 'OAuth ' + headerParts.join(', ');
}

// ── Raw HTTP GET helper ────────────────────────────────────────────────────────
async function httpGetRaw(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET' };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject); req.end();
  });
}

// ── Generate branded IG image URL ─────────────────────────────────────────────
// Returns a publicly accessible image URL for the IG media container.
// Uses Unsplash Source API (free, no key) for a relevant photo + caption overlay
// is handled naturally by IG's caption field. When CLOUDINARY_URL is set,
// uploads a branded text-on-image card instead.
async function generateIgBrandImage(caption, handle) {
  // Extract first keyword from caption for a relevant Unsplash photo
  const keyword = (caption.match(/\b(business|tech|roblox|trading|game|money|brand|success|marketing)\b/i) || ['business'])[0].toLowerCase();
  // Unsplash Source — free, no API key, returns a redirect to a real photo
  // 1080x1080 is IG square format
  return `https://source.unsplash.com/1080x1080/?${encodeURIComponent(keyword)},professional`;
}

// ── Raw HTTP POST helper ───────────────────────────────────────────────────────
async function httpPostRaw(url, body, headers) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── Full pipeline: research → create → queue/deploy ──────────────────────────
async function runSocialTeam(platform, accountKey, autoPost = false) {
  if (!CONFIG.teams.social.active) return '⬜ Social Team is inactive. Use /team social on';

  const label = accountKey ? `${platform}/${accountKey}` : platform;
  print(`\n📱 Social Team — researching ${label.toUpperCase()}…`);
  log(`SOCIAL_TEAM_START [${label}]`);

  // Phase 1: Research
  const research = await socialResearch(platform);
  print(`\n📊 Research complete. Creating content…`);

  // Phase 2: Create
  const pkg = await socialCreate(platform, research, accountKey);
  print(`\n✍️  Content ready.`);

  // Extract caption for queue
  const captionMatch = pkg.match(/CAPTION:\s*([^\n]+(?:\n(?!(?:HOOK|CTA|HASHTAGS|BEST|CONTENT|VIDEO|SPONSORSHIP):)[^\n]*)*)/i);
  const caption = captionMatch ? captionMatch[1].trim() : pkg.substring(0, 500);

  const queueEntry = {
    id:        Date.now(),
    platform,
    accountKey: accountKey || null,
    caption,
    fullPackage: pkg,
    research,
    createdAt: new Date().toISOString(),
    deployed:  false,
  };
  CONFIG.social.postQueue.push(queueEntry);
  CONFIG.social.lastRun[label] = new Date().toISOString();

  chromaAdd('social', { content: `[Social] ${label}: ${caption.substring(0,200)}`, source: 'social-team' });
  log(`SOCIAL_TEAM_QUEUED [${label}]: ${caption.substring(0,100)}`);

  let deployResult = '';
  if (autoPost) {
    print(`\n🚀 Auto-posting to ${label}…`);
    deployResult = await socialDeploy(platform, { caption }, accountKey);
    queueEntry.deployed = true;
    queueEntry.deployResult = deployResult;
    log(`SOCIAL_DEPLOY [${label}]: ${deployResult.substring(0,100)}`);
    await notify(`Social Posted: ${label}`, deployResult.substring(0,200), 'normal');
  }

  return `📱 Social Team [${label}]:\n\n${pkg}\n${autoPost ? `\n🚀 Deploy: ${deployResult}` : '\n📌 Queued — use /social deploy ' + queueEntry.id + ' to post'}`;
}

// ── Run all platforms at once ─────────────────────────────────────────────────
async function runSocialAll(autoPost = false) {
  const platforms = [
    { platform: 'tiktok',    accountKey: null },
    { platform: 'twitter',   accountKey: null },
    { platform: 'instagram', accountKey: 'alikon_marketing' },
    { platform: 'instagram', accountKey: 'onairnetwork_inc' },
    { platform: 'instagram', accountKey: 'tjsdemoreels' },
  ];
  const results = [];
  for (const { platform, accountKey } of platforms) {
    results.push(await runSocialTeam(platform, accountKey, autoPost));
  }
  return results.join('\n\n---\n\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── VOICE / WHISPER STT ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function ensureVoiceRecorder() {
  // Always rewrite so latest version is on disk
  const script = `# AIKON-OS Voice Recorder v2 — auto-detects working input device
import sys, sounddevice as sd, soundfile as sf, numpy as np
SAMPLE_RATE = 16000
DURATION    = int(sys.argv[1]) if len(sys.argv) > 1 else 5
OUT_FILE    = sys.argv[2] if len(sys.argv) > 2 else "voice_input.wav"

def try_record(device_index=None):
    audio = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE,
                   channels=1, dtype='int16', device=device_index)
    sd.wait()
    return audio

# Try default device first, then scan all input devices
devices = sd.query_devices()
tried = []
audio = None

# 1. Try default input
try:
    print(f"[VOICE] Recording {DURATION}s... speak now", flush=True)
    audio = try_record(None)
except Exception as e:
    tried.append(f"default: {e}")

# 2. Scan for any working input device
if audio is None:
    for i, dev in enumerate(devices):
        if dev['max_input_channels'] > 0:
            try:
                audio = try_record(i)
                print(f"[VOICE] Using device {i}: {dev['name']}", flush=True)
                break
            except Exception as e:
                tried.append(f"dev{i} ({dev['name']}): {e}")

if audio is None:
    print(f"[VOICE_ERR] No working input device found. Tried: {tried}", flush=True)
    sys.exit(1)

sf.write(OUT_FILE, audio, SAMPLE_RATE)
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
    stopSpeaking(); // interrupt any ongoing TTS before we record
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

// ─── /READ — UNIVERSAL FILE READER ───────────────────────────────────────────
async function cmdRead(filePath) {
  const path = require('path');
  const fs   = require('fs');
  const ext  = path.extname(filePath).toLowerCase();

  if (!fs.existsSync(filePath)) {
    print(`❌ File not found: ${filePath}`);
    return;
  }
  const stat = fs.statSync(filePath);
  print(`📂 Reading: ${filePath}  (${(stat.size/1024).toFixed(1)} KB)`);

  // ── Plain text formats ──────────────────────────────────────────────────────
  const textExts = ['.txt','.md','.markdown','.log','.env','.yaml','.yml',
                    '.toml','.ini','.cfg','.conf','.sh','.bat','.ps1'];
  if (textExts.includes(ext)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n');
    print(`─── ${lines.length} lines ───`);
    lines.slice(0, 200).forEach((l, i) => print(`  ${String(i+1).padStart(4,' ')} │ ${l}`));
    if (lines.length > 200) print(`  ... (${lines.length - 200} more lines — file truncated at 200)`);
    return;
  }

  // ── Code / data formats ─────────────────────────────────────────────────────
  const codeExts = ['.js','.ts','.jsx','.tsx','.py','.rb','.go','.java',
                    '.c','.cpp','.h','.cs','.rs','.php','.html','.css','.sql'];
  if (codeExts.includes(ext)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n');
    print(`─── ${lines.length} lines (${ext}) ───`);
    lines.slice(0, 200).forEach((l, i) => print(`  ${String(i+1).padStart(4,' ')} │ ${l}`));
    if (lines.length > 200) print(`  ... (${lines.length - 200} more lines)`);
    return;
  }

  // ── JSON ────────────────────────────────────────────────────────────────────
  if (ext === '.json' || ext === '.jsonl') {
    try {
      const raw  = fs.readFileSync(filePath, 'utf8');
      if (ext === '.jsonl') {
        const lines = raw.trim().split('\n');
        print(`─── JSONL: ${lines.length} records ───`);
        lines.slice(0, 20).forEach((l, i) => {
          try { print(`  [${i}] ${JSON.stringify(JSON.parse(l), null, 0).substring(0, 200)}`); }
          catch { print(`  [${i}] (invalid json) ${l.substring(0,100)}`); }
        });
        if (lines.length > 20) print(`  ... (${lines.length - 20} more records)`);
      } else {
        const obj = JSON.parse(raw);
        const pretty = JSON.stringify(obj, null, 2);
        const lines  = pretty.split('\n');
        print(`─── JSON: ${lines.length} lines ───`);
        lines.slice(0, 100).forEach(l => print(`  ${l}`));
        if (lines.length > 100) print(`  ... (${lines.length - 100} more lines)`);
      }
    } catch(e) {
      print(`❌ JSON parse error: ${e.message}`);
    }
    return;
  }

  // ── CSV ─────────────────────────────────────────────────────────────────────
  if (ext === '.csv' || ext === '.tsv') {
    const raw   = fs.readFileSync(filePath, 'utf8');
    const sep   = ext === '.tsv' ? '\t' : ',';
    const lines = raw.trim().split('\n');
    const cols  = lines[0].split(sep);
    print(`─── ${ext.toUpperCase()}: ${lines.length - 1} rows × ${cols.length} cols ───`);
    print(`  COLS: ${cols.join(' | ')}`);
    lines.slice(1, 11).forEach((l, i) => print(`  [${i+1}] ${l.substring(0,200)}`));
    if (lines.length > 11) print(`  ... (${lines.length - 11} more rows)`);
    return;
  }

  // ── PDF ─────────────────────────────────────────────────────────────────────
  if (ext === '.pdf') {
    const { execSync } = require('child_process');
    try {
      // Try pdftotext (poppler-utils)
      const text = execSync(`pdftotext "${filePath}" -`, { encoding:'utf8', timeout:15000 });
      const lines = text.split('\n').filter(l => l.trim());
      print(`─── PDF TEXT: ${lines.length} lines ───`);
      lines.slice(0, 100).forEach(l => print(`  ${l}`));
      if (lines.length > 100) print(`  ... (${lines.length - 100} more lines)`);
    } catch(e) {
      print(`⚠️  pdftotext not available. Install: choco install poppler`);
      print(`   File size: ${(stat.size/1024).toFixed(1)} KB — binary PDF`);
    }
    return;
  }

  // ── DOCX ────────────────────────────────────────────────────────────────────
  if (ext === '.docx' || ext === '.doc') {
    try {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ path: filePath });
      const lines   = result.value.split('\n').filter(l => l.trim());
      print(`─── DOCX TEXT: ${lines.length} lines ───`);
      lines.slice(0, 100).forEach(l => print(`  ${l}`));
      if (lines.length > 100) print(`  ... (${lines.length - 100} more lines)`);
    } catch(e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        print(`⚠️  mammoth not installed. Run: npm install mammoth`);
      } else {
        print(`❌ DOCX error: ${e.message}`);
      }
    }
    return;
  }

  // ── XLSX ────────────────────────────────────────────────────────────────────
  if (ext === '.xlsx' || ext === '.xls' || ext === '.ods') {
    try {
      const xlsx    = require('node-xlsx');
      const sheets  = xlsx.parse(filePath);
      print(`─── XLSX: ${sheets.length} sheet(s) ───`);
      sheets.forEach((sheet, si) => {
        print(`  ── Sheet ${si+1}: "${sheet.name}" (${sheet.data.length} rows) ──`);
        sheet.data.slice(0, 20).forEach((row, ri) => {
          print(`    [${ri}] ${row.map(c => String(c ?? '').substring(0,20)).join(' | ')}`);
        });
        if (sheet.data.length > 20) print(`    ... (${sheet.data.length - 20} more rows)`);
      });
    } catch(e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        print(`⚠️  node-xlsx not installed. Run: npm install node-xlsx`);
      } else {
        print(`❌ XLSX error: ${e.message}`);
      }
    }
    return;
  }

  // ── ZIP / archive ───────────────────────────────────────────────────────────
  if (ext === '.zip' || ext === '.tar' || ext === '.gz' || ext === '.7z') {
    const { execSync } = require('child_process');
    try {
      let list;
      if (ext === '.zip') {
        list = execSync(`unzip -l "${filePath}"`, { encoding:'utf8', timeout:10000 });
      } else {
        list = execSync(`tar -tvf "${filePath}" 2>&1 || 7z l "${filePath}" 2>&1`, { encoding:'utf8', timeout:10000 });
      }
      const lines = list.split('\n').slice(0, 50);
      print(`─── ARCHIVE CONTENTS ───`);
      lines.forEach(l => print(`  ${l}`));
    } catch(e) {
      print(`⚠️  Archive listing failed: ${e.message}`);
      print(`   Install unzip / tar to list contents.`);
    }
    return;
  }

  // ── Images ──────────────────────────────────────────────────────────────────
  const imgExts = ['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.svg'];
  if (imgExts.includes(ext)) {
    const { execSync } = require('child_process');
    print(`─── IMAGE FILE ───`);
    print(`  Format : ${ext.toUpperCase().slice(1)}`);
    print(`  Size   : ${(stat.size/1024).toFixed(1)} KB`);
    if (ext === '.svg') {
      const content = fs.readFileSync(filePath, 'utf8');
      print(`  SVG lines: ${content.split('\n').length}`);
      print(`  Preview  : ${content.substring(0,300)}`);
    } else {
      try {
        const info = execSync(`identify "${filePath}" 2>&1`, { encoding:'utf8', timeout:5000 });
        print(`  Info   : ${info.trim()}`);
      } catch {
        print(`  (Install ImageMagick for dimension info: choco install imagemagick)`);
      }
    }
    return;
  }

  // ── Audio / Video ───────────────────────────────────────────────────────────
  const mediaExts = ['.mp3','.wav','.flac','.ogg','.aac','.mp4','.mov','.mkv','.avi','.webm','.m4a'];
  if (mediaExts.includes(ext)) {
    const { execSync } = require('child_process');
    print(`─── MEDIA FILE ───`);
    print(`  Format : ${ext.toUpperCase().slice(1)}`);
    print(`  Size   : ${(stat.size / (1024*1024)).toFixed(2)} MB`);
    try {
      const info = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}" 2>&1`, { encoding:'utf8', timeout:10000 });
      const d    = JSON.parse(info);
      const fmt  = d.format || {};
      print(`  Duration : ${parseFloat(fmt.duration||0).toFixed(1)}s`);
      print(`  Bit rate : ${Math.round((fmt.bit_rate||0)/1000)} kbps`);
      (d.streams||[]).forEach((s, i) => print(`  Stream ${i}: ${s.codec_type} ${s.codec_name} ${s.width?s.width+'x'+s.height:''}`));
    } catch {
      print(`  (Install ffmpeg for media metadata: choco install ffmpeg)`);
    }
    return;
  }

  // ── Fallback: hex preview ───────────────────────────────────────────────────
  const buf = fs.readFileSync(filePath);
  const hex = [...buf.slice(0,64)].map(b=>b.toString(16).padStart(2,'0')).join(' ');
  print(`─── BINARY FILE (${ext || 'unknown'}) ───`);
  print(`  Size    : ${(stat.size/1024).toFixed(1)} KB`);
  print(`  Hex(64B): ${hex}`);
  print(`  (No reader available for ${ext || 'this type'})`);
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
      const approveDecideMs = approval.queuedAt ? Date.now() - approval.queuedAt : null;
      print(`✅ Approved: ${approval.action}`);
      log(`APPROVAL: approved [${id}] ${approval.action}`);
      movementRecordDecision(approval.action.substring(0,60), true, approveDecideMs);
      chromaAdd('aikon_os', { insight: `Approved: ${approval.action} — ${approval.details}` });
      try { await approval.executeFn(); } catch(e) { print(`❌ Execution failed: ${e.message}`); }
      break;
    }

    case '/deny': {
      const id = parseInt(args);
      const idx = CONFIG.pendingApprovals.findIndex(a => a.id === id);
      if (idx === -1) { print(`❌ No pending approval #${id}`); break; }
      const approval = CONFIG.pendingApprovals.splice(idx, 1)[0];
      const denyDecideMs = approval.queuedAt ? Date.now() - approval.queuedAt : null;
      print(`🚫 Denied: ${approval.action}`);
      log(`APPROVAL: denied [${id}] ${approval.action}`);
      movementRecordDecision(approval.action.substring(0,60), false, denyDecideMs);
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
      if (args === 'stop' || args === 'interrupt') {
        stopSpeaking();
        print('🔇 Speech stopped.');
        break;
      }
      if (args === 'mobile') {
        // Mobile voice: send command from ntfy app on phone → Commander executes it
        if (!CONFIG.ntfyTopic) { print('❌ NTFY_TOPIC not set in .env — required for mobile voice.'); break; }
        print(`📱 Mobile mode — send a message to ntfy topic: ${CONFIG.ntfyTopic}`);
        print(`   App: ntfy.sh  |  Topic: ${CONFIG.ntfyTopic}  |  Waiting 60s...`);
        const sinceTs = Math.floor(Date.now() / 1000); // unix seconds — only catch NEW messages
        let found = false;
        const start = Date.now();
        const poll = setInterval(async () => {
          if (Date.now() - start > 60_000) {
            clearInterval(poll);
            if (!found) print('⏱️  Mobile voice timed out — no message received.');
            return;
          }
          try {
            const res = await new Promise((resolve, reject) => {
              const req = https.get(
                `https://ntfy.sh/${CONFIG.ntfyTopic}/json?poll=1&since=${sinceTs}`,
                { headers: { 'User-Agent': 'AIKON-Commander' } },
                r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); }
              );
              req.on('error', reject);
              req.setTimeout(5000, () => { req.destroy(); reject(new Error('poll timeout')); });
            });
            const lines = res.trim().split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                if (msg.event === 'message' && msg.message && (msg.time||0) >= sinceTs) {
                  clearInterval(poll);
                  found = true;
                  const text = msg.message.trim();
                  print(`📱 Mobile: "${text}"`);
                  if (text.startsWith('/')) {
                    await handleCommand(text, rl);
                  } else {
                    print('🤔 Thinking...');
                    remember('user', `[mobile] ${text}`);
                    try {
                      const { reply, model } = await askOllama(text, memory.filter(m => m.role !== 'note'));
                      print(`\nCommander [${model}]: ${reply}\n`);
                      speak(reply);
                      remember('assistant', reply);
                    } catch(e) { print(`❌ ${e.message}`); }
                  }
                  break;
                }
              } catch(e) {}
            }
          } catch(e) { /* silent poll error — keep trying */ }
        }, 3000);
        break;
      }
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

    // ── /social ───────────────────────────────────────────────────────────────
    case '/social': {
      const [sub, ...rest] = args.split(' ');
      const extra = rest.join(' ');

      if (!sub || sub === 'help') {
        print(`📱 Social Media Team Commands:
  /social status          — Show accounts + post queue
  /social research <platform>  — Run research only (tiktok|twitter|instagram)
  /social create <platform> [account]  — Research + create content package
  /social run             — Run all platforms (queues content, no auto-post)
  /social run auto        — Run all platforms + auto-post where API ready
  /social run <platform> [account]  — Run one platform
  /social deploy <id>     — Post queued content by ID
  /social queue           — Show pending post queue
  /social clear           — Clear post queue
Accounts: tiktok=@al.ikon.unlimited | twitter=@Al_ikonunltd
          instagram: alikon_marketing | onairnetwork_inc | tjsdemoreels`);
        break;
      }

      if (sub === 'status') {
        const q = CONFIG.social.postQueue;
        const pending = q.filter(p => !p.deployed).length;
        const deployed = q.filter(p => p.deployed).length;
        print(`📱 Social Team Status:`);
        print(`  TikTok   : @al.ikon.unlimited | token: ${CONFIG.social.tiktok.accessToken ? '✅' : '⚠️  not set'}`);
        print(`  X/Twitter: @Al_ikonunltd | bearer: ${CONFIG.social.twitter.bearerToken ? '✅' : '⚠️'} | post: ${CONFIG.social.twitter.accessToken && CONFIG.social.twitter.apiKey ? '✅' : '⚠️  not set'}`);
        print(`  Instagram: 3 accounts | tokens: ${
          ['alikon_marketing','onairnetwork_inc','tjsdemoreels']
            .map(k => `${k}=${CONFIG.social.instagram.accounts[k].accessToken ? '✅' : '⚠️'}`)
            .join(' | ')}`);
        print(`  Queue    : ${pending} pending | ${deployed} deployed`);
        if (CONFIG.social.lastRun && Object.keys(CONFIG.social.lastRun).length) {
          print(`  Last runs:`);
          Object.entries(CONFIG.social.lastRun).forEach(([k,v]) => print(`    ${k}: ${v}`));
        }
        break;
      }

      if (sub === 'queue') {
        const q = CONFIG.social.postQueue.filter(p => !p.deployed);
        if (!q.length) { print('📭 No pending posts.'); break; }
        q.forEach(p => print(`  [${p.id}] ${p.platform}${p.accountKey ? '/'+p.accountKey : ''} — ${p.caption.substring(0,80)}…`));
        break;
      }

      if (sub === 'clear') {
        CONFIG.social.postQueue = [];
        print('🗑️  Post queue cleared.');
        break;
      }

      if (sub === 'research') {
        const platform = extra.trim() || 'tiktok';
        print(`📊 Researching ${platform}…`);
        const r = await socialResearch(platform);
        print(r);
        break;
      }

      if (sub === 'deploy') {
        const id = parseInt(extra.trim(), 10);
        const item = CONFIG.social.postQueue.find(p => p.id === id);
        if (!item) { print(`❌ No queued post with ID ${id}`); break; }
        if (item.deployed) { print(`⚠️  Already deployed.`); break; }
        print(`🚀 Deploying post ${id} to ${item.platform}…`);
        const r = await socialDeploy(item.platform, { caption: item.caption }, item.accountKey);
        item.deployed = true; item.deployResult = r;
        print(r);
        await notify(`Social Posted`, r.substring(0,200), 'normal');
        break;
      }

      if (sub === 'run') {
        const autoPost = rest[0] === 'auto';
        const specificPlatform = (!autoPost && rest[0]) ? rest[0] : null;
        const specificAccount  = (!autoPost && rest[1]) ? rest[1] : null;

        if (specificPlatform) {
          const r = await runSocialTeam(specificPlatform, specificAccount, autoPost);
          print(r);
        } else {
          print(`📱 Running Social Team across all platforms${autoPost ? ' (AUTO-POST)' : ' (queue mode)'}…`);
          const r = await runSocialAll(autoPost);
          print(r);
        }
        break;
      }

      if (sub === 'create') {
        const [platform, accountKey] = extra.split(' ');
        if (!platform) { print('Usage: /social create <platform> [accountKey]'); break; }
        const r = await runSocialTeam(platform, accountKey || null, false);
        print(r);
        break;
      }

      print(`Unknown social subcommand: ${sub}. Try /social help`);
      break;
    }

    // ── /optimize ─────────────────────────────────────────────────────────────
    case '/optimize': {
      const sub = args.trim();
      if (sub === 'status' || sub === 'snap') {
        const s = getSystemSnapshot();
        print(`📊 System Snapshot:\n  CPU: ${s.cpu}%\n  RAM: ${s.ram}%\n  Top processes:\n${s.top}`);
        break;
      }
      if (sub === 'ollama') {
        print('🤖 Throttling Ollama…');
        print(await throttleOllama());
        break;
      }
      if (sub === 'ram') {
        print('🧹 Freeing RAM…');
        print(await freeRam());
        break;
      }
      if (sub === 'power') {
        print('⚡ Setting High Performance power plan…');
        print(await setPowerPlan());
        break;
      }
      if (sub === 'hogs') {
        print('🗑️  Killing background hogs…');
        print(await killHogs());
        break;
      }
      if (sub === 'monitor on') {
        startCpuMonitor();
        print('👀 CPU monitor started — auto-optimizes when CPU>70% or RAM>85%');
        break;
      }
      // Default: full optimize
      await runOptimize(true);
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
      // S-16: validate against whitelist/blocklist before executing
      const shellCheck = secValidateShellCmd(args);
      if (!shellCheck.ok) {
        print(`🚫 [S-16] Shell command blocked: ${shellCheck.reason}`);
        secAudit('SHELL_BLOCKED', args);
        break;
      }
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

    case '/read': {
      if (!args) { print('Usage: /read <filepath>'); break; }
      await cmdRead(args.trim());
      break;
    }

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
  /team                — 🤖 List teams (Trader/Biz/Research/Roblox/Social)
  /team <key> <task>   — Run a team on a task
  /optimize            — ⚡ Full system optimize (throttle Ollama, free RAM, kill hogs)
  /optimize status     — 📊 CPU/RAM snapshot + top processes
  /optimize ollama     — 🤖 Throttle Ollama to BelowNormal priority
  /optimize ram        — 🧹 Free RAM + clear temp files
  /optimize monitor on — 👀 Auto-optimize when CPU>70%
  /social              — 📱 Social Media Team (TikTok/X/Instagram)
  /social run          — Research + create content for all platforms
  /social run auto     — Research + create + auto-post where API ready
  /social status       — Show accounts, tokens, post queue
  /social deploy <id>  — Post a queued content package
  /trader, /report     — 📊 Live trader status
  /learn               — 🧠 Run background learn cycle now
  /memory [branch]     — 📚 Show ChromaDB memory
  /chroma [branch]     — 📚 Same as /memory
  /opportunities       — 💡 Opportunity scan + history
  /scout               — 💡 Same as /opportunities
  /auto [status|run|ask|daily|history|decisions|on|off] — 🤖 Autonomy engine
  /auto peer [on|off|ask] <id>  — Query/toggle AI peer (ollama-local, deepseek-local, claude-api)
  /auto report <title>          — Save manual incident report
  /security [status|audit|threats|scan|lockout|green|yellow|red] — 🔒 Security (S-01–S-10)
  /security allowip <ip> | blockip <ip> | ratelimit — 🛡️  Anti-hacking (S-13/S-14)
  /security token list | token revoke <suffix>      — 🔑 Session tokens (S-15)
  /security chain verify | backup now | nonce stats — 🔗 Audit chain/backup (S-18/S-19)
  /killswitch [arm|fire|disarm]                     — 💀 Emergency lockdown (S-20)
  /intel [kpi|scan|feeds|sentiment|patterns|forecast|synth|decisions|market] — 🧠 Intelligence
  /comms [status|broadcast|webhook|slack|discord|queue|flush|peers|log] — 📡 Communications
  /approvals           — ⏳ Show pending approvals
  /approve <id>        — ✅ Approve a queued action
  /deny <id>           — 🚫 Deny a queued action
  /bridge status|history|send — 🌉 Bridge control
  /brain status|sync|opportunities — 🧠 Brain (Render 24/7) control
  /claude <question>   — 💬 Ask Claude a question (answer arrives on next tick)
  /branch add|list     — 🌿 Manage business branches
  /status              — 🖥️  Full system status
  /shell <cmd>         — ⚙️  Run shell command
  /read <file>         — 📂 Read any file (txt/md/json/js/py/csv/pdf/docx/xlsx/img/zip)
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

    // ── ASK CLAUDE ──────────────────────────────────────────────────────────────
    case '/claude': {
      if (!args) { print('Usage: /claude <question>'); break; }
      const qId = `q-${Date.now()}`;

      // Path 1: askAI chain (Ollama → Groq → OpenRouter → Gemini, auto-fallback)
      print(`🤖 Asking AI [${qId}]...`);
      try {
        const kpi = intelUpdateKPI();
        const systemCtx = `You are advising AIKON-OS Commander (v${CONFIG.version}) for Al iKon (Al iKon Unlimited LLC).
Current state: Threat=${kpi.threatLevel} | Trader balance=${kpi.traderBalance??'unknown'} | Uptime=${kpi.uptime}
Active projects: XAU/USD Trader, Silent Santa Roblox, StreamNet, Restaurant Web Agency.
Be direct, concise, actionable. 3-6 sentences max. This prints in Commander terminal.`;
        const { text: answer, provider } = await askAI(args, systemCtx, 600);
        print(`\n🤖 [${provider}]: ${answer}\n`);
        log(`AI-DIRECT [${qId}] via ${provider}: Q=${args.substring(0,80)} A=${answer.substring(0,100)}`);
        chromaAdd('aikon_os', { insight: `[/claude] Q:${args.substring(0,100)} A:${answer.substring(0,200)}`, source: `ai_${provider}` });
      } catch(e) {
        print(`❌ AI error: ${e.message}`);
        log(`AI-DIRECT-ERR [${qId}]: ${e.message}`);
        if (CONFIG.brainUrl) {
          print(`📡 Falling back to Brain relay [${qId}]...`);
          try {
            await httpPost(CONFIG.brainUrl.replace(/\/$/, '') + '/relay/claude-ask', { question: args, id: qId }, bridgeHeaders());
            print('  Answer will arrive on next heartbeat tick (~5s)');
          } catch(be) { print(`❌ Brain relay also failed: ${be.message}`); }
        }
      }
      break;
      // Path 2: Brain relay fallback (kept for legacy — normally askAI chain handles everything)
      if (!CONFIG.brainUrl) { print('❌ No AI providers available and no BRAIN_URL'); break; }
      print(`📡 Sending to Claude via Brain relay [${qId}]... (answer arrives in ~5s on next heartbeat)`);
      try {
        await httpPost(CONFIG.brainUrl.replace(/\/$/, '') + '/relay/claude-ask', { question: args, id: qId }, bridgeHeaders());
        log(`CLAUDE-ASK-RELAY [${qId}]: ${args}`);
      } catch(e) {
        print(`❌ Failed to reach Brain: ${e.message}`);
      }
      break;
    }

    // ── SECURITY COMMAND ──────────────────────────────────────────────────────
    case '/security': {
      const sub = args || 'status';
      if (sub === 'status') {
        const s = CONFIG.security;
        print(`\n🔒 SECURITY STATUS [S-10: ${s.threatLevel}]`);
        print(`  Locked sources:   ${s.lockedSources.size > 0 ? [...s.lockedSources].join(', ') : 'none'}`);
        print(`  Failed attempts:  ${JSON.stringify(s.failedAttempts)}`);
        print(`  Anomaly events:   ${s.anomalyLog.length} (last 500 kept)`);
        print(`  Integrity hashes: ${Object.keys(s.integrityHashes).length} files tracked`);
        print(`  Encryption flag:  ${s.encryptionFlag ? '✓ ON' : '✗ OFF'}`);
        print(`  Audit file:       ${s.auditFile}`);
        print(`  RAG access log:   ${s.ragLog.length} entries`);
        secIntegrityCheck();
        secKeyRotationCheck();
      } else if (sub === 'audit') {
        const recent = CONFIG.security.anomalyLog.slice(-10);
        if (!recent.length) { print('No audit events yet.'); break; }
        print('\n📋 RECENT AUDIT LOG:');
        recent.forEach(e => print(`  [${e.event}] ${e.detail} (${e.source})`));
      } else if (sub === 'threats') {
        print(`\n⚡ THREAT LEVEL: ${CONFIG.security.threatLevel}`);
        const threats = CONFIG.security.anomalyLog.filter(e => e.event.includes('THREAT') || e.event === 'LOCKOUT' || e.event === 'ANOMALY').slice(-10);
        threats.length ? threats.forEach(e => print(`  ${e.ts} [${e.event}] ${e.detail}`)) : print('  No threat events logged.');
      } else if (sub === 'lockout') {
        const locked = [...CONFIG.security.lockedSources];
        if (!locked.length) { print('No locked sources.'); break; }
        print('🔒 Locked sources: ' + locked.join(', '));
        print('To reset: /security unlock <source>');
      } else if (sub.startsWith('unlock ')) {
        const src = sub.replace('unlock ', '').trim();
        secResetFails(src);
        print(`✅ ${src} unlocked and fail count reset.`);
      } else if (sub === 'scan') {
        secIntegrityCheck();
        secKeyRotationCheck();
        secCheckAnomaly('scan', null);
        print(`🔍 Security scan complete. Threat: ${CONFIG.security.threatLevel}`);
      } else if (sub === 'green') {
        setThreatLevel('GREEN', 'Manual reset by operator');
      } else if (sub === 'yellow') {
        setThreatLevel('YELLOW', 'Manual alert by operator');
      } else if (sub === 'red') {
        setThreatLevel('RED', 'Manual RED ALERT by operator');
      } else if (sub.startsWith('allowip ')) {
        const ip = sub.replace('allowip ', '').trim();
        secAllowIP(ip);
        CONFIG.security.ipAllowlistEnabled = true;
        print(`✅ IP allowlist ON — ${ip} allowed`);
      } else if (sub.startsWith('blockip ')) {
        const ip = sub.replace('blockip ', '').trim();
        secBlockIP(ip);
        print(`🚫 ${ip} removed from allowlist`);
      } else if (sub === 'ratelimit') {
        const map = CONFIG.security.rateLimitMap;
        const entries = Object.entries(map);
        print(`\n🚦 RATE LIMIT STATUS (${CONFIG.security.rateLimitMax} req/${CONFIG.security.rateLimitWindowMs/1000}s window)`);
        if (!entries.length) { print('  No IPs tracked yet.'); }
        else entries.forEach(([ip, v]) => print(`  ${ip}: ${v.count} req (window age ${Math.round((Date.now()-v.windowStart)/1000)}s)`));
      } else if (sub === 'token list') {
        const tokens = Object.entries(CONFIG.security.sessionTokens);
        print(`\n🔑 ACTIVE SESSION TOKENS (${tokens.length})`);
        if (!tokens.length) { print('  None.'); }
        else tokens.forEach(([tok, rec]) => print(`  ...${tok.slice(-8)} | src: ${rec.source} | expires in ${Math.round((rec.expires-Date.now())/60000)}min`));
      } else if (sub.startsWith('token revoke ')) {
        const partial = sub.replace('token revoke ', '').trim();
        const found = Object.keys(CONFIG.security.sessionTokens).filter(t => t.endsWith(partial));
        if (!found.length) { print('No matching token found.'); break; }
        found.forEach(t => { delete CONFIG.security.sessionTokens[t]; });
        print(`✅ Revoked ${found.length} token(s)`);
      } else if (sub === 'chain verify') {
        const result = secVerifyAuditChain();
        if (result.ok) print(`✅ [S-18] Audit chain intact — ${result.entries} entries verified`);
        else print(`🚨 [S-18] CHAIN TAMPERED at entry ${result.tampered_at || '?'} of ${result.entries} | ${result.error || ''}`);
      } else if (sub === 'backup now') {
        CONFIG.security.lastBackup = 0; // force backup
        await secEncryptedBackup();
        print(`✅ [S-19] Backup triggered`);
      } else if (sub === 'nonce stats') {
        secPruneNonces();
        print(`🔄 [S-12] Nonce store: ${CONFIG.security.usedNonces.size} active nonces (TTL ${CONFIG.security.nonceTtlMs/1000}s)`);
      } else {
        print('Usage: /security [status|audit|threats|lockout|scan|unlock <src>|green|yellow|red]');
        print('       /security allowip <ip> | blockip <ip> | ratelimit');
        print('       /security token list | token revoke <suffix>');
        print('       /security chain verify | backup now | nonce stats');
      }
      break;
    }

    // ── KILL SWITCH ───────────────────────────────────────────────────────────
    case '/killswitch': {
      const ksSub = (args || '').trim().toLowerCase();
      if (ksSub === 'arm') {
        CONFIG.security.killswitchArmed = true;
        print('⚠️  Kill switch ARMED. Type /killswitch fire to execute. This cannot be undone without restart.');
      } else if (ksSub === 'fire') {
        if (!CONFIG.security.killswitchArmed) {
          print('❌ Kill switch not armed. Type /killswitch arm first.');
          break;
        }
        await secKillSwitch();
      } else if (ksSub === 'disarm') {
        CONFIG.security.killswitchArmed = false;
        print('✅ Kill switch disarmed.');
      } else {
        const armed = CONFIG.security.killswitchArmed;
        print(`💀 KILL SWITCH — Status: ${armed ? '⚠️  ARMED' : '⬛ DISARMED'}`);
        print('   /killswitch arm   — arm the kill switch');
        print('   /killswitch fire  — execute (must be armed first)');
        print('   /killswitch disarm — disarm');
      }
      break;
    }

    // ── INTEL COMMAND ─────────────────────────────────────────────────────────
    case '/intel': {
      const sub = args || 'kpi';
      if (sub === 'kpi' || sub === 'status') {
        const kpi = intelUpdateKPI();
        print(`\n📊 INTEL KPI SNAPSHOT [${kpi.ts}]`);
        print(`  Trader balance:   ${kpi.traderBalance != null ? '$'+kpi.traderBalance : 'N/A'}`);
        print(`  Trader win rate:  ${kpi.traderWinRate ?? 'N/A'}`);
        print(`  Memory entries:   ${kpi.memoryEntries} across ${kpi.branches} branches`);
        print(`  Threat level:     ${kpi.threatLevel}`);
        print(`  Uptime:           ${kpi.uptime}`);
        print(`  DeepSeek:         ${kpi.deepseek}`);
        print(`  TTS / Voice:      ${kpi.tts} / ${kpi.voice}`);
      } else if (sub === 'scan') {
        print('🔍 Running deep intel scan...');
        await intelDeepScan().catch(e => print(`Intel scan err: ${e.message}`));
        print('✅ Deep scan complete.');
      } else if (sub === 'feeds') {
        print('📡 Fetching live feeds...');
        await intelFeedIngestion().catch(e => print(`Feed err: ${e.message}`));
        print('✅ Feed ingestion done.');
      } else if (sub === 'sentiment') {
        const col = chromaMemory.collections['trader'] || [];
        const last = col.slice(-1)[0];
        if (!last) { print('No trader data for sentiment.'); break; }
        const r = intelSentiment(last.insight || '');
        print(`\n📈 SENTIMENT: ${r.signal} (bull:${r.bull} bear:${r.bear} score:${r.score})`);
      } else if (sub === 'patterns') {
        const top = intelPatternDetect();
        print('\n🔎 TOP PATTERNS ACROSS MEMORY:');
        print('  ' + top.join('  '));
      } else if (sub === 'forecast') {
        const f = intelForecast();
        print(`\n🔮 FORECAST: ${f.trend} | Avg Δ $${f.avgDelta}/cycle | In 5 cycles: $${f.forecast}`);
      } else if (sub === 'synth') {
        print('🧬 Running cross-branch synthesis...');
        const result = await intelCrossBranchSynth().catch(e => `Synth error: ${e.message}`);
        print(`\n💡 SYNTHESIS:\n${result}`);
      } else if (sub === 'decisions') {
        const log = CONFIG.intel.decisionLog.slice(-10);
        if (!log.length) { print('No decisions logged yet.'); break; }
        print('\n📝 RECENT DECISIONS:');
        log.forEach(d => print(`  [${d.ts}] ${d.action}: ${d.reasoning.substring(0,80)} [${d.outcome}]`));
      } else if (sub === 'market') {
        print('🌐 Running market scan...');
        const results = await intelMarketScan().catch(() => []);
        results.length ? results.forEach(r => print(`  • ${r}`)) : print('No results.');
      } else {
        print('Usage: /intel [kpi|scan|feeds|sentiment|patterns|forecast|synth|decisions|market]');
      }
      break;
    }

    // ── COMMS COMMAND ─────────────────────────────────────────────────────────
    case '/comms': {
      const sub = args || 'status';
      if (sub === 'status') {
        const h = await commsHealthCheck();
        print('\n📡 COMMS STATUS:');
        h.split('\n').forEach(l => print('  ' + l));
        print(`  broadcast log:  ${CONFIG.comms.broadcastLog.length} entries`);
      } else if (sub.startsWith('webhook ')) {
        const msg = sub.replace('webhook ', '');
        const ok = await commsSendWebhook({ message: msg, source: 'commander', ts: new Date().toISOString() });
        print(ok ? '✅ Webhook sent.' : '❌ Webhook failed (WEBHOOK_URL set?)');
      } else if (sub.startsWith('slack ')) {
        const msg = sub.replace('slack ', '');
        const ok = await commsSendSlack(msg);
        print(ok ? '✅ Slack sent.' : '❌ Slack failed (SLACK_URL set?)');
      } else if (sub.startsWith('discord ')) {
        const msg = sub.replace('discord ', '');
        const ok = await commsSendDiscord(msg);
        print(ok ? '✅ Discord sent.' : '❌ Discord failed (DISCORD_URL set?)');
      } else if (sub.startsWith('broadcast ')) {
        const msg = sub.replace('broadcast ', '');
        const ok = await sendComms(msg, 'operator');
        print(ok ? '✅ Broadcast sent on priority chain.' : '⚠️ No channels configured. Add WEBHOOK_URL / SLACK_URL / DISCORD_URL to .env');
      } else if (sub === 'queue') {
        print(`\n📬 MESSAGE QUEUE: ${CONFIG.comms.messageQueue.length} pending`);
        CONFIG.comms.messageQueue.slice(-5).forEach(m => print(`  [${m.priority}] ${m.message.substring(0,60)}`));
      } else if (sub === 'flush') {
        await commsFlushQueue();
        print('✅ Queue flushed.');
      } else if (sub === 'peers') {
        if (!CONFIG.comms.peerNodes.length) { print('No peer nodes registered. Use: /comms peer add <id> <url>'); break; }
        CONFIG.comms.peerNodes.forEach(p => print(`  ${p.id}: ${p.url} [${p.status}]`));
        await commsPingPeers();
        print('↑ Ping sent to all peers.');
      } else if (sub.startsWith('peer add ')) {
        const parts = sub.replace('peer add ', '').split(' ');
        if (parts.length < 2) { print('Usage: /comms peer add <id> <url>'); break; }
        commsRegisterPeer(parts[0], parts[1]);
      } else if (sub === 'log') {
        const recent = CONFIG.comms.broadcastLog.slice(-10);
        if (!recent.length) { print('No broadcast log yet.'); break; }
        print('\n📋 RECENT BROADCASTS:');
        recent.forEach(e => print(`  [${e.channel}] ${e.msg}`));
      } else {
        print('Usage: /comms [status|webhook <msg>|slack <msg>|discord <msg>|broadcast <msg>|queue|flush|peers|peer add <id> <url>|log]');
      }
      break;
    }

    // ── AUTO COMMAND ──────────────────────────────────────────────────────────
    case '/auto': {
      const sub = args || 'status';
      const cfg = CONFIG.autonomy;
      if (sub === 'status') {
        print(`\n🤖 AUTONOMY ENGINE v${CONFIG.version}`);
        print(`  Enabled:        ${cfg.enabled ? '✅ YES' : '❌ NO'}`);
        print(`  Loop count:     ${cfg.loopCount}`);
        print(`  Last loop:      ${cfg.lastLoopRun ? new Date(cfg.lastLoopRun).toLocaleTimeString() : 'never'}`);
        print(`  Self-asks done: ${cfg.selfAskHistory.length}`);
        print(`  Last self-ask:  ${cfg.lastSelfAsk ? new Date(cfg.lastSelfAsk).toLocaleTimeString() : 'never'}`);
        print(`  Decision queue: ${cfg.decisionQueue.length} pending`);
        print(`  Incidents:      ${cfg.incidentCount}`);
        print(`  Daily report:   ${cfg.lastDailyReport ? new Date(cfg.lastDailyReport).toLocaleDateString() : 'never'} (at ${cfg.dailyReportHour}:00)`);
        print(`  Report dir:     ${cfg.reportDir}`);
        print(`\n  AI PEERS:`);
        cfg.aiPeers.forEach(p => print(`    ${p.id}: ${p.type}/${p.model} [${p.active ? 'ACTIVE' : 'inactive'}]`));
        print(`\n  SELF-ASK TOPICS (${cfg.selfAskTopics.length} total, next: #${cfg.topicIndex % cfg.selfAskTopics.length}):`);
        cfg.selfAskTopics.slice(0,3).forEach((t,i) => print(`    ${i+1}. ${t}`));
      } else if (sub === 'run') {
        print('🤖 Running autonomy loop now...');
        CONFIG.autonomy.lastLoopRun = 0; // force run
        await autonomousLoop();
        print('✅ Autonomy loop complete.');
      } else if (sub === 'ask') {
        print('🤖 Running self-ask now...');
        CONFIG.autonomy.lastSelfAsk = 0; // force run
        const r = await autonomousSelfAsk();
        if (r) {
          print(`\n❓ Question: ${r.topic}`);
          print(`💡 Answer:   ${r.answer}`);
        }
      } else if (sub === 'daily') {
        print('📊 Generating daily report now...');
        CONFIG.autonomy.lastDailyReport = 0;
        const hour = CONFIG.autonomy.dailyReportHour;
        CONFIG.autonomy.dailyReportHour = new Date().getHours(); // force hour match
        await autonomousDailyReport();
        CONFIG.autonomy.dailyReportHour = hour;
        print('✅ Daily report sent.');
      } else if (sub === 'history') {
        const hist = cfg.selfAskHistory.slice(-5);
        if (!hist.length) { print('No self-ask history yet.'); break; }
        print('\n📚 SELF-ASK HISTORY (last 5):');
        hist.forEach((h,i) => {
          print(`\n  [${i+1}] ${h.ts}`);
          print(`  Q: ${h.topic}`);
          print(`  A: ${h.answer.substring(0,150)}...`);
        });
      } else if (sub === 'decisions') {
        if (!cfg.decisionQueue.length) { print('No pending autonomous decisions.'); break; }
        print(`\n⚡ PENDING DECISIONS (${cfg.decisionQueue.length}):`);
        cfg.decisionQueue.slice(-5).forEach((d,i) => print(`  ${i+1}. [${d.source}] ${d.action.substring(0,100)}`));
      } else if (sub === 'on') {
        cfg.enabled = true;
        print('✅ Autonomy engine ENABLED.');
        secAudit('AUTONOMY', 'Engine enabled by operator');
      } else if (sub === 'off') {
        cfg.enabled = false;
        print('⚠️ Autonomy engine DISABLED.');
        secAudit('AUTONOMY', 'Engine disabled by operator');
      } else if (sub.startsWith('peer ')) {
        const parts = sub.replace('peer ','').split(' ');
        const [action, peerId] = parts;
        const peer = cfg.aiPeers.find(p => p.id === peerId);
        if (!peer) { print(`Unknown peer: ${peerId}. Peers: ${cfg.aiPeers.map(p=>p.id).join(', ')}`); break; }
        if (action === 'on')  { peer.active = true;  print(`✅ Peer ${peerId} activated.`); }
        if (action === 'off') { peer.active = false; print(`⚠️ Peer ${peerId} deactivated.`); }
        if (action === 'ask') {
          const q = parts.slice(2).join(' ') || cfg.selfAskTopics[0];
          print(`📡 Querying ${peerId}...`);
          const r = await queryAIPeer(peerId, q);
          r.error ? print(`❌ ${r.error}`) : print(`\n💡 [${r.peer}/${r.model}]: ${r.answer}`);
        }
      } else if (sub.startsWith('report ')) {
        const title = sub.replace('report ','');
        await saveIncidentReport(title, `Manual report created by operator at ${new Date().toISOString()}`, 'INFO');
        print(`✅ Incident report saved to ${cfg.reportDir}`);
      } else {
        print('Usage: /auto [status|run|ask|daily|history|decisions|on|off|peer <on|off|ask> <id>|report <title>]');
      }
      break;
    }

    default:
      print(`Unknown command: ${cmd}. Type /help`);
  }
}

// ─── BANNER ───────────────────────────────────────────────────────────────────
function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        AIKON-OS COMMANDER v${CONFIG.version}                        ║
║        Al iKon Unlimited LLC  🧠 🎙️ 🔊 📱 🤖          ║
╠══════════════════════════════════════════════════════════╣
║  Trader:   xauusd-trader-80p0.onrender.com               ║
║  Models:   phi3:mini → deepseek-r1:7b (routing)          ║
║  Brain:    Railway 24/7 relay (all businesses)            ║
║  Teams:    Trader | Biz | Research | Roblox               ║
╠══════════════════════════════════════════════════════════╣
║  PROTOCOLS: 🔒 Security · 🧠 Intel · 📡 Comms · 🤖 Auto  ║
║   S-01–S-20 · I-01–I-10 · C-01–C-10 + Autonomy Engine    ║
╠══════════════════════════════════════════════════════════╣
║  /auto  |  /security  |  /intel  |  /comms  |  /killswitch║
╚══════════════════════════════════════════════════════════╝
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
// ═══════════════════════════════════════════════════════════════════════════════
// ─── MOVEMENT LEARNING v3.22 ─────────────────────────────────────────────────
// Commander observes Al iKon's activity — when he's active, what he approves,
// how fast he decides — and builds a behavioral model. Used to:
//   - Time autonomous tasks during his active hours (not 3am)
//   - Predict when he'll be available for approvals
//   - Learn what kinds of things he auto-approves vs reviews carefully
//   - Alert when he goes dark longer than usual (might need help)
// ═══════════════════════════════════════════════════════════════════════════════
function movementRecord(action, context = '') {
  const now    = new Date();
  const mv     = CONFIG.movement;
  const hour   = now.getHours();
  const day    = now.getDay();

  mv.lastSeen  = Date.now();
  mv.hourlyActive[hour]++;
  mv.dailyActive[day]++;
  mv.sessions.push({ ts: now.toISOString(), hour, day, action, context: context.substring(0,100) });
  if (mv.sessions.length > 500) mv.sessions = mv.sessions.slice(-500);

  // Persist to file
  try {
    fs.writeFileSync(mv.file, JSON.stringify({
      hourlyActive: mv.hourlyActive,
      dailyActive:  mv.dailyActive,
      sessions:     mv.sessions.slice(-200),
      patterns:     mv.patterns,
      lastSeen:     mv.lastSeen,
    }, null, 2));
  } catch(e) { /* silent */ }

  // Update patterns after every 10 recordings
  if (mv.sessions.length % 10 === 0) movementLearnPatterns();
}

function movementLearnPatterns() {
  const mv = CONFIG.movement;
  const h  = mv.hourlyActive;
  const d  = mv.dailyActive;

  // Peak hours (top 3 by activity)
  const peakHours = h.map((c,i) => ({h:i,c})).sort((a,b)=>b.c-a.c).slice(0,3).map(x=>x.h);

  // Most active day
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const peakDay = days[d.indexOf(Math.max(...d))];

  // Average time between sessions
  const gaps = mv.sessions.slice(-20).reduce((acc, s, i, arr) => {
    if (i === 0) return acc;
    const gap = new Date(s.ts) - new Date(arr[i-1].ts);
    if (gap < 3600000) acc.push(gap); // only gaps < 1hr (same session)
    return acc;
  }, []);
  const avgSessionGap = gaps.length ? Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length/1000) : null;

  // Decision speed — how fast approvals come in
  const decisions = mv.decisionLog.slice(-10);
  const avgDecisionMs = decisions.length
    ? decisions.reduce((a,b)=>a+(b.timeToDecide||0),0)/decisions.length
    : null;
  const approvalRate = decisions.length
    ? (decisions.filter(d=>d.approved).length / decisions.length * 100).toFixed(0)
    : null;

  mv.patterns = {
    peakHours,
    peakDay,
    avgSessionGapSec: avgSessionGap,
    avgDecisionSec:   avgDecisionMs ? Math.round(avgDecisionMs/1000) : null,
    approvalRate:     approvalRate ? `${approvalRate}%` : null,
    totalSessions:    mv.sessions.length,
    lastUpdated:      new Date().toISOString(),
  };

  log(`MOVEMENT: patterns updated — peak hours ${peakHours.join(',')} | peak day ${peakDay} | approval rate ${approvalRate??'unknown'}%`);
  chromaAdd('aikon_os', {
    insight: `Al iKon activity pattern: peak hours=${peakHours.map(h=>`${h}:00`).join(',')} | peak day=${peakDay} | approval rate=${approvalRate??'?'}% | avg decision=${mv.patterns.avgDecisionSec??'?'}s`,
    source: 'movement_learning',
  });
}

function movementRecordDecision(type, approved, timeToDecideMs) {
  const mv = CONFIG.movement;
  mv.decisionLog.push({ ts: new Date().toISOString(), type, approved, timeToDecide: timeToDecideMs });
  if (mv.decisionLog.length > 100) mv.decisionLog = mv.decisionLog.slice(-100);
  movementRecord('decision', `${type}:${approved?'approved':'denied'}`);
}

function movementIsActive() {
  // Returns true if Al iKon has been seen in the last 30 min
  return CONFIG.movement.lastSeen && (Date.now() - CONFIG.movement.lastSeen) < CONFIG.movement.awayThreshMs;
}

function movementIsLikelyAwake() {
  // Returns true if current hour matches Al iKon's peak activity hours
  const hour = new Date().getHours();
  return CONFIG.movement.patterns.peakHours?.includes(hour) ?? (hour >= 8 && hour <= 23);
}

function movementLoadHistory() {
  try {
    const mv = CONFIG.movement;
    if (!fs.existsSync(mv.file)) return;
    const saved = JSON.parse(fs.readFileSync(mv.file, 'utf8'));
    if (saved.hourlyActive) mv.hourlyActive = saved.hourlyActive;
    if (saved.dailyActive)  mv.dailyActive  = saved.dailyActive;
    if (saved.sessions)     mv.sessions     = saved.sessions;
    if (saved.patterns)     mv.patterns     = saved.patterns;
    if (saved.lastSeen)     mv.lastSeen     = saved.lastSeen;
    log(`MOVEMENT: loaded ${mv.sessions.length} sessions from history`);
    movementLearnPatterns();
  } catch(e) { log(`MOVEMENT: could not load history — ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── UNIVERSAL AI CALL v3.21 — provider fallback chain ───────────────────────
// askAI(prompt, systemPrompt, maxTokens) tries providers in order:
//   1. Ollama (local, free, fastest — phi3:mini)
//   2. Groq   (free cloud, 14k req/day — llama-3.1-8b-instant)
//   3. OpenRouter (free models — meta-llama/llama-3.1-8b-instruct:free)
//   4. Gemini (free tier — gemini-1.5-flash via REST)
// Falls back silently — Commander never dies because one provider is down.
// ═══════════════════════════════════════════════════════════════════════════════
async function askAI(userPrompt, systemPrompt = '', maxTokens = 500) {
  const sys = systemPrompt || `You are advising AIKON-OS Commander for Al iKon (Al iKon Unlimited LLC). Be concise, actionable, 3-6 sentences.`;
  const errors = [];

  // ── 1a. Phi-3 Mini (local, fast — always first) ───────────────────────────
  try {
    const result = await askOllama(userPrompt, [], CONFIG.ollamaModel);
    const text = result.reply || result;
    if (text && !text.includes('timeout') && !text.includes('unavailable')) {
      return { text, provider: 'ollama/phi3' };
    }
  } catch(e) { errors.push(`ollama/phi3: ${e.message}`); }

  // ── 1b. DeepSeek R1 (local, heavy — only for deep reasoning tasks) ────────
  // Used when: analyze, plan, strategy, evaluate, research, forecast, decide
  // RAM cap: DeepSeek loads only on demand; unloaded after inference (keep_alive:0)
  const heavyKeywords = ['analyze','why','how should','plan','strategy','compare',
    'evaluate','opportunity','should i','what if','research','forecast','decide','recommend'];
  const isHeavy = heavyKeywords.some(k => userPrompt.toLowerCase().includes(k)) || userPrompt.length > 300;
  if (isHeavy && CONFIG.deepseekReady) {
    try {
      const result = await askOllama(userPrompt, [], CONFIG.deepseekModel);
      const text = result.reply || result;
      if (text && !text.includes('timeout') && !text.includes('unavailable')) {
        return { text, provider: 'ollama/deepseek' };
      }
    } catch(e) { errors.push(`ollama/deepseek: ${e.message}`); }
  }

  // ── 2. Groq (free, fastest cloud) ─────────────────────────────────────────
  const groqKey = process.env.GROQ_API_KEY || '';
  if (groqKey) {
    try {
      const res = await httpPost('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
      }, { 'Authorization': `Bearer ${groqKey}` });
      const text = res?.choices?.[0]?.message?.content;
      if (text) return { text, provider: 'groq' };
    } catch(e) { errors.push(`groq: ${e.message}`); }
  }

  // ── 3. OpenRouter (free models) ───────────────────────────────────────────
  const orKey = process.env.OPENROUTER_API_KEY || '';
  if (orKey) {
    try {
      const res = await httpPost('https://openrouter.ai/api/v1/chat/completions', {
        model: 'meta-llama/llama-3.1-8b-instruct:free',
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
      }, { 'Authorization': `Bearer ${orKey}`, 'HTTP-Referer': 'https://github.com/alikonunlimited', 'X-Title': 'AIKON-OS Commander' });
      const text = res?.choices?.[0]?.message?.content;
      if (text) return { text, provider: 'openrouter' };
    } catch(e) { errors.push(`openrouter: ${e.message}`); }
  }

  // ── 4. Gemini (Google AI Studio free tier) ────────────────────────────────
  const gemKey = process.env.GEMINI_API_KEY || '';
  if (gemKey) {
    try {
      const res = await httpPost(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${gemKey}`,
        { contents: [{ parts: [{ text: `${sys}\n\n${userPrompt}` }] }], generationConfig: { maxOutputTokens: maxTokens } },
        {}
      );
      const text = res?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text, provider: 'gemini' };
    } catch(e) { errors.push(`gemini: ${e.message}`); }
  }

  // All providers failed
  log(`ASK-AI ALL_FAIL: ${errors.join(' | ')}`);
  return { text: `[All AI providers unavailable: ${errors.join(', ')}]`, provider: 'none' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PHONE LISTENER v3.21 ────────────────────────────────────────────────────
// Permanent background poll of ntfy — receives commands from Al iKon's phone.
// Commander polls /json?poll=1 every 8s, executes any slash command received.
// Approval flow: Commander pushes "ACTION NEEDED" → Al iKon replies /approve ID
// or any natural language → Commander routes to askAI and pushes answer back.
// Uses NTFY_CMD_TOPIC (default: NTFY_TOPIC + "-cmd") to separate inbound from outbound.
// ═══════════════════════════════════════════════════════════════════════════════
function startPhoneListener(rl) {
  const topic = process.env.NTFY_CMD_TOPIC || (CONFIG.ntfyTopic ? CONFIG.ntfyTopic + '-cmd' : '');
  if (!topic) {
    log('PHONE-LISTENER: no NTFY_TOPIC set — skipping. Set NTFY_TOPIC in .env to enable.');
    return;
  }

  let lastTs = Math.floor(Date.now() / 1000);
  log(`PHONE-LISTENER: active on ntfy topic "${topic}" — polling every 8s`);
  print(`📱 Phone listener active — send commands to ntfy topic: ${topic}`);

  async function poll() {
    try {
      const raw = await new Promise((resolve, reject) => {
        const req = https.get(
          `https://ntfy.sh/${topic}/json?poll=1&since=${lastTs}`,
          { headers: { 'User-Agent': 'AIKON-Commander/3.21' }, timeout: 6000 },
          r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('poll timeout')); });
      });

      const lines = raw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.event !== 'message' || !msg.message) continue;
          if ((msg.time || 0) <= lastTs) continue;
          lastTs = msg.time;

          const text = msg.message.trim();
          log(`PHONE: received "${text.substring(0, 80)}"`);
          print(`\n📱 Phone → "${text}"`);
          movementRecord('phone_cmd', text.substring(0, 80));

          if (text.startsWith('/')) {
            // Slash command — execute directly
            await handleCommand(text, rl).catch(e => log(`PHONE CMD ERR: ${e.message}`));
          } else {
            // Natural language — route to askAI, push answer back to phone
            const { text: answer, provider } = await askAI(text);
            print(`\n🤖 [${provider}]: ${answer}\n`);
            remember('user', `[phone] ${text}`);
            remember('assistant', answer);
            chromaAdd('aikon_os', { insight: `[phone] Q:${text.substring(0,80)} A:${answer.substring(0,200)}`, source: 'phone_cmd' });
            // Push answer back to phone on the main outbound topic
            if (CONFIG.ntfyTopic) {
              await notify(`Commander [${provider}]`, answer.substring(0, 400), 'default');
            }
          }
        } catch(e) { /* malformed line — skip */ }
      }
    } catch(e) {
      // Silent — don't spam logs on intermittent network errors
      if (!e.message.includes('timeout') && !e.message.includes('ENOTFOUND')) {
        log(`PHONE-POLL ERR: ${e.message}`);
      }
    }

    // Schedule next poll
    setTimeout(poll, 8000);
  }

  // Start after 20s (let system settle)
  setTimeout(poll, 20000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── KNOWLEDGE SEEDING v3.19 ─────────────────────────────────────────────────
// Seeds 40 deep knowledge entries into ChromaDB on startup.
// These are permanent facts Commander retrieves via RAG to answer questions
// and make better autonomous decisions. Skip entries already seeded.
// ═══════════════════════════════════════════════════════════════════════════════
function seedKnowledgeBase() {
  const seeds = [
    // ── 20 FROM CLAUDE (business-specific deep reasoning) ──────────────────
    // XAU/USD Trader
    { branch: 'trader', source: 'claude_seed', insight: 'XAU/USD entry filter: only enter scalp when RSI is between 40-60 (not overbought/oversold), spread is under 0.30 pips, and time is within 30min of London open (08:00 UTC) or NY open (13:00 UTC). Confidence floor: 60% minimum. This eliminates the RSI-95 overbought scalps that have been causing losses.' },
    { branch: 'trader', source: 'claude_seed', insight: 'HTF conflict detection rule: if H1/H4 disagree with D1 on trend direction, set htfConflicted=true and block ALL modes except scalp with confidence>70%. Log conflict to daily report. Alert Al iKon if conflict persists >4 hours — may indicate major news event approaching.' },
    { branch: 'trader', source: 'claude_seed', insight: 'FundedNext Step 2 daily loss buffer: auto-pause trader when daily P&L hits -$120 (not -$150 limit). This leaves $30 buffer against spread costs on open trades. Resume next trading day at 00:00 UTC. Log pause event with reason to Google Sheets.' },
    { branch: 'trader', source: 'claude_seed', insight: 'Win rate math: at 25% win rate, the system needs reward:risk > 3:1 to be profitable (25%×3 - 75%×1 = 0). Current scalp R:R is likely 1:1. Either raise win rate to 40%+ or raise R:R to 2:1+ minimum. Both changes together are ideal.' },
    { branch: 'trader', source: 'claude_seed', insight: 'Trader health check protocol: Commander should ping /api/state every 5 minutes during London and NY sessions (08:00-17:00 UTC). If no response in 60s, alert via ntfy.sh. If win rate drops below 20% in a session, auto-pause and alert Al iKon.' },
    // Silent Santa
    { branch: 'roblox', source: 'claude_seed', insight: 'Silent Santa daily metrics to pull from Roblox Analytics: (1) Visit count vs yesterday, (2) Avg session length, (3) Gamepass revenue (Golden Sleigh + Nice List Plus), (4) DAU trend, (5) Top referral source. Alert Al iKon if visits drop >20% day-over-day during Christmas season.' },
    { branch: 'roblox', source: 'claude_seed', insight: 'Silent Santa retention mechanic priority: Daily Gift login bonus is fastest to implement (2 Luau lines) and highest D1 retention impact. Give players a gift box each day they log in — escalating rewards (coins, cosmetics, speed boost). Christmas countdown timer on-screen also drives urgency and return visits.' },
    { branch: 'roblox', source: 'claude_seed', insight: 'Silent Santa ad audience split: Run 3 ad sets simultaneously — All Players (control), Age 9-12 (Christmas sweet spot), and Age 13-17 (may prefer the competitive leaderboard angle). Compare CTR and visit conversion after 48 hours. Pause the lowest performer, double budget on winner.' },
    { branch: 'roblox', source: 'claude_seed', insight: 'Silent Santa monetization expansion: Add a "Reindeer Upgrade" developer product (10R$ one-time per upgrade, stackable 5 times) for speed boosts. Developer products convert better than gamepasses for price-sensitive players. Implement with MarketplaceService:PromptProductPurchase().' },
    { branch: 'roblox', source: 'claude_seed', insight: 'Roblox holiday traffic window: Christmas games peak Dec 20-Jan 1. Silent Santa should have leaderboard + at least 1 new cosmetic live by Dec 18 to capture early holiday players. After Jan 2, traffic drops 60-80%. Plan next seasonal game (Valentine\'s, Easter) now.' },
    // StreamNet / Social
    { branch: 'social', source: 'claude_seed', insight: 'OnAir Network IG Reel formula: Hook (0-3s): bold text overlay + audio. Content (3-20s): clip highlight or screen recording. CTA (last 3s): "Follow for more streams". Caption: 1 sentence + 3-5 niche hashtags (#twitchclips #livestreaming #streamhighlights). Post Tue-Thu 12-3pm EST for max reach.' },
    { branch: 'social', source: 'claude_seed', insight: 'alikon_marketing IG token path: In Meta Developer App 1174505231754866, go to Graph API Explorer → select alikon_marketing Facebook Page from me/accounts → copy that Page\'s access_token → save as IG_ALIKON_TOKEN in .env. Required permissions: instagram_basic, instagram_content_publish, pages_read_engagement.' },
    { branch: 'social', source: 'claude_seed', insight: 'Daily auto-post workflow for onairnetwork_inc: (1) Commander pulls top Twitch clip via Twitch API /helix/clips, (2) downloads MP4 to Oracle /temp/ dir, (3) posts public URL to IG /reels endpoint with auto-generated caption, (4) logs result to Chroma. Full loop should run at 2pm EST daily.' },
    // Restaurant Agency
    { branch: 'opportunities', source: 'claude_seed', insight: 'Restaurant prospect signals Commander should monitor daily via Google Maps API and DuckDuckGo: (1) New restaurant listing in Columbus with no website URL, (2) Restaurant with <3.5 stars and >50 reviews, (3) Restaurant with outdated hours posted, (4) Local food blog mentioning a restaurant with no social link. Alert Al iKon with business name + phone.' },
    { branch: 'opportunities', source: 'claude_seed', insight: 'Restaurant agency pricing that works: Tier 1 = Website build $499 one-time + $99/mo hosting/updates. Tier 2 = $99/mo + $149/mo social (3 IG posts/week). Tier 3 = Full service $349/mo. Lead with Tier 1 — lowest barrier. Upsell to Tier 2 after 60 days. Commander tracks client list and billing in Google Sheets.' },
    // Systems
    { branch: 'aikon_os', source: 'claude_seed', insight: 'Thomas RAM allocation rule: Ollama max 3GB (set via OLLAMA_MAX_LOADED_MODELS=1 and keep_alive=0 on every call). Commander Node.js process target <500MB. Leave 4GB+ for Windows OS and other processes. If RAM >90%, Commander should auto-kill Ollama (taskkill /F /IM ollama.exe) and use Claude API fallback.' },
    { branch: 'aikon_os', source: 'claude_seed', insight: 'ntfy.sh push notification events Commander should send: (1) Trader daily loss >$100 — URGENT, (2) Roblox visit count drops >20% — WARNING, (3) IG post failure — INFO, (4) Brain relay down >5min — WARNING, (5) Daily autonomous report ready — INFO, (6) FundedNext account paused — URGENT. Topic: set NTFY_TOPIC in .env.' },
    { branch: 'aikon_os', source: 'claude_seed', insight: 'Autonomous loop health check per tick: ping trader /api/state (200ms timeout), ping Brain /relay/status (200ms timeout), check Ollama process running (tasklist grep), verify .env file exists, check commander.log for ERROR lines in last 15min. Log all results. Alert on any failure.' },
    { branch: 'aikon_os', source: 'claude_seed', insight: 'Decision approval categories — always queue for Al iKon sign-off, never auto-execute: (1) Any spend >$0 (ad budget, API upgrade), (2) Pushing code to production repos, (3) Sending messages/emails as Al iKon, (4) Contacting any external business or person. Auto-execute OK: internal reports, memory writes, local file changes, read-only API calls.' },
    { branch: 'aikon_os', source: 'claude_seed', insight: 'ChromaDB tagging schema for high-quality RAG retrieval: every chromaAdd entry should include: branch (trader/roblox/social/opportunities/aikon_os), source (feed/self_ask/claude_seed/decision_log/daily_report), confidence (high/medium/low), outcome if applicable (profit/loss/viral/ignored). This lets Commander filter by confidence and outcome in future queries.' },
    // ── 20 FROM EXTERNAL/PUBLIC KNOWLEDGE ──────────────────────────────────
    // Trading mechanics
    { branch: 'trader', source: 'external_knowledge', insight: 'RSI divergence on XAU/USD 15min chart: Bullish divergence = price makes lower low, RSI makes higher low — signals potential reversal up. Bearish divergence = price makes higher high, RSI makes lower high — signals potential reversal down. Only trade divergence with HTF trend confirmation. Never trade divergence against D1 trend.' },
    { branch: 'trader', source: 'external_knowledge', insight: 'XAU/USD London session windows (UTC): Pre-open 06:00-07:00 (quiet, set bias), Open 07:00-09:00 (high volatility, best breakout entries), Mid-session 09:00-11:00 (trend continuation), Close 11:00-12:00 (reversals common). NY Open 13:30-15:00 (second major volatility window). Avoid trading 12:00-13:00 UTC (dead zone).' },
    { branch: 'trader', source: 'external_knowledge', insight: 'XAU/USD news avoidance rule: Check forexfactory.com or investing.com economic calendar before each session. Events that cause >20 pip moves: NFP (first Friday, 13:30 UTC), CPI (monthly, 13:30 UTC), FOMC (8x/year, 19:00 UTC), Fed Chair speeches. Rule: no new entries 15min before or 15min after red-impact events.' },
    { branch: 'trader', source: 'external_knowledge', insight: 'Prop firm drawdown math (FundedNext Step 2, $5K account): Max loss floor $4,600 = max $400 total drawdown. Daily loss limit 3% = $150/day. If open trade risks $150, that uses full daily allowance. Best practice: max risk per trade = 0.5% of account = $25/trade. Allows 6 losing trades before daily limit hit.' },
    { branch: 'trader', source: 'external_knowledge', insight: 'Scalp vs intraday distinction: Scalp = entry to exit <15 minutes, target 5-10 pips, SL 5-8 pips, requires tight spread (<0.30 pips on XAU/USD). Intraday = entry to exit within session, target 20-50 pips, SL 15-25 pips, requires HTF trend confirmation. Swing = multi-day hold, target 100+ pips, requires D1/W1 alignment.' },
    // Roblox development
    { branch: 'roblox', source: 'external_knowledge', insight: 'Roblox DataStore save/load pattern: local DataStoreService = game:GetService("DataStoreService"); local store = DataStoreService:GetDataStore("PlayerData"); store:SetAsync(player.UserId, {coins=100, level=1}) to save. store:GetAsync(player.UserId) to load. Always wrap in pcall() to handle errors. Auto-save on PlayerRemoving event.' },
    { branch: 'roblox', source: 'external_knowledge', insight: 'Roblox PlayerAdded initialization pattern: game.Players.PlayerAdded:Connect(function(player) — load data from DataStore — create leaderstats folder — add IntValue objects (Coins, Level, Deliveries) — set values from loaded data or defaults. Always use pcall around DataStore calls. Set up PlayerRemoving save at same time.' },
    { branch: 'roblox', source: 'external_knowledge', insight: 'Roblox monetization rates: Gamepass revenue = Robux price × 0.70 (Roblox takes 30%). 1,000 Robux = ~$3.50 USD via DevEx (must be Premium member with 30-day hold). Golden Sleigh at 75R$ = ~$0.26 per purchase after cut. Need ~385 purchases for $100 USD. Focus on volume (many small purchases) not premium pricing.' },
    { branch: 'roblox', source: 'external_knowledge', insight: 'Roblox Creator Hub daily metrics dashboard: Navigate to create.roblox.com → Creations → [game] → Analytics. Key tabs: Summary (visits, playtime, revenue), Engagement (session length, D1/D7 retention), Acquisition (top referral sources). D7 retention >20% is good for a kids game. Avg session >8 minutes indicates strong engagement.' },
    { branch: 'roblox', source: 'external_knowledge', insight: 'Roblox TweenService animation: local TweenService = game:GetService("TweenService"); local goal = {Position = Vector3.new(x,y,z)}; local tweenInfo = TweenInfo.new(2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out); local tween = TweenService:Create(part, tweenInfo, goal); tween:Play(). Use for smooth sleigh movement, elf walking, gift box animations.' },
    // Instagram / Meta API
    { branch: 'social', source: 'external_knowledge', insight: 'Meta Graph API token types: User Access Token = tied to a person, short-lived (1-2 hours), used for /me endpoint. Page Access Token = tied to a Facebook Page, long-lived (60 days or never-expiring if generated correctly), required for IG Business Account posting. Get Page token via GET /me/accounts?fields=access_token with User token.' },
    { branch: 'social', source: 'external_knowledge', insight: 'Instagram Reel upload via Graph API: Step 1: POST /{ig-user-id}/media with video_url, caption, media_type=REELS, share_to_feed=true → returns creation_id. Step 2: Wait 10-30s for processing. Step 3: POST /{ig-user-id}/media_publish with creation_id → returns media_id. Check status via GET /{creation_id}?fields=status_code (must be FINISHED before publish).' },
    { branch: 'social', source: 'external_knowledge', insight: 'Instagram Graph API posting limits: 25 API-published posts per 24-hour rolling window per Instagram account. Reels count toward this limit. Stories have separate limits. Rate limit error code: (#4) Application request limit reached. Best practice: space posts at least 1 hour apart; Commander should track last_post_ts per account in .env or Chroma.' },
    { branch: 'social', source: 'external_knowledge', insight: 'Instagram Reel caption best practices for gaming/streaming niche: Keep under 125 chars (more shown without "more" truncation). Format: [Hook emoji] [1 punchy line] [line break] [3-5 hashtags]. Best hashtags for streaming: #twitchstreamer #streamhighlights #gamingclips #livestream #contentcreator. Post between 11am-1pm or 7pm-9pm EST for maximum initial reach.' },
    { branch: 'social', source: 'external_knowledge', insight: 'Meta Webhooks for Instagram: Subscribe to instagram topic via POST /app/subscriptions with fields=comments,messages,messaging_postbacks,feed. Requires a public HTTPS callback URL that returns 200 on GET verification challenge. Brain\'s Railway URL can serve as webhook endpoint. This eliminates polling — Instagram pushes events to Commander in real-time.' },
    // Node.js / system
    { branch: 'aikon_os', source: 'external_knowledge', insight: 'Node.js child_process: use spawn() for long-running processes (Ollama, voice recorder) — returns stream, does not buffer output. Use execSync() for one-shot commands that need stdout (git pull, tasklist). use exec() for async one-shot. spawn() with stdio:inherit passes Commander terminal directly to child process — good for Ollama startup.' },
    { branch: 'aikon_os', source: 'external_knowledge', insight: 'ntfy.sh push notification via Node.js: const https=require("https"); https.request({hostname:"ntfy.sh",path:"/YOUR_TOPIC",method:"POST",headers:{"Title":"Commander Alert","Priority":"high","Content-Type":"text/plain"}},()=>{}).end("Your message here"). Free, no account needed. Set unique topic in NTFY_TOPIC env var to avoid others seeing notifications.' },
    { branch: 'aikon_os', source: 'external_knowledge', insight: 'SQLite WAL mode enables concurrent reads while writing: run PRAGMA journal_mode=WAL; once after opening DB. For Commander memory, better-sqlite3 is fastest synchronous SQLite for Node.js. Schema: CREATE TABLE memory(id INTEGER PRIMARY KEY, branch TEXT, source TEXT, content TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, confidence TEXT). Index on branch+ts for fast RAG queries.' },
    { branch: 'aikon_os', source: 'external_knowledge', insight: 'Windows Task Scheduler schtasks commands: Check task: schtasks /query /tn "AIKON-OS Commander" /fo LIST. Start now: schtasks /run /tn "AIKON-OS Commander". Stop: schtasks /end /tn "AIKON-OS Commander". Delete: schtasks /delete /tn "AIKON-OS Commander" /f. Import XML: schtasks /create /xml "path.xml" /tn "AIKON-OS Commander" /f. All require no quotes around /tn on some Windows versions — test both.' },
    { branch: 'aikon_os', source: 'external_knowledge', insight: 'Exponential backoff retry pattern for Brain relay in Node.js: let attempt=0; async function connect(){try{await tryConnect();}catch(e){const delay=Math.min(1000*Math.pow(2,attempt),60000); attempt++; log("Retry in "+delay+"ms"); setTimeout(connect,delay);}} Reset attempt=0 on success. This prevents hammering Brain when it is redeploying, capping at 60s between retries.' },
  ];

  let seeded = 0;
  for (const seed of seeds) {
    // Check if this exact insight is already in memory (avoid duplicates on restart)
    const existing = chromaQuery(seed.branch, seed.insight.substring(0, 50), 1);
    const alreadySeeded = existing.some(e => e.content && e.content.startsWith(seed.insight.substring(0, 40)));
    if (!alreadySeeded) {
      chromaAdd(seed.branch, { insight: seed.insight, source: seed.source });
      seeded++;
    }
  }
  if (seeded > 0) {
    log(`KNOWLEDGE-SEED: ${seeded} new knowledge entries added to ChromaDB (${seeds.length - seeded} already present)`);
    print(`📚 Knowledge base updated: ${seeded} new skills/systems seeded into memory`);
  } else {
    log('KNOWLEDGE-SEED: all 40 entries already present — skipping');
  }
}

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
  startBrainRelay();
  startClaudePoller();
  startLearner();
  startCpuMonitor(); // auto-optimize when CPU>70% or RAM>85%

  // ── PROTOCOL ENGINES ──────────────────────────────────────────────────────
  // S-07: File integrity baseline on startup
  setTimeout(() => { secIntegrityCheck(); secAudit('STARTUP', `Commander v${CONFIG.version} online`); }, 3000);
  // S-04: Key rotation check every hour
  setInterval(secKeyRotationCheck, 3600000);
  // I-01: Deep intel scan every 15 min (also called by autonomy loop)
  setInterval(intelDeepScan, CONFIG.intel.scanInterval);
  // I-03: Feed ingestion every 30 min
  setInterval(intelFeedIngestion, 1800000);
  // C-08: Heartbeat every 60s
  setInterval(commsHeartbeat, CONFIG.comms.heartbeatMs);
  // C-09: Flush message queue every 2 min
  setInterval(commsFlushQueue, 120000);
  // I-07: KPI snapshot every 5 min
  setInterval(intelUpdateKPI, 300000);
  log('PROTOCOLS: Security/Intel/Comms engines started');

  // ── AUTONOMY ENGINE v3.14 ─────────────────────────────────────────────────
  // Master loop — self-directs all autonomous tasks every 15 min
  setInterval(autonomousLoop, CONFIG.autonomy.loopIntervalMs);
  // Self-ask — Commander asks AI peers questions every hour
  setInterval(autonomousSelfAsk, CONFIG.autonomy.selfAskIntervalMs);
  // Threat chaining — patch setThreatLevel to auto-trigger response
  const _baseThreatLevel = setThreatLevel;
  global._threatChainHooked = true;
  // Run first loop after 60s (let system settle)
  setTimeout(() => autonomousLoop(), 60000);
  // Run first self-ask after 90s
  setTimeout(() => autonomousSelfAsk(), 90000);
  log('AUTONOMY: v3.14 engine started — self-directed AI learning active');

  // ── MOVEMENT LEARNING v3.23 ──────────────────────────────────────────────
  // Loads Al iKon's historical activity from D: drive, synthesizes patterns,
  // and starts observing phone commands / approvals to learn behavior over time.
  movementLoadHistory();
  // Synthesize patterns daily at 4am (quiet hour — no active session noise)
  setInterval(() => {
    const h = new Date().getHours();
    if (h === 4) movementLearnPatterns();
  }, 3600000); // check hourly

  // ── KNOWLEDGE SEEDING v3.19 ───────────────────────────────────────────────
  // 40 deep knowledge seeds injected into ChromaDB on startup.
  // Commander retrieves these via RAG on every relevant prompt.
  // 20 from Claude reasoning + 20 from public/external knowledge.
  setTimeout(() => seedKnowledgeBase(), 5000);

  // ── HEALTH MONITOR v3.20 ──────────────────────────────────────────────────
  // Checks trader P&L, win rate, Brain relay, and Groq key every 5 min.
  // Sends ntfy push alerts on critical events automatically.
  setInterval(() => autonomousHealthCheck().catch(e => log(`HEALTH ERR: ${e.message}`)), 300000);
  setTimeout(() => autonomousHealthCheck().catch(e => log(`HEALTH ERR: ${e.message}`)), 15000);
  log('HEALTH MONITOR v3.20: active — 5-min checks, ntfy alerts enabled');

  // ── PHONE LISTENER v3.21 ──────────────────────────────────────────────────
  // Always-on background poll of ntfy topic — Al iKon sends commands from
  // phone, Commander executes them. Approvals, /claude, any slash command.
  // Uses a separate ntfy SUB topic so push alerts don't loop back as commands.
  startPhoneListener(rl);

  // ── ANTI-HACKING ENGINE v3.15 ─────────────────────────────────────────────
  // S-17: Watchdog heartbeat every 30s
  secWatchdogPing();
  setInterval(secWatchdogPing, 30000);
  // S-17: External watchdog check every 5 min (detects if WE restarted abnormally)
  setTimeout(() => setInterval(secWatchdogCheck, 300000), 120000);
  // S-12: Prune expired nonces every 10 min
  setInterval(secPruneNonces, 600000);
  // S-15: Prune expired session tokens every 30 min
  setInterval(secPruneTokens, 1800000);
  // S-19: Encrypted backup every hour
  setInterval(secEncryptedBackup, CONFIG.security.backupIntervalMs);
  setTimeout(() => secEncryptedBackup(), 30000); // first backup 30s after start
  log('SECURITY v3.15: S-11–S-20 anti-hacking engine active');

  // Health + HUD WebSocket server + Phone relay
  const healthPort = process.env.COMMANDER_PORT || 3000;
  const healthServer = http.createServer((req, res) => {
    // S-14: IP allowlist check
    const clientIP = req.socket.remoteAddress || '0.0.0.0';
    if (!secCheckIP(clientIP)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'IP not allowed' }));
      return;
    }
    // S-13: Rate limit check
    if (!secRateLimit(clientIP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }
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
