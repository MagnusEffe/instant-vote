const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT           = process.env.PORT           || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'instantvote';
const JSONBIN_ID     = process.env.JSONBIN_ID     || '';
const JSONBIN_KEY    = process.env.JSONBIN_KEY     || '';
const LOCAL_FILE     = path.join(__dirname, 'data.json');

// ── SAMPLE QUESTIONS ──────────────────────────────────────────────────────────
const SAMPLE_QUESTIONS = [
  { title: "Concernant les équations de Bernoulli…",       options: ["Il y a un tuyau qui fuit ?","Haaa, les fluides incompressibles…","C'est une marque de pâtes","Je préfère Navier-Stokes."] },
  { title: "Prolégomènes à une phénoménologie descriptive", options: ["C'est pas de Husserl ?","Hein ???","Ok, next !"] },
  { title: "La covalence de la liaison carbone-oxygène",    options: ["Pour","Contre","Ni pour ni contre, bien au contraire"] },
  { title: "Destination de l'anneau unique",                options: ["Montagne du Destin","Minas Tirith","Fond de l'océan","Tom Bombadil"] },
  { title: "Une bataille pour Batman ?",                    options: ["Bat-battle","Bat-baston","Bat-battez-vous"] }
];

function makeSampleQuestions() {
  const now = new Date().toISOString();
  return SAMPLE_QUESTIONS.map((q, i) => ({ id: (Date.now()+i).toString(), title: q.title, options: q.options, createdAt: now, endedAt: null, startedAt: null, hasResults: false }));
}

function slugify(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40) || 'salle';
}

function newRoom(name) {
  const slug = slugify(name) + '-' + Date.now().toString(36);
  return { id: slug, slug, name, questions: makeSampleQuestions(), activeVote: null, pinnedResult: null, multiVote: false, votes: {}, createdAt: new Date().toISOString() };
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let state = { rooms: {} };
const voterIPs = {};

// ── JSONBIN PERSISTENCE ───────────────────────────────────────────────────────
function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const binPath = method === 'GET' ? `/v3/b/${JSONBIN_ID}/latest?meta=false` : `/v3/b/${JSONBIN_ID}`;
    const options = {
      hostname: 'api.jsonbin.io', path: binPath, method,
      headers: { 'X-Master-Key': JSONBIN_KEY, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`JSONBin ${method} status: ${res.statusCode}`);
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`JSONBin HTTP ${res.statusCode}: ${data}`)); return; }
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadState() {
  if (!JSONBIN_ID || !JSONBIN_KEY) {
    try { if (fs.existsSync(LOCAL_FILE)) state = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); } catch(e) {}
    if (!state.rooms) state.rooms = {};
    console.log(`Local: ${Object.keys(state.rooms).length} salle(s) chargée(s)`);
    return;
  }
  try {
    const res = await jsonbinRequest('GET');
    console.log('JSONBin raw:', JSON.stringify(res).slice(0, 200));
    if (res && res.rooms)                    state = res;
    else if (res && res.record && res.record.rooms) state = res.record;
    if (!state.rooms) state.rooms = {};
    console.log(`JSONBin: ${Object.keys(state.rooms).length} salle(s) chargée(s)`);
  } catch(e) {
    console.error('JSONBin load error:', e.message);
    if (!state.rooms) state.rooms = {};
  }
}

let saveTimer = null;
function saveState() {
  if (!JSONBIN_ID || !JSONBIN_KEY) {
    try { fs.writeFileSync(LOCAL_FILE, JSON.stringify(state, null, 2)); } catch(e) {}
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await jsonbinRequest('PUT', state); }
    catch(e) { console.error('JSONBin save error:', e.message); }
  }, 300);
}

// ── SSE CLIENTS ───────────────────────────────────────────────────────────────
const clients = { admin: {}, display: {}, vote: {} };
function getClients(type, slug) { if (!clients[type][slug]) clients[type][slug] = new Set(); return clients[type][slug]; }
function broadcast(type, slug, eventName, data) { const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of getClients(type, slug)) { try { res.write(msg); } catch(_) {} } }
function broadcastAll(slug, eventName, data) { broadcast('admin',slug,eventName,data); broadcast('display',slug,eventName,data); broadcast('vote',slug,eventName,data); }

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getRoom(slug) { return state.rooms[slug]; }

function getVoteSummary(slug, questionId) {
  const room = getRoom(slug); if (!room) return null;
  const q = room.questions.find(q => q.id === questionId); if (!q) return null;
  const vc = room.votes[questionId] || {};
  const total = Object.values(vc).reduce((a,b) => a+b, 0);
  return { questionId, title: q.title, options: q.options.map((text,i) => ({ text, count: vc[i]||0, pct: total > 0 ? Math.round(((vc[i]||0)/total)*100) : 0 })), total, endedAt: q.endedAt||null, startedAt: q.startedAt||null };
}

