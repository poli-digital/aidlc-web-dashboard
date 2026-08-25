#!/usr/bin/env node
'use strict';

const express = require('express');
const http = require('http');
const net = require('net');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');

const BASE_PORT = parseInt(process.env.PORT || '3939', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Estado global
let projectPath = process.argv[2] || null; // pode receber via CLI
let watcher = null;
let debounceTimer = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function readText(p) {
  try { return await fs.readFile(p, 'utf8'); }
  catch { return null; }
}

async function readJson(p) {
  const text = await readText(p);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function aidlcRoot() {
  if (!projectPath) return null;
  return path.join(projectPath, 'aidlc');
}

// ─── Load Dashboard Data ────────────────────────────────────────────────────

async function loadDashboard() {
  const root = aidlcRoot();
  if (!root) return { intents: [], error: 'Nenhum projeto selecionado' };

  const data = { intents: [], activeSpace: 'default', cloneId: '', projectMemory: null };

  const activeSpace = await readText(path.join(root, 'active-space'));
  if (activeSpace) data.activeSpace = activeSpace.trim();

  const cloneId = await readText(path.join(root, '.aidlc-clone-id'));
  if (cloneId) data.cloneId = cloneId.trim();

  const spaceDir = path.join(root, 'spaces', data.activeSpace);
  const intentsJson = await readJson(path.join(spaceDir, 'intents', 'intents.json'));
  if (!intentsJson) {
    data.errorKey = 'notAidlc';
    return data;
  }

  for (const intent of intentsJson) {
    const intentDir = path.join(spaceDir, 'intents', intent.dirName);
    const intentData = { ...intent, state: null, graph: null, recovery: null, audit: [] };

    intentData.state = await readText(path.join(intentDir, 'aidlc-state.md'));
    intentData.graph = await readJson(path.join(intentDir, 'runtime-graph.json'));
    intentData.recovery = await readText(path.join(intentDir, '.aidlc-recovery.md'));

    try {
      const auditDir = path.join(intentDir, 'audit');
      const files = await fs.readdir(auditDir);
      for (const f of files) {
        if (f.endsWith('.md')) {
          const content = await readText(path.join(auditDir, f));
          if (content) intentData.audit.push({ name: f, content });
        }
      }
    } catch { /* sem audit */ }

    data.intents.push(intentData);
  }

  data.projectMemory = await readText(path.join(spaceDir, 'memory', 'project.md'));
  return data;
}

// ─── Load Tokens (Claude + Kiro) ───────────────────────────────────────────

async function loadTokens() {
  const agg = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0,
    sessions: [], byModel: {}, kiroSessions: [], events: [], kiroEvents: [], kiroCredits: 0,
  };
  await loadClaudeTokens(agg);
  await loadKiroSessions(agg);
  agg.sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  agg.kiroSessions.sort((a, b) => (b.lastModifiedAt || 0) - (a.lastModifiedAt || 0));
  return agg;
}

async function loadClaudeTokens(agg) {
  if (!projectPath) return;
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const candidates = [
    projectPath.replace(/\//g, '-'),
    projectPath.replace(/[^a-zA-Z0-9-]/g, '-'),
  ];

  let dir = null;
  for (const c of candidates) {
    const candidate = path.join(projectsDir, c);
    try {
      await fs.access(candidate);
      dir = candidate;
      break;
    } catch { }
  }
  if (!dir) return;

  let files = [];
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  for (const f of files) {
    const text = await readText(path.join(dir, f));
    if (!text) continue;
    parseClaudeJsonl(text, f.replace('.jsonl', ''), agg);
  }
}

function parseClaudeJsonl(text, name, agg) {
  const sess = { name, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, firstTs: null, lastTs: null };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const usage = d.message?.usage;
    if (!usage) continue;
    const model = d.message?.model || 'unknown';
    sess.messages++; agg.messages++;
    sess.input += usage.input_tokens || 0; agg.input += usage.input_tokens || 0;
    sess.output += usage.output_tokens || 0; agg.output += usage.output_tokens || 0;
    sess.cacheRead += usage.cache_read_input_tokens || 0; agg.cacheRead += usage.cache_read_input_tokens || 0;
    sess.cacheWrite += usage.cache_creation_input_tokens || 0; agg.cacheWrite += usage.cache_creation_input_tokens || 0;
    if (!agg.byModel[model]) agg.byModel[model] = { input: 0, output: 0, messages: 0 };
    agg.byModel[model].input += usage.input_tokens || 0;
    agg.byModel[model].output += usage.output_tokens || 0;
    agg.byModel[model].messages++;
    agg.events.push({
      ts: d.timestamp || null, model,
      i: usage.input_tokens || 0, o: usage.output_tokens || 0,
      cr: usage.cache_read_input_tokens || 0, cw: usage.cache_creation_input_tokens || 0,
    });
    if (d.timestamp) {
      if (!sess.firstTs || d.timestamp < sess.firstTs) sess.firstTs = d.timestamp;
      if (!sess.lastTs || d.timestamp > sess.lastTs) sess.lastTs = d.timestamp;
    }
  }
  if (sess.messages > 0) agg.sessions.push(sess);
}

async function loadKiroSessions(agg) {
  const sessionsDir = path.join(os.homedir(), '.kiro', 'sessions');
  const all = [];
  const matched = [];

  let hashes = [];
  try { hashes = await fs.readdir(sessionsDir); } catch { return; }

  for (const h of hashes) {
    const hashDir = path.join(sessionsDir, h);
    let sessDirs = [];
    try {
      sessDirs = (await fs.readdir(hashDir)).filter(d => d.startsWith('sess_'));
    } catch { continue; }

    for (const sd of sessDirs) {
      const dir = path.join(hashDir, sd);
      const sj = await readJson(path.join(dir, 'session.json'));
      const text = await readText(path.join(dir, 'messages.jsonl'));
      if (!text) continue;

      const kiroSess = {
        title: sj?.title || sd, modelId: sj?.modelId || '',
        lastModifiedAt: sj?.lastModifiedAt || null, lines: 0, contextPct: 0,
        credits: 0, turns: 0, _events: [],
      };

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        kiroSess.lines++;
        const m = line.match(/"usagePercentage":\s*([\d.]+)/);
        if (m) kiroSess.contextPct = Math.max(kiroSess.contextPct, parseFloat(m[1]));
        if (line.includes('"promptTurnSummaries"')) {
          try {
            const d = JSON.parse(line);
            const arr = d.payload?.promptTurnSummaries || [];
            const credits = arr.reduce((a, x) => a + (x.usage || 0), 0);
            if (credits > 0) {
              kiroSess.credits += credits;
              kiroSess.turns++;
              kiroSess._events.push({ ts: d.timestamp || null, credits });
            }
          } catch { }
        }
      }
      all.push(kiroSess);
      const paths = sj?.workspacePaths || [];
      if (projectPath && paths.some(p => p === projectPath || projectPath.startsWith(p) || p.startsWith(projectPath))) {
        matched.push(kiroSess);
      }
    }
  }

  const selected = matched.length ? matched : all;
  for (const s of selected) {
    agg.kiroCredits += s.credits;
    agg.kiroEvents.push(...s._events);
    delete s._events;
  }
  agg.kiroSessions.push(...selected);
}

