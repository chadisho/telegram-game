'use strict';
/*
  Mench game server.
  - Keeps every room and runs the rules, so nobody can cheat or get out of sync.
  - Rolls the dice on the server.
  - Plays for computer seats, and for players who disconnect or stop answering.
  - Also serves ../index.html, so one domain can host the whole game.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const SPEED = Number(process.env.MENCH_SPEED) || 1;            // tests set this higher to run fast
const TURN_MS = Number(process.env.MENCH_TURN_MS) || 40000;    // idle player is played for after this long
const MAX_ROOMS = Number(process.env.MENCH_MAX_ROOMS) || 500;
const SERVE_STATIC = process.env.MENCH_STATIC !== '0';
const INDEX = process.env.MENCH_INDEX || path.join(__dirname, '..', 'index.html');

const START = [0, 10, 20, 30];
const SEAT_ORDER = [0, 2, 1, 3];       // two players sit opposite each other
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- rules ---------- */
function legal(pcs, d) {
  const has = r => pcs.includes(r);
  const yardI = pcs.indexOf(-1);
  const mv = [];
  pcs.forEach((r, i) => {
    if (r === -1) { if (d === 6 && !has(0) && i === yardI) mv.push({ i, to: 0 }); }
    else if (r + d <= 43 && !has(r + d)) mv.push({ i, to: r + d });
  });
  if (yardI >= 0) {
    if (has(0)) { const c = mv.filter(m => pcs[m.i] === 0); if (c.length) return c; }
    else if (d === 6) { const e = mv.filter(m => pcs[m.i] === -1); if (e.length) return e; }
  }
  return mv;
}
function canThree(pcs) {
  const h = pcs.filter(r => r >= 40).sort((a, b) => b - a);
  return pcs.every(r => r === -1 || r >= 40) && h.every((r, k) => r === 43 - k);
}
function danger(room, p, a) {
  let n = 0;
  for (let q = 0; q < 4; q++) {
    if (q === p || !room.seats[q]) continue;
    room.g.pieces[q].forEach(r => {
      if (r >= 0 && r < 40) { const d = (a - (START[q] + r) % 40 + 40) % 40; if (d >= 1 && d <= 6) n++; }
    });
  }
  return n;
}
function cpuPick(room, p, moves) {
  const g = room.g;
  let best = null, bs = -1e9;
  moves.forEach(m => {
    const r = g.pieces[p][m.i];
    let s = m.to;
    if (r === -1) s += 60;
    if (r === 0) s += 25;
    if (m.to >= 40) s += 45;
    if (r >= 0 && r < 40 && danger(room, p, (START[p] + r) % 40) > 0) s += 12;
    if (m.to < 40) {
      const a = (START[p] + m.to) % 40;
      for (let q = 0; q < 4; q++) {
        if (q === p || !room.seats[q]) continue;
        g.pieces[q].forEach(rr => { if (rr >= 0 && rr < 40 && (START[q] + rr) % 40 === a) s += 100 + rr; });
      }
      s -= 22 * danger(room, p, a);
    }
    s += Math.random() * 3;
    if (s > bs) { bs = s; best = m; }
  });
  return best;
}

/* ---------- rooms ---------- */
const rooms = new Map();

function makeCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let k = 0; k < 5; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const activeSeats = room => [0, 1, 2, 3].filter(i => room.seats[i]);
const humanSeats = room => [0, 1, 2, 3].filter(i => room.seats[i] && !room.seats[i].cpu);
const snap = g => g && ({ pieces: g.pieces, turn: g.turn, phase: g.phase, die: g.die, tries: g.tries, moves: g.moves, winner: g.winner });
const pubSeats = room => room.seats.map(s => s && { name: s.name, cpu: s.cpu, connected: s.cpu || !!s.ws });

function send(ws, msg) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ } }
}
function sendRoom(room, opts = {}) {
  const base = { t: 'room', code: room.code, host: room.host, status: room.status, seats: pubSeats(room) };
  if (opts.sync && room.g) base.game = snap(room.g);
  if (opts.sync) base.sync = true;
  room.seats.forEach((s, i) => { if (s && s.ws) send(s.ws, Object.assign({ you: i }, base)); });
}
function broadcast(room, msg) { room.seats.forEach(s => { if (s && s.ws) send(s.ws, msg); }); }
function resync(room, ws, seat) {
  const base = { t: 'room', code: room.code, host: room.host, status: room.status, seats: pubSeats(room), you: seat, sync: true };
  if (room.g) base.game = snap(room.g);
  send(ws, base);
}
function ev(room, k, extra) { broadcast(room, Object.assign({ t: 'ev', k }, extra, { g: snap(room.g) })); }

