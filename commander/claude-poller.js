// ─────────────────────────────────────────────────────────────
// AIKON-OS Claude Poller v1.2
// Polls Brain every 60s for /claude questions from Commander.
// Answers via Ollama (free, local) first.
// Falls back to Claude API if Ollama times out or fails.
// Run: node claude-poller.js
// Reads: D:\AIKON-OS\.env
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Load .env ────────────────────────────────────────────────
const ENV_PATH = 'D:\\AIKON-OS\\.env';
try {
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) {
  console.error(`[POLLER] Could not read .env at ${ENV_PATH}: ${e.message}`);
  process.exit(1);
}

// Strip any trailing page path like /jarvis — relay endpoints live at root
const BRAIN_URL    = (process.env.BRAIN_URL || '').replace(/\/$/, '').replace(/\/jarvis$/, '');
const BRIDGE_KEY   = process.env.BRIDGE_KEY  || '';
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';
const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const OLLAMA_TIMEOUT_MS = 25_000; // fall back to Claude API after 25s
const POLL_MS      = 60_000;

if (!BRAIN_URL)  { console.error('[POLLER] BRAIN_URL not set in .env'); process.exit(1); }
if (!BRIDGE_KEY) { console.error('[POLLER] BRIDGE_KEY not set in .env'); process.exit(1); }

console.log(`[POLLER] Started — polling ${BRAIN_URL}/relay/claude-ask every ${POLL_MS/1000}s`);
console.log(`[POLLER] Primary:  Ollama ${OLLAMA_MODEL} at ${OLLAMA_URL} (timeout ${OLLAMA_TIMEOUT_MS/1000}s)`);
console.log(`[POLLER] Fallback: Claude API ${CLAUDE_KEY ? '✓ key set' : '✗ CLAUDE_API_KEY not set — no fallback'}`);

// ── HTTP helpers ─────────────────────────────────────────────
function request(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req    = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Poll Brain for questions ──────────────────────────────────
async function pollBrain() {
  const res = await request(`${BRAIN_URL}/relay/claude-ask`, {
    method: 'GET',
    headers: { 'x-bridge-key': BRIDGE_KEY },
  });
  if (res.status === 401) throw new Error('Brain returned 401 — check BRIDGE_KEY');
  if (!res.body || !res.body.questions) return [];
  return res.body.questions;
}

const SYSTEM_PROMPT = `You are the AIKON-OS AI assistant answering questions from Commander terminal.
Al iKon runs: XAU/USD algo trader (Render, engine.js), Commander terminal (Windows Thomas Node.js), Brain relay (Railway brain.js).
Stack: Node.js 18, Windows D: drive, Railway (brain), Render free tier (trader/engine).
Trader: scalp-only XAU/USD, 26.8% win rate, intraday/day/swing modes not yet unblocked.
Keep answers tight — 2-4 sentences max. This prints in a terminal window.`;

// ── Ask Ollama (local, free, primary) ────────────────────────
function askOllama(question) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model:  OLLAMA_MODEL,
      prompt: `${SYSTEM_PROMPT}\n\nQuestion: ${question}\nAnswer:`,
      stream: false,
    });

    const timer = setTimeout(() => reject(new Error('Ollama timeout')), OLLAMA_TIMEOUT_MS);

    const parsed = new URL(`${OLLAMA_URL}/api/generate`);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parsed.port || 11434,
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const body = JSON.parse(data);
          resolve(body.response?.trim() || '(no response)');
        } catch { reject(new Error('Ollama bad JSON')); }
      });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.write(payload);
    req.end();
  });
}

// ── Ask Claude API (fallback) ─────────────────────────────────
async function askClaudeAPI(question) {
  if (!CLAUDE_KEY) throw new Error('CLAUDE_API_KEY not set — no fallback available');
  const payload = {
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: question }],
  };
  const res = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
  }, payload);
  if (res.status !== 200) throw new Error(`Claude API ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.content?.[0]?.text || '(no response)';
}

// ── Answer: try Ollama, fall back to Claude API ───────────────
async function askClaude(question) {
  try {
    const answer = await askOllama(question);
    console.log(`[POLLER] ← Ollama answered`);
    return answer;
  } catch (err) {
    console.log(`[POLLER] Ollama failed (${err.message}) — falling back to Claude API`);
    const answer = await askClaudeAPI(question);
    console.log(`[POLLER] ← Claude API answered`);
    return answer;
  }
}

// ── Post answer back to Brain ─────────────────────────────────
async function postResponse(id, response) {
  await request(`${BRAIN_URL}/relay/claude-response`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'x-bridge-key':  BRIDGE_KEY,
    },
  }, { id, response });
}

// ── Main poll loop ────────────────────────────────────────────
async function tick() {
  try {
    const questions = await pollBrain();
    if (questions.length === 0) {
      process.stdout.write('.');  // quiet heartbeat dot
      return;
    }
    console.log(`\n[POLLER] ${questions.length} question(s) queued`);
    for (const q of questions) {
      console.log(`[POLLER] Q [${q.id}]: ${q.question.substring(0, 80)}`);
      const answer = await askClaude(q.question);
      await postResponse(q.id, answer);
      console.log(`[POLLER] ✓ Answered [${q.id}]: ${answer.substring(0, 80)}`);
    }
  } catch (err) {
    console.error(`\n[POLLER] Error: ${err.message}`);
  }
}

tick();
setInterval(tick, POLL_MS);
