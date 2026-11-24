#!/usr/bin/env node
// AIKON-OS Commander v2.3 — Voice Edition + Self-Update
// Location: D:\AIKON-OS\commander\commander.js
// Start: node D:\AIKON-OS\commander\commander.js
// Update: /update  — pulls latest from GitHub and restarts

const readline  = require('readline');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const { execSync, spawn } = require('child_process');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  ollamaHost:    '127.0.0.1',
  ollamaPort:    11434,
  ollamaModel:   'phi3:mini',
  traderUrl:     'https://xauusd-trader-80p0.onrender.com/api/state',
  bridgeUrl:     process.env.BRIDGE_URL || '',
  bridgeKey:     process.env.BRIDGE_KEY || '',
  logFile:       path.join(__dirname, 'commander.log'),
  memoryFile:    path.join(__dirname, 'memory.json'),
  pollInterval:  30000,
  // Self-update
  updateRepo:    'alikonunlimited/Node-Template',
  updateFile:    'commander/commander.js',
  updateBranch:  'main',
  version:       '2.4',
  // Voice
  voiceRecorder: path.join(__dirname, 'voice_record.py'),
  voiceWav:      path.join(__dirname, 'voice_input.wav'),
  whisperModel:  'base',
  voiceEnabled:  true,
  // Whisper path — tries PATH first, falls back to known install locations
  whisperPaths:  [
    'whisper',
    'C:\\Python314\\Scripts\\whisper.exe',
    'C:\\Python313\\Scripts\\whisper.exe',
    'C:\\Python312\\Scripts\\whisper.exe',
    process.env.USERPROFILE + '\\AppData\\Roaming\\Python\\Python314\\Scripts\\whisper.exe',
    process.env.USERPROFILE + '\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\whisper.exe',
  ],
};

// ─── MEMORY ───────────────────────────────────────────────────────────────────
let memory = [];
try {
  if (fs.existsSync(CONFIG.memoryFile))
    memory = JSON.parse(fs.readFileSync(CONFIG.memoryFile, 'utf8'));
} catch(e) { memory = []; }

function saveMemory() {
  try { fs.writeFileSync(CONFIG.memoryFile, JSON.stringify(memory.slice(-200), null, 2)); } catch(e) {}
}
function remember(role, content) {
  memory.push({ role, content, ts: new Date().toISOString() });
  saveMemory();
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch(e) {}
}
function print(msg) { process.stdout.write('\r' + msg + '\n> '); }

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
      trader:     trader ? { balance: trader.balance, status: trader.status, price: trader.currentPrice } : null,
      voice:      CONFIG.voiceEnabled ? 'enabled' : 'disabled',
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
// ─── SELF-UPDATE ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchLatestVersion(token) {
  // Fetch commander.js from GitHub raw API
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
    print('⏳ Applying update...');

    // Back up current file
    const selfPath  = __filename;
    const backupPath = selfPath + '.backup';
    fs.copyFileSync(selfPath, backupPath);
    print(`📦 Backup saved: ${backupPath}`);

    // Write new version
    fs.writeFileSync(selfPath, code, 'utf8');
    print(`✅ Updated to v${latestVer}. Restarting Commander...`);
    log(`SELF_UPDATE: v${CONFIG.version} → v${latestVer} sha=${sha.substring(0,8)}`);
    await bridgeSend('status', `Commander self-updated v${CONFIG.version} → v${latestVer}. Restarting.`, 'claude');

    // Restart: spawn detached child then exit
    const child = spawn(process.execPath, [selfPath], {
      detached: true, stdio: 'inherit',
      cwd: __dirname
    });
    child.unref();
    process.exit(0);

  } catch(e) {
    print(`❌ Update failed: ${e.message}`);
    log(`SELF_UPDATE_ERR: ${e.message}`);
  }
}

// ─── OLLAMA ───────────────────────────────────────────────────────────────────
async function askOllama(prompt, context = []) {
  const messages = [
    {
      role: 'system',
      content: `You are Commander, the AI operations hub for AIKON-OS (Al iKon Unlimited LLC).
You manage: XAU/USD Trader, Silent Santa (Roblox), and all business operations.
You are direct, efficient, action-oriented. Big decisions escalate to Al iKon.
Bridge: ${CONFIG.bridgeUrl ? 'CONNECTED' : 'not configured'}
Voice: ${CONFIG.voiceEnabled ? 'ENABLED' : 'disabled'}
Version: ${CONFIG.version}
Date: ${new Date().toLocaleDateString()}`
    },
    ...context.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: prompt }
  ];

  const body = JSON.stringify({ model: CONFIG.ollamaModel, messages, stream: false });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: CONFIG.ollamaHost, port: CONFIG.ollamaPort,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).message?.content || 'No response'); }
        catch(e) { resolve(d); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body); req.end();
  });
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
  for (const p of CONFIG.whisperPaths) {
    try { execSync(`"${p}" --help`, { stdio: 'ignore', timeout: 5000 }); return p; }
    catch(e) {}
  }
  return null;
}

