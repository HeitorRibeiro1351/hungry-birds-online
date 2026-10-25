'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET) { console.error('Falta configurar JWT_SECRET.'); process.exit(1); }
if (!DATABASE_URL) { console.error('Falta DATABASE_URL. Crie um banco PostgreSQL e configure essa variável no Render.'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Map();
let waiting = null;
let matchCounter = 0;

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(16) NOT NULL,
    username_norm VARCHAR(16) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar VARCHAR(16) NOT NULL DEFAULT '🐦',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
function publicPlayer(row) { return { username: row.username, avatar: row.avatar }; }
function makeToken(row) { return jwt.sign({ id: row.id, username: row.username }, JWT_SECRET, { expiresIn: '30d' }); }
function authHeader(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!raw) return null;
  try { return jwt.verify(raw, JWT_SECRET); } catch { return null; }
}
function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function dropFromQueue(ws) { if (waiting === ws) waiting = null; }
function endMatch(match, reason = 'finished') {
  if (!match || match.done) return;
  match.done = true;
  clearTimeout(match.timer);
  const [a,b] = match.players;
  let winner = null;
  if (a.corn > b.corn) winner = a;
  else if (b.corn > a.corn) winner = b;
  const result = { type:'match_end', reason, winner: winner ? winner.profile.username : null, draw: !winner, scores: match.players.map(p => ({ ...p.profile, corn:p.corn })) };
  match.players.forEach(p => { send(p.ws, result); p.match = null; p.lastTap = 0; });
}
function startMatch(a,b) {
  const match = { id: ++matchCounter, players: [], done:false, startedAt:Date.now(), duration:60000, timer:null };
  for (const ws of [a,b]) {
    const c = clients.get(ws);
    if (!c) continue;
    c.match = match; c.corn = 0; c.lastTap = 0;
    match.players.push(c);
  }
  if (match.players.length !== 2) { match.players.forEach(p => { p.match = null; }); return; }
  for (const p of match.players) send(p.ws, { type:'match_start', duration:match.duration, players:match.players.map(x => x.profile) });
  match.timer = setTimeout(() => endMatch(match), match.duration);
}

app.get('/health', (_req,res) => res.json({ ok:true, service:'Hungry Birds Online' }));
app.get('/api/me', async (req,res) => {
  const payload = authHeader(req);
  if (!payload) return res.status(401).json({ error:'Entre na sua conta novamente.' });
  try {
    const { rows } = await pool.query('SELECT id, username, avatar FROM players WHERE id=$1', [payload.id]);
    if (!rows[0]) return res.status(401).json({ error:'Conta não encontrada.' });
    res.json({ player: publicPlayer(rows[0]) });
  } catch (e) { console.error(e); res.status(503).json({ error:'Banco de dados indisponível.' }); }
});
app.post('/api/register', async (req,res) => {
  let { username, password, avatar } = req.body || {};
  username = typeof username === 'string' ? username.trim() : '';
  password = typeof password === 'string' ? password : '';
  avatar = typeof avatar === 'string' && ['🐦','🐤','🦅','🦜','🐧','🦉','🦫','🐔'].includes(avatar) ? avatar : '🐦';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error:'O nome precisa ter de 3 a 16 caracteres: letras, números ou _.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error:'A senha deve ter de 8 a 72 caracteres.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query('INSERT INTO players(username, username_norm, password_hash, avatar) VALUES($1,$2,$3,$4) RETURNING id,username,avatar', [username, username.toLowerCase(), hash, avatar]);
    res.status(201).json({ token:makeToken(rows[0]), player:publicPlayer(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error:'Esse nome já está em uso. Escolha outro.' });
    console.error(e); res.status(503).json({ error:'Não foi possível criar a conta. Confira se o banco está configurado.' });
  }
});
app.post('/api/login', async (req,res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  try {
    const { rows } = await pool.query('SELECT id,username,avatar,password_hash FROM players WHERE username_norm=$1', [username.toLowerCase()]);
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error:'Nome ou senha incorretos.' });
    res.json({ token:makeToken(rows[0]), player:publicPlayer(rows[0]) });
  } catch (e) { console.error(e); res.status(503).json({ error:'Banco de dados indisponível.' }); }
});
app.post('/api/avatar', async (req,res) => {
  const payload = authHeader(req);
  if (!payload) return res.status(401).json({ error:'Entre na conta.' });
  const avatar = req.body?.avatar;
  if (!['🐦','🐤','🦅','🦜','🐧','🦉','🦫','🐔'].includes(avatar)) return res.status(400).json({ error:'Foto de perfil inválida.' });
  try { const { rows } = await pool.query('UPDATE players SET avatar=$1 WHERE id=$2 RETURNING username,avatar', [avatar,payload.id]); res.json({ player:publicPlayer(rows[0]) }); }
  catch (e) { console.error(e); res.status(503).json({ error:'Não foi possível atualizar a foto.' }); }
});

server.on('upgrade', (req,socket,head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const url = new URL(req.url, 'http://localhost');
  let payload;
  try { payload = jwt.verify(url.searchParams.get('token') || '', JWT_SECRET); } catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req,socket,head,ws => { ws.playerId = payload.id; wss.emit('connection',ws,payload); });
});
wss.on('connection', async (ws,payload) => {
  try {
    const { rows } = await pool.query('SELECT id,username,avatar FROM players WHERE id=$1', [payload.id]);
    if (!rows[0]) return ws.close(1008,'Conta não encontrada');
    const c = { ws, profile:publicPlayer(rows[0]), match:null, corn:0, lastTap:0 };
    clients.set(ws,c);
    send(ws,{type:'connected',player:c.profile,online:clients.size});
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const me = clients.get(ws); if (!me) return;
      if (msg.type === 'queue_join') {
        if (me.match) return send(ws,{type:'error',message:'Você já está em uma partida.'});
        if (waiting === ws) return;
        if (waiting && waiting.readyState === WebSocket.OPEN && clients.has(waiting) && !clients.get(waiting).match && waiting !== ws) {
          const other = waiting; waiting = null; startMatch(other,ws);
        } else { waiting = ws; send(ws,{type:'queue_wait',message:'Procurando outro jogador real...'}); }
      } else if (msg.type === 'queue_leave') {
        if (!me.match) { dropFromQueue(ws); send(ws,{type:'queue_left'}); }
      } else if (msg.type === 'tap') {
        if (!me.match || me.match.done) return send(ws,{type:'error',message:'Entre em uma partida primeiro.'});
        const now = Date.now();
        if (now - me.lastTap < 110) return;
        me.lastTap = now; me.corn += 1;
        send(ws,{type:'score',corn:me.corn,remaining:Math.max(0,Math.ceil((me.match.duration-(now-me.match.startedAt))/1000))});
        for (const p of me.match.players) if (p !== me) send(p.ws,{type:'opponent_score',username:me.profile.username,corn:me.corn});
      }
    });
    ws.on('close', () => {
      const me = clients.get(ws); dropFromQueue(ws); clients.delete(ws);
      if (me?.match) endMatch(me.match,'disconnect');
    });
  } catch (e) { console.error(e); ws.close(1011,'Erro do servidor'); }
});

initDb().then(() => {
  server.listen(PORT,'0.0.0.0',() => console.log(`Hungry Birds Online ouvindo na porta ${PORT}`));
}).catch(err => { console.error('Falha ao iniciar banco PostgreSQL:',err); process.exit(1); });
