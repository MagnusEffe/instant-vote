const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// --- State ---
let state = {
  questions: [],
  activeVote: null,   // { questionId, startedAt }
  pinnedResult: null, // questionId manually pinned for display
  votes: {}           // { questionId: { optionIndex: count } }
};

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load error:', e.message); }
}

function saveState() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

const SAMPLE_QUESTIONS = [
  {
    title: "Comment évaluez-vous cette présentation ?",
    options: ["Excellente", "Bonne", "Moyenne", "À améliorer"]
  },
  {
    title: "Quel format de réunion préférez-vous ?",
    options: ["En présentiel", "En visioconférence", "Format hybride", "Peu importe"]
  },
  {
    title: "Quelle est votre priorité pour le prochain trimestre ?",
    options: ["Croissance commerciale", "Amélioration des processus", "Formation des équipes", "Innovation produit"]
  },
  {
    title: "Êtes-vous favorable à ce projet ?",
    options: ["Tout à fait favorable", "Plutôt favorable", "Plutôt défavorable", "Tout à fait défavorable"]
  },
  {
    title: "Quand souhaitez-vous tenir la prochaine réunion ?",
    options: ["Cette semaine", "La semaine prochaine", "Dans 15 jours", "Dans un mois"]
  }
];

function initSampleQuestions() {
  const now = new Date().toISOString();
  state.questions = SAMPLE_QUESTIONS.map((q, i) => ({
    id: (Date.now() + i).toString(),
    title: q.title,
    options: q.options,
    createdAt: now,
    endedAt: null,
    startedAt: null,
    hasResults: false
  }));
  saveState();
}

loadState();
if (state.questions.length === 0) initSampleQuestions();

// --- SSE clients ---
const clients = { admin: new Set(), display: new Set() };

function broadcast(channel, eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients[channel]) {
    try { res.write(msg); } catch (_) {}
  }
}

function broadcastAll(eventName, data) {
  broadcast('admin', eventName, data);
  broadcast('display', eventName, data);
}