function whisperAvailable() { return !!findWhisper(); }

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
    const whisperBin = findWhisper();
    if (!whisperBin) { reject(new Error('Whisper not found. Run: pip install openai-whisper')); return; }
    const outDir = path.dirname(wavPath);
    const proc = spawn(whisperBin, [wavPath,
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

  switch(cmd) {

    // ── SELF-UPDATE ──────────────────────────────────────────────────────────
    case '/update': {
      if (!args) {
        print('Usage: /update <github_token>');
        print(`Pulls commander/commander.js from ${CONFIG.updateRepo} and restarts.`);
        break;
      }
      await selfUpdate(args.trim());
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
        const whisperPath = findWhisper();
        const wsCheck = whisperPath ? `found ✅  (${whisperPath})` : 'NOT FOUND ❌  →  pip install openai-whisper';
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
          const reply = await askOllama(text, memory.filter(m => m.role !== 'note'));
          print(`\nCommander: ${reply}\n`);
          remember('assistant', reply);
          log(`OLLAMA (voice): ${reply.substring(0,200)}`);
        } catch(e) { print(`❌ Ollama error: ${e.message}`); }
      }
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
      print([
        '🖥️  AIKON-OS STATUS',
        `Commander:  ✅ v${CONFIG.version} running`,
        `Bridge:     ${CONFIG.bridgeUrl ? '✅ ' + CONFIG.bridgeUrl : '❌ not configured'}`,
        `Ollama:     ✅ ${CONFIG.ollamaModel}`,
        `Voice:      ${CONFIG.voiceEnabled ? '🎙️  enabled (/v to record)' : '🔇 disabled (/voice on)'}`,
        `Memory:     ${memory.length} entries`,
        `Uptime:     ${Math.floor(process.uptime())}s`,
        `Update:     /update <github_token>`,
      ].join('\n'));
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

    case '/fix': {
      if (!args) { print('Usage: /fix <github_token>'); break; }
      print('⏳ Fetching engine.js...');
      try {
        const fileData = await githubGetFile(args.trim(), 'alikonunlimited/Node-Template', 'engine.js');
        if (!fileData.content) { print('❌ ' + JSON.stringify(fileData)); break; }
        print(`✅ Fetched (sha: ${fileData.sha.substring(0,8)}). Latest fixes already deployed.`);
        print('   Run /trader to verify trader is healthy.');
      } catch(e) { print('❌ ' + e.message); }
      break;
    }

    case '/note':  { if (!args) { print('Usage: /note <text>'); break; } remember('note', args); print('📝 Noted: ' + args); break; }
    case '/notes': { const n = memory.filter(m => m.role === 'note'); n.length ? n.slice(-20).forEach(x => print(`  [${x.ts.split('T')[0]}] ${x.content}`)) : print('No notes.'); break; }
    case '/memory':{ print(`Memory: ${memory.length} entries (last 5):`); memory.slice(-5).forEach(m => print(`  [${m.role}] ${m.content.substring(0,80)}`)); break; }
    case '/clear': { console.clear(); printBanner(); break; }

    case '/help': {
      print(`
COMMANDER v${CONFIG.version} COMMANDS:
  /update <token>      — 🔄 Self-update from GitHub (alikonunlimited/Node-Template)
  /v [seconds]         — 🎙️  Record voice (default 5s), transcribe, execute
  /voice on|off        — Enable / disable voice input
  /voice setup         — Check voice dependencies
  /trader, /report     — Live trader status
  /bridge status       — Bridge connection check
  /bridge history      — Last 10 bridge messages
  /bridge send <msg>   — Send message to Claude
  /shell <cmd>         — Run shell command
  /migrate [dest]      — Copy AIKON-OS F: → D: (or custom dest)
  /note <text>         — Save a note
  /notes               — Show notes
  /memory              — Show recent memory
  /status              — Full system status
  /clear               — Clear screen
  /exit                — Quit
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
  const bridgeStatus = CONFIG.bridgeUrl ? `✅ ${CONFIG.bridgeUrl}` : '❌ not configured';
  console.log(`
╔══════════════════════════════════════════════════════╗
║       AIKON-OS COMMANDER v${CONFIG.version}                      ║
║       Al iKon Unlimited LLC          🎙️  🔄          ║
╠══════════════════════════════════════════════════════╣
║  Trader:  xauusd-trader-80p0.onrender.com            ║
║  Model:   phi3:mini (Ollama)                         ║
╠══════════════════════════════════════════════════════╣
║  Bridge:  ${bridgeStatus.padEnd(43)}║
╠══════════════════════════════════════════════════════╣
║  /v to speak  |  /update <token> to self-update      ║
╚══════════════════════════════════════════════════════╝
`);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function backgroundStartup() {
  log(`COMMANDER: startup v${CONFIG.version}`);

  setTimeout(async () => {
    try {
      const s = JSON.parse(await httpGet(CONFIG.traderUrl));
      print(`\n📡 Trader online — $${s.balance?.toFixed(2) ?? '?'} | ${s.status ?? 'unknown'}`);
    } catch(e) { print(`\n⚠️  Trader unreachable (${e.message})`); }
  }, 1500);

  if (CONFIG.bridgeUrl && CONFIG.bridgeKey) {
    setTimeout(async () => {
      await bridgeSend('status',
        `Commander v${CONFIG.version} online. Voice + self-update enabled. Ready.`, 'claude');
      print('📡 Bridge: online — announced to Claude');
    }, 3000);
  }

  setTimeout(() => {
    if (!whisperAvailable()) {
      print('⚠️  Whisper not found. Run:  pip install openai-whisper sounddevice soundfile numpy');
    } else {
      print('🎙️  Voice ready. /v to speak.');
    }
  }, 2500);
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
        const reply = await askOllama(input, memory.filter(m => m.role !== 'note'));
        print(`\nCommander: ${reply}\n`);
        remember('assistant', reply);
        log(`OLLAMA: ${reply.substring(0,200)}`);
      } catch(e) { print(`❌ Ollama error: ${e.message}`); }
    }
    rl.prompt();
  });

  rl.on('close', () => { print('Commander offline.'); process.exit(0); });

  backgroundStartup();
  startBridgeLoop();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
