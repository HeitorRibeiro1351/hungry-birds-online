'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!JWT_SECRET) {
  console.error('ERRO: Configure JWT_SECRET nas variáveis de ambiente.');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('ERRO: Configure DATABASE_URL nas variáveis de ambiente.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4096
});

const clients = new Map();

let waiting = null;
let matchCounter = 0;

const AVATARS = [
  '🐦', '🐤', '🦅', '🦜',
  '🐧', '🦉', '🦫', '🐔'
];

const MATCH_DURATION_MS = 60000;
const MIN_TAP_INTERVAL_MS = 110;

function publicPlayer(row) {
  return {
    username: row.username,
    avatar: row.avatar
  };
}

function makeToken(row) {
  return jwt.sign(
    {
      id: row.id,
      username: row.username
    },
    JWT_SECRET,
    {
      expiresIn: '30d'
    }
  );
}

function authHeader(req) {
  const raw = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  if (!raw) return null;

  try {
    return jwt.verify(raw, JWT_SECRET);
  } catch {
    return null;
  }
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function dropFromQueue(ws) {
  if (waiting === ws) {
    waiting = null;
  }
}

function clearPlayerMatch(player) {
  if (!player) return;

  player.match = null;
  player.lastTap = 0;
  player.corn = 0;
}

function endMatch(match, reason = 'finished') {
  if (!match || match.done) return;

  match.done = true;
  clearTimeout(match.timer);

  const [a, b] = match.players;

  let winner = null;

  if (a.corn > b.corn) {
    winner = a;
  } else if (b.corn > a.corn) {
    winner = b;
  }

  const result = {
    type: 'match_end',
    reason,
    winner: winner ? winner.profile.username : null,
    draw: !winner,
    scores: match.players.map(player => ({
      username: player.profile.username,
      avatar: player.profile.avatar,
      corn: player.corn
    }))
  };

  for (const player of match.players) {
    send(player.ws, result);
  }

  for (const player of match.players) {
    clearPlayerMatch(player);
  }
}

function startMatch(wsA, wsB) {
  const a = clients.get(wsA);
  const b = clients.get(wsB);

  if (
    !a ||
    !b ||
    a === b ||
    a.match ||
    b.match
  ) {
    if (a && !a.match) {
      send(a.ws, {
        type: 'error',
        message: 'Não foi possível iniciar a partida. Tente novamente.'
      });
    }

    if (b && !b.match) {
      send(b.ws, {
        type: 'error',
        message: 'Não foi possível iniciar a partida. Tente novamente.'
      });
    }

    return;
  }

  const match = {
    id: ++matchCounter,
    players: [a, b],
    done: false,
    startedAt: Date.now(),
    duration: MATCH_DURATION_MS,
    timer: null
  };

  for (const player of match.players) {
    player.match = match;
    player.corn = 0;
    player.lastTap = 0;
  }

  const players = match.players.map(player => player.profile);

  for (const player of match.players) {
    send(player.ws, {
      type: 'match_start',
      duration: match.duration,
      players
    });
  }

  match.timer = setTimeout(() => {
    endMatch(match, 'finished');
  }, match.duration);
}

function joinQueue(ws) {
  const me = clients.get(ws);

  if (!me) return;

  if (me.match) {
    send(ws, {
      type: 'error',
      message: 'Você já está em uma partida.'
    });
    return;
  }

  if (waiting === ws) return;

  if (
    waiting &&
    waiting.readyState === WebSocket.OPEN &&
    clients.has(waiting)
  ) {
    const otherWs = waiting;
    const other = clients.get(otherWs);

    if (other && !other.match && otherWs !== ws) {
      waiting = null;
      startMatch(otherWs, ws);
      return;
    }
  }

  waiting = ws;

  send(ws, {
    type: 'queue_wait',
    message: 'Procurando outro jogador real...'
  });
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(16) NOT NULL,
      username_norm VARCHAR(16) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar VARCHAR(16) NOT NULL DEFAULT '🐦',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Hungry Birds Online'
  });
});

app.get('/api/me', async (req, res) => {
  const payload = authHeader(req);

  if (!payload) {
    return res.status(401).json({
      error: 'Entre na sua conta novamente.'
    });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, username, avatar FROM players WHERE id = $1',
      [payload.id]
    );

    if (!rows[0]) {
      return res.status(401).json({
        error: 'Conta não encontrada.'
      });
    }

    return res.json({
      player: publicPlayer(rows[0])
    });
  } catch (err) {
    console.error('GET /api/me:', err);

    return res.status(503).json({
      error: 'Banco de dados indisponível.'
    });
  }
});