// --- Helpers ---
function getVoteSummary(questionId) {
  const q = state.questions.find(q => q.id === questionId);
  if (!q) return null;
  const voteCounts = state.votes[questionId] || {};
  const total = Object.values(voteCounts).reduce((a, b) => a + b, 0);
  return {
    questionId,
    title: q.title,
    options: q.options.map((opt, i) => ({
      text: opt,
      count: voteCounts[i] || 0,
      pct: total > 0 ? Math.round(((voteCounts[i] || 0) / total) * 100) : 0
    })),
    total,
    endedAt: q.endedAt || null,
    startedAt: q.startedAt || null
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (_) {
    res.writeHead(404); res.end('Not found');
  }
}

// --- MIME types ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // --- SSE Endpoints ---
  if (pathname === '/events/admin') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN
    });
    clients.admin.add(res);
    res.write(`event: init\ndata: ${JSON.stringify(getFullState())}\n\n`);
    const pingAdmin = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(pingAdmin); }
    }, 20000);
    req.on('close', () => { clients.admin.delete(res); clearInterval(pingAdmin); });
    return;
  }

  if (pathname === '/events/display') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN
    });
    clients.display.add(res);
    res.write(`event: init\ndata: ${JSON.stringify(getDisplayState())}\n\n`);
    const pingDisplay = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(pingDisplay); }
    }, 20000);
    req.on('close', () => { clients.display.delete(res); clearInterval(pingDisplay); });
    return;
  }

  // --- API Routes ---
  if (pathname === '/api/questions' && method === 'GET') {
    return sendJSON(res, 200, state.questions);
  }

  if (pathname === '/api/questions' && method === 'POST') {
    const body = await parseBody(req);
    const q = {
      id: Date.now().toString(),
      title: (body.title || '').trim(),
      options: (body.options || []).map(o => o.trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
      endedAt: null,
      startedAt: null
    };
    state.questions.push(q);
    saveState();
    broadcastAll('questions', state.questions);
    return sendJSON(res, 201, q);
  }

  if (pathname.startsWith('/api/questions/') && method === 'PUT') {
    const id = pathname.split('/')[3];
    const body = await parseBody(req);
    const idx = state.questions.findIndex(q => q.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
    state.questions[idx] = { ...state.questions[idx], ...body, id };
    saveState();
    broadcastAll('questions', state.questions);
    return sendJSON(res, 200, state.questions[idx]);
  }

  if (pathname.startsWith('/api/questions/') && method === 'DELETE') {
    const id = pathname.split('/')[3];
    state.questions = state.questions.filter(q => q.id !== id);
    if (state.activeVote && state.activeVote.questionId === id) state.activeVote = null;
    saveState();
    broadcastAll('questions', state.questions);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/questions/') && pathname.endsWith('/reorder') && method === 'POST') {
    const body = await parseBody(req);
    const { order } = body; // array of ids
    if (Array.isArray(order)) {
      state.questions.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveState();
      broadcastAll('questions', state.questions);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/reorder' && method === 'POST') {
    const body = await parseBody(req);
    const { order } = body;
    if (Array.isArray(order)) {
      state.questions.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveState();
      broadcastAll('questions', state.questions);
    }
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/vote/start' && method === 'POST') {
    const body = await parseBody(req);
    const { questionId } = body;
    const q = state.questions.find(q => q.id === questionId);
    if (!q) return sendJSON(res, 404, { error: 'Not found' });
    state.activeVote = { questionId, startedAt: new Date().toISOString() };
    q.startedAt = state.activeVote.startedAt;
    q.endedAt = null;
    q.hasResults = false;
    // Effacer les votes précédents
    state.votes[questionId] = {};
    // Dépingler si cette question était affichée
    if (state.pinnedResult === questionId) state.pinnedResult = null;
    saveState();
    broadcastAll('voteStart', { question: q, summary: getVoteSummary(questionId) });
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/vote/end' && method === 'POST') {
    if (!state.activeVote) return sendJSON(res, 400, { error: 'No active vote' });
    const { questionId } = state.activeVote;
    const q = state.questions.find(q => q.id === questionId);
    if (q) {
      q.endedAt = new Date().toISOString();
      q.hasResults = true;
    }
    state.activeVote = null;
    // Épingler automatiquement la question sur l'affichage
    state.pinnedResult = questionId;
    saveState();
    const summary = getVoteSummary(questionId);
    broadcastAll('voteEnd', { summary });
    broadcast('admin', 'pinned', { pinnedResult: state.pinnedResult });
    broadcast('display', 'init', getDisplayState());
    return sendJSON(res, 200, summary);
  }

  if (pathname === '/api/vote/cast' && method === 'POST') {
    const body = await parseBody(req);
    const { optionIndex } = body;
    if (!state.activeVote) return sendJSON(res, 400, { error: 'No active vote' });
    const { questionId } = state.activeVote;
    if (!state.votes[questionId]) state.votes[questionId] = {};
    state.votes[questionId][optionIndex] = (state.votes[questionId][optionIndex] || 0) + 1;
    saveState();
    const summary = getVoteSummary(questionId);
    broadcastAll('voteUpdate', summary);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, getFullState());
  }

  if (pathname === '/api/display' && method === 'GET') {
    return sendJSON(res, 200, getDisplayState());
  }

  if (pathname === '/api/results' && method === 'GET') {
    const results = {};
    for (const q of state.questions) {
      if (q.hasResults) results[q.id] = getVoteSummary(q.id);
    }
    return sendJSON(res, 200, results);
  }

  if (pathname === '/api/display/pin' && method === 'POST') {
    const body = await parseBody(req);
    const { questionId } = body;
    // Toggle : if same question already pinned, unpin
    if (state.pinnedResult === questionId) {
      state.pinnedResult = null;
    } else {
      state.pinnedResult = questionId || null;
    }
    saveState();
    broadcast('display', 'init', getDisplayState());
    broadcast('admin', 'pinned', { pinnedResult: state.pinnedResult });
    return sendJSON(res, 200, { pinnedResult: state.pinnedResult });
  }

  // Route inconnue
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function getFullState() {
  return {
    questions: state.questions,
    activeVote: state.activeVote,
    activeSummary: state.activeVote ? getVoteSummary(state.activeVote.questionId) : null,
    pinnedResult: state.pinnedResult || null
  };
}

function getDisplayState() {
  if (state.activeVote) {
    return { mode: 'vote', summary: getVoteSummary(state.activeVote.questionId) };
  }
  // Pinned result takes priority
  if (state.pinnedResult) {
    const s = getVoteSummary(state.pinnedResult);
    if (s) return { mode: 'result', summary: s };
  }
  return { mode: 'idle' };
}

server.listen(PORT, () => {
  console.log(`Instant Vote running on http://localhost:${PORT}`);
  console.log(`Admin:   http://localhost:${PORT}/admin`);
  console.log(`Display: http://localhost:${PORT}/display`);
  console.log(`Vote:    http://localhost:${PORT}/vote`);
});