function startGame(room) {
  const act = activeSeats(room);
  room.g = {
    pieces: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
    turn: act[crypto.randomInt(act.length)], phase: 'roll', die: 1, tries: 0, moves: [], winner: null
  };
  room.status = 'playing';
  room.anim = 600;
  sendRoom(room, { sync: true });
  schedule(room);
}

function nextTurn(room) {
  const g = room.g, act = activeSeats(room);
  g.turn = act[(act.indexOf(g.turn) + 1) % act.length];
  g.tries = 0; g.phase = 'roll'; g.moves = [];
}

function doRoll(room, seat) {
  const g = room.g;
  if (!g || room.status !== 'playing' || g.phase !== 'roll' || g.turn !== seat) return false;
  const d = 1 + crypto.randomInt(6);
  g.die = d; g.tries++;
  g.moves = legal(g.pieces[seat], d);
  g.phase = g.moves.length ? 'move' : 'idle';
  room.anim = 900;
  ev(room, 'roll', { seat, d });
  schedule(room);
  return true;
}

function doMove(room, seat, idx) {
  const g = room.g;
  if (!g || room.status !== 'playing' || g.phase !== 'move' || g.turn !== seat) return false;
  let m = g.moves.find(x => x.i === idx);
  if (!m && g.pieces[seat][idx] === -1) m = g.moves.find(x => g.pieces[seat][x.i] === -1);
  if (!m) return false;
  const from = g.pieces[seat][m.i];
  g.pieces[seat][m.i] = m.to;
  const caps = [];
  if (m.to < 40) {
    const a = (START[seat] + m.to) % 40;
    for (let q = 0; q < 4; q++) {
      if (q === seat || !room.seats[q]) continue;
      for (let j = 0; j < 4; j++) {
        const r = g.pieces[q][j];
        if (r >= 0 && r < 40 && (START[q] + r) % 40 === a) { g.pieces[q][j] = -1; caps.push({ seat: q, i: j }); }
      }
    }
  }
  const steps = from === -1 ? 1 : m.to - from;
  const won = g.pieces[seat].every(r => r >= 40);
  let again = false;
  if (won) { g.phase = 'over'; g.winner = seat; g.moves = []; room.status = 'over'; }
  else if (g.die === 6) { g.tries = 0; g.phase = 'roll'; g.moves = []; again = true; }
  else nextTurn(room);
  room.anim = 170 * steps + 500 + (caps.length ? 400 : 0);
  ev(room, 'move', { seat, i: m.i, from, to: m.to, caps, again, won });
  if (won) { sendRoom(room); clearTimeout(room.timer); return true; }
  schedule(room);
  return true;
}

function afterNoMove(room) {
  const g = room.g, p = g.turn;
  const again = g.die === 6;
  if (again) { g.tries = 0; g.phase = 'roll'; g.moves = []; }
  else if (canThree(g.pieces[p]) && g.tries < 3) { g.phase = 'roll'; g.moves = []; }
  else nextTurn(room);
  room.anim = 300;
  ev(room, 'turn', { seat: g.turn, again });
  schedule(room);
}

function act(room) {
  if (room.status !== 'playing' || !room.g) return;
  const g = room.g, s = room.seats[g.turn];
  if (!s) return;
  if (g.phase === 'idle') afterNoMove(room);
  else if (g.phase === 'roll') doRoll(room, g.turn);
  else if (g.phase === 'move') {
    const m = cpuPick(room, g.turn, g.moves);
    doMove(room, g.turn, m ? m.i : g.moves[0].i);
  }
}

function schedule(room) {
  clearTimeout(room.timer);
  if (room.status !== 'playing' || !room.g) return;
  const g = room.g, s = room.seats[g.turn];
  const wait = room.anim || 0;
  room.anim = 0;
  let delay;
  if (g.phase === 'idle') delay = 1300 + wait;
  else if (s && s.cpu) delay = (g.phase === 'roll' ? 900 : 1000) + wait;
  else if (s && !s.ws) delay = 3000 + wait;
  else delay = TURN_MS + wait;
  room.timer = setTimeout(() => act(room), delay / SPEED);
}

