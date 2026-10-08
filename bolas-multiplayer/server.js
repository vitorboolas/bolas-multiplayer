'use strict';
// Servidor do Bolas: Node.js + ws. Roda o jogo inteiro e manda o estado pros jogadores.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAP = 5000, FOOD_N = 500, BOT_N = 20, EAT = 1.15, MAX_CELLS = 8, SPLIT_MIN = 36,
      EJECT_MIN = 25, MAX_PLAYERS = 40, VIEW = 1800, SP_R = 110, SP_MAX = 30, MERGE_MS = 5000;
const BOT_NAMES = ['Pipoca', 'Biscoito', 'Nuvem', 'Foguete', 'Estrela', 'Pudim', 'Ninja', 'Dragão', 'Panda', 'Gelinho'];

const rnd = (a, b) => a + Math.random() * (b - a);
const radius = m => Math.sqrt(m) * 4;
const speed = m => 3.2 / Math.pow(m, 0.28);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = v => Math.max(0, Math.min(MAP, v));
const hue = () => Math.floor(rnd(0, 360));
const r1 = v => Math.round(v * 10) / 10;

let nextId = 1;
const players = new Map();
let foods = [], items = [], bots = [], spawners = [];

const newFood = () => ({ x: rnd(0, MAP), y: rnd(0, MAP), m: rnd(3, 7), h: hue() });
const newBot = () => ({ id: nextId++, o: 0, x: rnd(0, MAP), y: rnd(0, MAP), m: rnd(15, 65),
  c: `hsl(${hue()},80%,58%)`, n: BOT_NAMES[Math.floor(rnd(0, BOT_NAMES.length))],
  tx: 0, ty: 0, next: 0, dx: 0, dy: 0 });
const mkCell = (p, x, y, m) => ({ id: nextId++, o: p.id, x, y, m, vx: 0, vy: 0, sx: 0, sy: 0, merge: 0, c: p.color, n: p.name });

for (let i = 0; i < FOOD_N; i++) foods.push(newFood());
for (let i = 0; i < BOT_N; i++) bots.push(newBot());
for (let i = 0; i < 6; i++) spawners.push({ x: rnd(300, MAP - 300), y: rnd(300, MAP - 300), next: 0 });

const send = (p, obj) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); };

function spawnPlayer(p) {
  const c = mkCell(p, rnd(300, MAP - 300), rnd(300, MAP - 300), 20);
  p.cells = [c]; p.alive = true; p.peak = 20; p.mx = c.x; p.my = c.y; p.known = new Set();
}

function split(p) {
  if (p.cells.length >= MAX_CELLS) return;
  const out = [], now = Date.now();
  for (const c of p.cells) {
    if (c.m < SPLIT_MIN || out.length >= MAX_CELLS - 1) { out.push(c); continue; }
    const half = c.m / 2; c.m = half;
    const dx = p.mx - c.x, dy = p.my - c.y, d = Math.hypot(dx, dy) || 1;
    const n = mkCell(p, c.x, c.y, half);
    n.vx = dx / d * 22; n.vy = dy / d * 22; n.merge = now + MERGE_MS;
    c.vx -= dx / d * 6; c.vy -= dy / d * 6; c.merge = now + MERGE_MS;
    out.push(n, c);
  }
  p.cells = out;
}

function eject(p) {
  const now = Date.now();
  for (const c of p.cells) {
    if (c.m < EJECT_MIN || items.length > 600) continue;
    c.m -= 8;
    const dx = p.mx - c.x, dy = p.my - c.y, d = Math.hypot(dx, dy) || 1;
    items.push({ x: c.x + dx / d * radius(c.m), y: c.y + dy / d * radius(c.m), m: 8, h: hue(), vx: dx / d * 15, vy: dy / d * 15, life: now + 8000 });
  }
}