// ─── File Watcher ───────────────────────────────────────────────────────────

function startWatcher() {
  stopWatcher();
  const root = aidlcRoot();
  if (!root || !fsSync.existsSync(root)) return;

  watcher = fsSync.watch(root, { recursive: true }, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => broadcast('refresh'), 600);
  });
}

function stopWatcher() {
  if (watcher) { watcher.close(); watcher = null; }
}

// ─── WebSocket ──────────────────────────────────────────────────────────────

function broadcast(type) {
  const msg = JSON.stringify({ type });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setProject') {
      projectPath = msg.path;
      startWatcher();
      const dashboard = await loadDashboard();
      const tokens = await loadTokens();
      ws.send(JSON.stringify({ type: 'data', dashboard }));
      ws.send(JSON.stringify({ type: 'tokens', tokens }));
    } else if (msg.type === 'ready' || msg.type === 'refresh') {
      const dashboard = await loadDashboard();
      ws.send(JSON.stringify({ type: 'data', dashboard }));
      if (msg.type === 'ready') {
        const tokens = await loadTokens();
        ws.send(JSON.stringify({ type: 'tokens', tokens }));
      }
    } else if (msg.type === 'refreshTokens') {
      const tokens = await loadTokens();
      ws.send(JSON.stringify({ type: 'tokens', tokens }));
    } else if (msg.type === 'getProject') {
      ws.send(JSON.stringify({ type: 'project', path: projectPath }));
    }
  });

  // Envia estado atual ao conectar
  ws.send(JSON.stringify({ type: 'project', path: projectPath }));
});

// ─── REST API (fallback para configurar via curl/browser) ───────────────────

app.post('/api/project', async (req, res) => {
  const { path: p } = req.body;
  if (!p) return res.status(400).json({ error: 'path is required' });
  projectPath = p;
  startWatcher();
  broadcast('refresh');
  res.json({ ok: true, path: projectPath });
});

app.get('/api/project', (req, res) => {
  res.json({ path: projectPath });
});

app.get('/api/dashboard', async (req, res) => {
  res.json(await loadDashboard());
});

app.get('/api/tokens', async (req, res) => {
  res.json(await loadTokens());
});

// ─── Port Discovery ─────────────────────────────────────────────────────────

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port);
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 100; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Nenhuma porta livre encontrada entre ${start} e ${start + 99}`);
}

// ─── Interactive Prompt ─────────────────────────────────────────────────────

function askProjectPath() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\n  📂 Cole o caminho completo do projeto: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  // Resolve o caminho do projeto
  let inputPath = process.argv[2] || null;

  if (!inputPath) {
    inputPath = await askProjectPath();
  }

  if (!inputPath) {
    console.error('  ❌ Nenhum caminho fornecido. Encerrando.');
    process.exit(1);
  }

  // Normaliza e valida
  projectPath = path.resolve(inputPath);
  if (!fsSync.existsSync(projectPath)) {
    console.error(`  ❌ Caminho não encontrado: ${projectPath}`);
    process.exit(1);
  }

  // Encontra porta livre (permite múltiplas instâncias)
  const port = await findFreePort(BASE_PORT);

  server.listen(port, () => {
    console.log(`\n  🔬 AIDLC Dashboard Web`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  Projeto: ${projectPath}`);
    console.log(`  Abra no navegador: http://localhost:${port}`);
    console.log(`  ─────────────────────────────────\n`);
    startWatcher();
  });
}

main().catch((err) => {
  console.error('  ❌ Erro ao iniciar:', err.message);
  process.exit(1);
});