function getFullState(slug) {
  const room = getRoom(slug); if (!room) return null;
  return { name: room.name, slug: room.slug, questions: room.questions, activeVote: room.activeVote, activeSummary: room.activeVote ? getVoteSummary(slug, room.activeVote.questionId) : null, pinnedResult: room.pinnedResult||null, multiVote: room.multiVote||false };
}

function getDisplayState(slug) {
  const room = getRoom(slug); if (!room) return { mode:'idle', multiVote:false };
  const base = { multiVote: room.multiVote||false, roomName: room.name };
  if (room.activeVote) return { ...base, mode:'vote', summary: getVoteSummary(slug, room.activeVote.questionId) };
  if (room.pinnedResult) { const s = getVoteSummary(slug, room.pinnedResult); if (s) return { ...base, mode:'result', summary:s }; }
  return { ...base, mode:'idle' };
}

function parseBody(req) {
  return new Promise((resolve,reject) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{resolve(JSON.parse(b||'{}'));}catch(e){reject(e);} }); });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
  res.end(JSON.stringify(data));
}

function sseEndpoint(req, res, slug, type) {
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN });
  const set = getClients(type, slug); set.add(res);
  const initData = type === 'admin' ? getFullState(slug) : getDisplayState(slug);
  res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) { clearInterval(ping); } }, 20000);
  req.on('close', () => { set.delete(res); clearInterval(ping); });
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const method   = req.method;

  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── AUTH ──
  if (pathname === '/api/auth' && method === 'POST') {
    const body = await parseBody(req);
    return sendJSON(res, body.password === ADMIN_PASSWORD ? 200 : 401, { ok: body.password === ADMIN_PASSWORD });
  }

  // ── SSE ──
  const sseMatch = pathname.match(/^\/events\/(admin|display|vote)\/(.+)$/);
  if (sseMatch) {
    const [, type, slug] = sseMatch;
    if (!getRoom(slug)) return sendJSON(res, 404, { error: 'Room not found' });
    return sseEndpoint(req, res, slug, type);
  }

  // ── ROOMS LIST ──
  if (pathname === '/api/rooms' && method === 'GET') {
    return sendJSON(res, 200, Object.values(state.rooms).map(r => ({ slug:r.slug, name:r.name, createdAt:r.createdAt, questionCount:r.questions.length })));
  }
  if (pathname === '/api/rooms' && method === 'POST') {
    const body = await parseBody(req);
    const name = (body.name||'').trim();
    if (!name) return sendJSON(res, 400, { error:'Name required' });
    const room = newRoom(name);
    state.rooms[room.slug] = room; saveState();
    return sendJSON(res, 201, { slug:room.slug, name:room.name });
  }

  // ── ROOM ROUTES ──
  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(\/.*)?$/);
  if (roomMatch) {
    const slug = roomMatch[1], sub = roomMatch[2]||'';
    const room = getRoom(slug);
    if (!room) return sendJSON(res, 404, { error:'Room not found' });

    if (sub===''&&method==='PUT')    { const body=await parseBody(req); if(body.name){room.name=body.name.trim();saveState();broadcastAll(slug,'roomRenamed',{name:room.name});} return sendJSON(res,200,{slug,name:room.name}); }
    if (sub===''&&method==='DELETE') { delete state.rooms[slug]; saveState(); return sendJSON(res,200,{ok:true}); }
    if (sub==='/state'&&method==='GET')   return sendJSON(res,200,getFullState(slug));
    if (sub==='/display'&&method==='GET') return sendJSON(res,200,getDisplayState(slug));
    if (sub==='/results'&&method==='GET') { const r={}; for(const q of room.questions){if(q.hasResults)r[q.id]=getVoteSummary(slug,q.id);} return sendJSON(res,200,r); }

    // Questions
    if (sub==='/questions'&&method==='GET')  return sendJSON(res,200,room.questions);
    if (sub==='/questions'&&method==='POST') {
      const body=await parseBody(req);
      const q={id:Date.now().toString(),title:(body.title||'').trim(),options:(body.options||[]).map(o=>o.trim()).filter(Boolean),createdAt:new Date().toISOString(),endedAt:null,startedAt:null,hasResults:false};
      room.questions.push(q); saveState(); broadcastAll(slug,'questions',room.questions);
      return sendJSON(res,201,q);
    }
    const qMatch = sub.match(/^\/questions\/([^/]+)$/);
    if (qMatch) {
      const qid=qMatch[1];
      if (method==='PUT')    { const body=await parseBody(req); const i=room.questions.findIndex(q=>q.id===qid); if(i===-1)return sendJSON(res,404,{error:'Not found'}); room.questions[i]={...room.questions[i],...body,id:qid}; saveState(); broadcastAll(slug,'questions',room.questions); return sendJSON(res,200,room.questions[i]); }
      if (method==='DELETE') { room.questions=room.questions.filter(q=>q.id!==qid); if(room.activeVote?.questionId===qid)room.activeVote=null; saveState(); broadcastAll(slug,'questions',room.questions); return sendJSON(res,200,{ok:true}); }
    }
    if (sub==='/reorder'&&method==='POST') {
      const body=await parseBody(req);
      if(Array.isArray(body.order)){room.questions.sort((a,b)=>body.order.indexOf(a.id)-body.order.indexOf(b.id));saveState();broadcastAll(slug,'questions',room.questions);}
      return sendJSON(res,200,{ok:true});
    }

    // Vote
    if (sub==='/vote/start'&&method==='POST') {
      const body=await parseBody(req);
      const q=room.questions.find(q=>q.id===body.questionId); if(!q)return sendJSON(res,404,{error:'Not found'});
      room.activeVote={questionId:q.id,startedAt:new Date().toISOString()};
      q.startedAt=room.activeVote.startedAt; q.endedAt=null; q.hasResults=false;
      room.votes[q.id]={}; if(!voterIPs[slug])voterIPs[slug]={}; voterIPs[slug][q.id]=new Set();
      if(room.pinnedResult===q.id)room.pinnedResult=null;
      saveState(); broadcastAll(slug,'voteStart',{question:q,summary:getVoteSummary(slug,q.id)});
      return sendJSON(res,200,{ok:true});
    }
    if (sub==='/vote/end'&&method==='POST') {
      if(!room.activeVote)return sendJSON(res,400,{error:'No active vote'});
      const qid=room.activeVote.questionId; const q=room.questions.find(q=>q.id===qid);
      const summary=getVoteSummary(slug,qid);
      const hasVotes = summary && summary.total > 0;
      if(q){ q.endedAt=new Date().toISOString(); q.hasResults=hasVotes; }
      room.activeVote=null;
      // N'épingler sur l'affichage que si des votes ont été exprimés
      room.pinnedResult = hasVotes ? qid : null;
      saveState();
      broadcastAll(slug,'voteEnd',{summary});
      broadcast('admin',slug,'pinned',{pinnedResult:room.pinnedResult});
      broadcast('display',slug,'init',getDisplayState(slug));
      broadcast('vote',slug,'init',getDisplayState(slug));
      return sendJSON(res,200,summary);
    }
    if (sub==='/vote/cast'&&method==='POST') {
      const body=await parseBody(req);
      if(!room.activeVote)return sendJSON(res,400,{error:'No active vote'});
      const qid=room.activeVote.questionId;
      if(!room.multiVote){
        const ip=req.headers['x-forwarded-for']?.split(',')[0].trim()||req.socket.remoteAddress;
        if(!voterIPs[slug])voterIPs[slug]={}; if(!voterIPs[slug][qid])voterIPs[slug][qid]=new Set();
        if(voterIPs[slug][qid].has(ip))return sendJSON(res,429,{error:'already_voted'});
        voterIPs[slug][qid].add(ip);
      }
      if(!room.votes[qid])room.votes[qid]={};
      room.votes[qid][body.optionIndex]=(room.votes[qid][body.optionIndex]||0)+1;
      saveState(); broadcastAll(slug,'voteUpdate',getVoteSummary(slug,qid));
      return sendJSON(res,200,{ok:true});
    }

    // Display pin
    if (sub==='/display/pin'&&method==='POST') {
      const body=await parseBody(req);
      room.pinnedResult=room.pinnedResult===body.questionId?null:(body.questionId||null);
      saveState();
      broadcast('display',slug,'init',getDisplayState(slug));
      broadcast('vote',slug,'init',getDisplayState(slug));
      broadcast('admin',slug,'pinned',{pinnedResult:room.pinnedResult});
      return sendJSON(res,200,{pinnedResult:room.pinnedResult});
    }

    // MultiVote
    if (sub==='/multivote'&&method==='POST') {
      const body=await parseBody(req);
      room.multiVote=!!body.enabled; saveState();
      broadcastAll(slug,'settings',{multiVote:room.multiVote});
      return sendJSON(res,200,{multiVote:room.multiVote});
    }
  }

  res.writeHead(404,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:'Not found'}));
});

// ── STARTUP ───────────────────────────────────────────────────────────────────
loadState().then(() => {
  if (Object.keys(state.rooms).length === 0) {
    const demo = newRoom('Salle de démonstration');
    state.rooms[demo.slug] = demo;
    saveState();
    console.log(`Salle par défaut créée : ${demo.slug}`);
  }
  server.listen(PORT, () => console.log(`Instant Vote running on http://localhost:${PORT}`));
}).catch(e => {
  console.error('Startup error:', e);
  server.listen(PORT, () => console.log(`Instant Vote running (sans persistance) on http://localhost:${PORT}`));
});
