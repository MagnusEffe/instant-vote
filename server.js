const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// --- State ---
let state = {
  questions: [],
  activeVote: null, // { questionId, startedAt }
  votes: {}         // { questionId: { optionIndex: count } }
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

loadState();

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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // --- SSE Endpoints ---
  if (pathname === '/events/admin') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
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
      'Access-Control-Allow-Origin': '*'
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
    if (!state.votes[questionId]) state.votes[questionId] = {};
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
    saveState();
    const summary = getVoteSummary(questionId);
    broadcastAll('voteEnd', { summary });
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

  // --- Static files ---
  let filePath;
  if (pathname === '/' || pathname === '/admin') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else if (pathname === '/vote') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else if (pathname === '/display') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else {
    filePath = path.join(__dirname, 'public', pathname);
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  serveFile(res, filePath, mime);
});

function getFullState() {
  return {
    questions: state.questions,
    activeVote: state.activeVote,
    activeSummary: state.activeVote ? getVoteSummary(state.activeVote.questionId) : null
  };
}

function getDisplayState() {
  if (state.activeVote) {
    return { mode: 'vote', summary: getVoteSummary(state.activeVote.questionId) };
  }
  // Find most recent result
  const withResults = state.questions.filter(q => q.hasResults);
  if (withResults.length > 0) {
    const last = withResults[withResults.length - 1];
    return { mode: 'result', summary: getVoteSummary(last.id) };
  }
  return { mode: 'idle' };
}

server.listen(PORT, () => {
  console.log(`Instant Vote running on http://localhost:${PORT}`);
  console.log(`Admin:   http://localhost:${PORT}/admin`);
  console.log(`Display: http://localhost:${PORT}/display`);
  console.log(`Vote:    http://localhost:${PORT}/vote`);
});