function tick(dt, now) {
  // jogadores: movimento, separação e junção das células
  for (const p of players.values()) {
    if (!p.alive) continue;
    const fr = Math.pow(0.91, dt), k = Math.min(1, 0.55 * dt);
    for (const c of p.cells) {
      c.x += c.vx * dt; c.y += c.vy * dt; c.vx *= fr; c.vy *= fr;
      const dx = p.mx - c.x, dy = p.my - c.y, d = Math.hypot(dx, dy) || 1;
      const sp = speed(c.m) * 7.5 * Math.min(1, d / (radius(c.m) * 0.8));
      c.sx += ((dx / d) * sp - c.sx) * k; c.sy += ((dy / d) * sp - c.sy) * k;
      c.x = clamp(c.x + c.sx * dt); c.y = clamp(c.y + c.sy * dt);
    }
    for (let i = 0; i < p.cells.length; i++) for (let j = i + 1; j < p.cells.length; j++) {
      const a = p.cells[i], b = p.cells[j];
      if (a.dead || b.dead) continue;
      const d = dist(a, b), min = radius(a.m) + radius(b.m);
      if (now < a.merge || now < b.merge) {
        if (d < min) {
          const nx = (b.x - a.x) / (d || 1), ny = (b.y - a.y) / (d || 1), push = (min - d) / 2;
          a.x = clamp(a.x - nx * push); a.y = clamp(a.y - ny * push);
          b.x = clamp(b.x + nx * push); b.y = clamp(b.y + ny * push);
        }
      } else if (d < radius(a.m) + radius(b.m) * 0.55) {
        a.m += b.m; a.x = (a.x + b.x) / 2; a.y = (a.y + b.y) / 2; b.dead = true;
      }
    }
    p.cells = p.cells.filter(c => !c.dead);
  }

  // bots: passeiam e vão atrás da comida mais próxima
  for (const b of bots) {
    if (now > b.next) { b.tx = rnd(0, MAP); b.ty = rnd(0, MAP); b.next = now + rnd(1000, 3000); }
    let tx = b.tx, ty = b.ty, best = 260;
    for (const f of foods) { const d = Math.hypot(f.x - b.x, f.y - b.y); if (d < best) { best = d; tx = f.x; ty = f.y; } }
    const dx = tx - b.x, dy = ty - b.y, d = Math.hypot(dx, dy) || 1, k = Math.min(1, 0.06 * dt);
    b.dx += (dx / d - b.dx) * k; b.dy += (dy / d - b.dy) * k;
    const sp = speed(b.m) * 5 * dt;
    b.x = clamp(b.x + b.dx * sp); b.y = clamp(b.y + b.dy * sp);
  }

  // células douradas soltam massinhas
  for (const s of spawners) {
    if (now < s.next) continue;
    s.next = now + 600;
    if (items.reduce((n, i) => n + (i.s === s ? 1 : 0), 0) >= SP_MAX) continue;
    const a = rnd(0, 6.283), sp = rnd(4, 7);
    items.push({ x: s.x + Math.cos(a) * (SP_R + 2), y: s.y + Math.sin(a) * (SP_R + 2), m: 7, h: hue(), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, s });
  }
  const ifr = Math.pow(0.955, dt);
  for (const i of items) { i.x = clamp(i.x + i.vx * dt); i.y = clamp(i.y + i.vy * dt); i.vx *= ifr; i.vy *= ifr; }
  items = items.filter(i => !i.life || i.life > now);

  // quem come quem
  const ents = [];
  for (const p of players.values()) if (p.alive) ents.push(...p.cells);
  ents.push(...bots);
  for (const a of ents) {
    if (a.dead) continue;
    const ra = radius(a.m);
    for (let i = 0; i < foods.length; i++) if (dist(a, foods[i]) < ra - 2) { a.m += foods[i].m * 0.8; foods[i] = newFood(); }
    items = items.filter(it => { if (dist(a, it) < ra) { a.m += it.m * 0.9; return false; } return true; });
    for (const b of ents) {
      if (b === a || b.dead || (a.o && a.o === b.o)) continue;
      if (a.m > b.m * EAT && dist(a, b) < ra - radius(b.m) * 0.2) { a.m += b.m * 0.85; b.dead = true; }
    }
  }

  for (const p of players.values()) {
    if (!p.alive) continue;
    p.cells = p.cells.filter(c => !c.dead);
    p.peak = Math.max(p.peak, p.cells.reduce((s, c) => s + c.m, 0));
    if (!p.cells.length) { p.alive = false; send(p, { t: 'dead', peak: Math.floor(p.peak) }); }
  }
  bots = bots.filter(b => !b.dead);
  while (bots.length < BOT_N) bots.push(newBot());
}