app.post('/api/register', async (req, res) => {
  let { username, password, avatar } = req.body || {};

  username = typeof username === 'string'
    ? username.trim()
    : '';

  password = typeof password === 'string'
    ? password
    : '';

  avatar = typeof avatar === 'string' &&
    AVATARS.includes(avatar)
      ? avatar
      : '🐦';

  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({
      error: 'O nome precisa ter de 3 a 16 caracteres: letras, números ou _.'
    });
  }

  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({
      error: 'A senha deve ter de 8 a 72 caracteres.'
    });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO players
        (username, username_norm, password_hash, avatar)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, avatar`,
      [
        username,
        username.toLowerCase(),
        hash,
        avatar
      ]
    );

    return res.status(201).json({
      token: makeToken(rows[0]),
      player: publicPlayer(rows[0])
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Esse nome já está em uso. Escolha outro.'
      });
    }

    console.error('POST /api/register:', err);

    return res.status(503).json({
      error: 'Não foi possível criar a conta. Confira se o banco está configurado.'
    });
  }
});

app.post('/api/login', async (req, res) => {
  const username = typeof req.body?.username === 'string'
    ? req.body.username.trim()
    : '';

  const password = typeof req.body?.password === 'string'
    ? req.body.password
    : '';

  try {
    const { rows } = await pool.query(
      `SELECT id, username, avatar, password_hash
       FROM players
       WHERE username_norm = $1`,
      [username.toLowerCase()]
    );

    if (
      !rows[0] ||
      !(await bcrypt.compare(password, rows[0].password_hash))
    ) {
      return res.status(401).json({
        error: 'Nome ou senha incorretos.'
      });
    }

    return res.json({
      token: makeToken(rows[0]),
      player: publicPlayer(rows[0])
    });
  } catch (err) {
    console.error('POST /api/login:', err);

    return res.status(503).json({
      error: 'Banco de dados indisponível.'
    });
  }
});

app.post('/api/avatar', async (req, res) => {
  const payload = authHeader(req);

  if (!payload) {
    return res.status(401).json({
      error: 'Entre na conta.'
    });
  }

  const avatar = req.body?.avatar;

  if (!AVATARS.includes(avatar)) {
    return res.status(400).json({
      error: 'Foto de perfil inválida.'
    });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE players
       SET avatar = $1
       WHERE id = $2
       RETURNING username, avatar`,
      [avatar, payload.id]
    );

    if (!rows[0]) {
      return res.status(401).json({
        error: 'Conta não encontrada.'
      });
    }

    const player = publicPlayer(rows[0]);

    for (const client of clients.values()) {
      if (client.profile.username === player.username) {
        client.profile = player;
      }
    }

    return res.json({ player });
  } catch (err) {
    console.error('POST /api/avatar:', err);

    return res.status(503).json({
      error: 'Não foi possível atualizar a foto.'
    });
  }
});

server.on('upgrade', (req, socket, head) => {
  let url;

  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  let payload;

  try {
    payload = jwt.verify(
      url.searchParams.get('token') || '',
      JWT_SECRET
    );
  } catch {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'Connection: close\r\n\r\n'
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.playerId = payload.id;
    wss.emit('connection', ws, payload);
  });
});

wss.on('connection', async (ws, payload) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, avatar FROM players WHERE id = $1',
      [payload.id]
    );

    if (!rows[0]) {
      ws.close(1008, 'Conta não encontrada');
      return;
    }

    // Impede que a mesma conta use duas conexões simultâneas.
    for (const [oldWs, oldClient] of clients.entries()) {
      if (oldClient.profile.username === rows[0].username) {
        dropFromQueue(oldWs);

        if (oldClient.match) {
          endMatch(oldClient.match, 'disconnect');
        }

        clients.delete(oldWs);

        try {
          oldWs.close(4001, 'Conta conectada em outro lugar');
        } catch {}
      }
    }

    const client = {
      ws,
      profile: publicPlayer(rows[0]),
      match: null,
      corn: 0,
      lastTap: 0
    };

    clients.set(ws, client);

    send(ws, {
      type: 'connected',
      player: client.profile,
      online: clients.size
    });

    ws.on('message', raw => {
      let msg;

      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, {
          type: 'error',
          message: 'Mensagem inválida.'
        });
        return;
      }

      const me = clients.get(ws);

      if (!me || !msg || typeof msg.type !== 'string') {
        return;
      }

      if (msg.type === 'queue_join') {
        joinQueue(ws);
        return;
      }

      if (msg.type === 'queue_leave') {
        if (me.match) {
          send(ws, {
            type: 'error',
            message: 'A partida já começou; aguarde o fim da rodada.'
          });
          return;
        }

        dropFromQueue(ws);

        send(ws, {
          type: 'queue_left'
        });
        return;
      }

      if (msg.type === 'tap') {
        if (!me.match || me.match.done) {
          send(ws, {
            type: 'error',
            message: 'Entre em uma partida primeiro.'
          });
          return;
        }

        const match = me.match;
        const now = Date.now();

        if (now - me.lastTap < MIN_TAP_INTERVAL_MS) {
          return;
        }

        me.lastTap = now;
        me.corn += 1;

        const remaining = Math.max(
          0,
          Math.ceil(
            (match.duration - (now - match.startedAt)) / 1000
          )
        );

        send(ws, {
          type: 'score',
          corn: me.corn,
          remaining
        });

        for (const opponent of match.players) {
          if (opponent !== me) {
            send(opponent.ws, {
              type: 'opponent_score',
              username: me.profile.username,
              corn: me.corn
            });
          }
        }

        return;
      }

      send(ws, {
        type: 'error',
        message: 'Ação desconhecida.'
      });
    });

    ws.on('close', () => {
      const me = clients.get(ws);

      dropFromQueue(ws);
      clients.delete(ws);

      if (me?.match) {
        endMatch(me.match, 'disconnect');
      }
    });

    ws.on('error', err => {
      console.error('WebSocket error:', err.message);
    });
  } catch (err) {
    console.error('WebSocket connection setup:', err);

    try {
      ws.close(1011, 'Erro do servidor');
    } catch {}
  }
});

initDb()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(
        `Hungry Birds Online ouvindo na porta ${PORT}`
      );
    });
  })
  .catch(err => {
    console.error(
      'Falha ao iniciar banco PostgreSQL:',
      err
    );
    process.exit(1);
  });

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Encerrando servidor...');

  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Servidor reiniciando');
    } catch {}
  }

  try {
    await pool.end();
  } catch (err) {
    console.error('Erro ao fechar banco:', err);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