/* ---------- connections ---------- */
function cleanName(x) {
  return String(x || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
}
function cleanToken(x) {
  const s = String(x || '');
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}
function freeSeat(room) { return SEAT_ORDER.find(i => !room.seats[i]); }
function err(ws, code) { send(ws, { t: 'error', code }); }

function detach(ws) {
  const meta = ws.meta;
  ws.meta = null;
  if (!meta) return;
  const room = meta.room, s = room.seats[meta.seat];
  if (s && s.ws === ws) {
    s.ws = null;
    if (!humanSeats(room).some(i => room.seats[i].ws)) room.emptySince = Date.now();
    sendRoom(room);
    if (room.status === 'playing' && room.g && room.g.turn === meta.seat) schedule(room);
  }
}

function leaveRoom(ws) {
  const meta = ws.meta;
  if (!meta) return;
  ws.meta = null;
  const room = meta.room, seat = meta.seat;
  const s = room.seats[seat];
  if (!s || s.ws !== ws) return;
  if (room.status === 'playing') {
    // the game goes on with a computer in the empty place
    room.seats[seat] = { name: 'Computer', cpu: true, token: null, ws: null };
  } else {
    room.seats[seat] = null;
  }
  if (!humanSeats(room).length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.host === seat || !room.seats[room.host] || room.seats[room.host].cpu) {
    room.host = humanSeats(room)[0];
  }
  sendRoom(room);
  if (room.status === 'playing') schedule(room);
}

function attach(ws, room, seat) {
  const s = room.seats[seat];
  if (s.ws && s.ws !== ws) { const old = s.ws; old.meta = null; try { old.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
  s.ws = ws;
  ws.meta = { room, seat };
  room.emptySince = 0;
}

function handle(ws, m) {
  switch (m.t) {
    case 'ping': return send(ws, { t: 'pong' });
    case 'create': {
      const token = cleanToken(m.token);
      if (!token) return err(ws, 'server');
      if (rooms.size >= MAX_ROOMS) return err(ws, 'server');
      leaveRoom(ws);
      const code = makeCode();
      if (!code) return err(ws, 'server');
      const room = { code, seats: [null, null, null, null], host: SEAT_ORDER[0], status: 'lobby', g: null, timer: null, anim: 0, emptySince: 0 };
      room.seats[SEAT_ORDER[0]] = { name: cleanName(m.name), cpu: false, token, ws: null };
      rooms.set(code, room);
      attach(ws, room, SEAT_ORDER[0]);
      return sendRoom(room, { sync: true });
    }
    case 'join': {
      const token = cleanToken(m.token);
      if (!token) return err(ws, 'server');
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) return err(ws, 'notfound');
      let seat = room.seats.findIndex(s => s && !s.cpu && s.token === token);
      if (seat >= 0) {
        attach(ws, room, seat);                      // coming back
        room.seats[seat].name = cleanName(m.name || room.seats[seat].name);
        sendRoom(room);
        return resync(room, ws, seat);
      }
      if (room.status === 'playing') return err(ws, 'started');
      seat = freeSeat(room);
      if (seat === undefined) return err(ws, 'full');
      leaveRoom(ws);
      room.seats[seat] = { name: cleanName(m.name), cpu: false, token, ws: null };
      attach(ws, room, seat);
      sendRoom(room);
      return resync(room, ws, seat);
    }
  }
  const meta = ws.meta;
  if (!meta) return;
  const room = meta.room, seat = meta.seat;
  switch (m.t) {
    case 'leave': return leaveRoom(ws);
    case 'cpu': {
      if (seat !== room.host || room.status === 'playing') return;
      const i = m.seat;
      if (!Number.isInteger(i) || i < 0 || i > 3) return;
      if (m.on) { if (!room.seats[i]) room.seats[i] = { name: 'Computer', cpu: true, token: null, ws: null }; }
      else if (room.seats[i] && room.seats[i].cpu) room.seats[i] = null;
      return sendRoom(room);
    }
    case 'start': {
      if (seat !== room.host || room.status === 'playing') return;
      if (activeSeats(room).length < 2) return err(ws, 'needTwo');
      return startGame(room);
    }
    case 'roll': {
      if (!doRoll(room, seat)) resync(room, ws, seat);
      return;
    }
    case 'move': {
      if (!Number.isInteger(m.i) || !doMove(room, seat, m.i)) resync(room, ws, seat);
      return;
    }
  }
}

/* ---------- http + websocket ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (SERVE_STATIC && (url === '/' || url === '/index.html')) {
    fs.readFile(INDEX, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', ws => {
  ws.alive = true;
  ws.meta = null;
  ws.hits = [];
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    const now = Date.now();
    ws.hits = ws.hits.filter(t => now - t < 10000);
    if (ws.hits.push(now) > 60) return;              // more than 60 messages in 10 s: ignore
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, 25000).unref();

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const nobody = !humanSeats(room).some(i => room.seats[i].ws);
    if (nobody && room.emptySince && now - room.emptySince > 15 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  });
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('Mench server listening on port ' + PORT));
}
module.exports = { server, rooms };