function broadcast(n) {
  const all = [];
  for (const p of players.values()) if (p.alive) all.push(...p.cells);
  all.push(...bots);
  let lb = null;
  if (n % 20 === 0) {
    const tot = new Map();
    for (const c of all) {
      const key = c.o || 'b' + c.id, t = tot.get(key) || { n: c.n, m: 0, o: c.o };
      t.m += c.m; tot.set(key, t);
    }
    lb = [...tot.values()].sort((a, b) => b.m - a.m).slice(0, 8).map(t => [t.n, Math.floor(t.m), t.o]);
  }
  for (const p of players.values()) {
    if (!p.alive || !p.cells.length) continue;
    const cx = p.cells.reduce((s, c) => s + c.x, 0) / p.cells.length;
    const cy = p.cells.reduce((s, c) => s + c.y, 0) / p.cells.length;
    const inView = e => Math.abs(e.x - cx) < VIEW && Math.abs(e.y - cy) < VIEW;
    const c = [], seen = new Set(), f = [];
    for (const e of all) {
      if (!inView(e)) continue;
      seen.add(e.id);
      const row = [e.id, Math.round(e.x), Math.round(e.y), r1(e.m), e.o];
      if (!p.known.has(e.id)) row.push(e.c, e.n);   // cor e nome só na primeira vez
      c.push(row);
    }
    p.known = seen;
    for (const x of foods) if (inView(x)) f.push(Math.round(x.x), Math.round(x.y), r1(x.m), x.h);
    for (const x of items) if (inView(x)) f.push(Math.round(x.x), Math.round(x.y), r1(x.m), x.h);
    send(p, { t: 's', c, f, lb });
  }
}

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
const wss = new WebSocketServer({ server, maxPayload: 512 });

wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.close(); return; }
  const p = { id: nextId++, ws, name: 'Jogador', color: '#4fc3f7', cells: [], alive: false, mx: 0, my: 0, peak: 0, known: new Set(), msgs: 0 };
  players.set(ws, p);
  ws.on('message', raw => {
    if (++p.msgs > 120) return;   // limite de mensagens por segundo
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join') {
      p.name = String(m.name || 'Jogador').replace(/[<>&"'`]/g, '').slice(0, 12) || 'Jogador';
      p.color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#4fc3f7';
      spawnPlayer(p);
      send(p, { t: 'welcome', id: p.id, map: MAP });
    } else if (!p.alive) return;
    else if (m.t === 'in' && Number.isFinite(m.x) && Number.isFinite(m.y)) { p.mx = m.x; p.my = m.y; }
    else if (m.t === 'split') split(p);
    else if (m.t === 'eject') eject(p);
    else if (m.t === 'leave') { p.alive = false; p.cells = []; }
  });
  ws.on('close', () => players.delete(ws));
});

setInterval(() => { for (const p of players.values()) p.msgs = 0; }, 1000);
let last = Date.now(), n = 0;
setInterval(() => {
  const now = Date.now(), dt = Math.min(3, (now - last) / 16.667);
  last = now;
  tick(dt, now);
  if (++n % 3 === 0) broadcast(n / 3);
}, 16);

server.listen(PORT, () => console.log('Bolas rodando na porta ' + PORT));
