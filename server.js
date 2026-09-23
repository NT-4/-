// 依存ゼロの HTTP + Server-Sent Events サーバー
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomStore, GameError, safeEqual } from './src/rooms.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};
const PAGES = { '/': 'index.html', '/host': 'host.html', '/play': 'play.html', '/screen': 'screen.html' };

export function createApp({ dataFile = null, tickMs = 1000 } = {}) {
  const store = new RoomStore({ file: dataFile });
  /** roomId -> Set<{res, role, playerId}> */
  const clients = new Map();
  const limits = new Map();

  function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const hits = (limits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) throw new GameError('リクエストが多すぎます。少し待ってください', 429);
    hits.push(now);
    limits.set(key, hits);
  }

  function send(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function payloadFor(room, client, pub, host, event) {
    const payload = { room: pub, event };
    if (client.role === 'host') payload.host = host();
    if (client.role === 'player') {
      const player = room.players[client.playerId];
      if (!player) return { ...payload, kicked: true };
      payload.me = room.playerView(player);
    }
    return payload;
  }

  function broadcast(room, event = null, onlyPlayerId = null) {
    const set = clients.get(room.id);
    if (!set) return;
    const pub = room.publicState();
    let hostCache;
    const host = () => (hostCache ??= room.hostView());
    for (const client of set) {
      // マス開け等の個人操作は本人とホストにだけ送る（数千人規模でも O(N) に抑える）
      if (onlyPlayerId && client.role !== 'host' && client.playerId !== onlyPlayerId) continue;
      send(client.res, payloadFor(room, client, pub, host, event));
    }
  }

  store.on('change', (room, event) => broadcast(room, event, event?.playerId ?? null));
  store.on('removed', (room) => {
    for (const c of clients.get(room.id) ?? []) c.res.end();
    clients.delete(room.id);
  });

  const tick = setInterval(() => store.tick(), tickMs);
  const heartbeat = setInterval(() => {
    for (const set of clients.values()) for (const c of set) c.res.write(': ping\n\n');
  }, 20_000);
  tick.unref();
  heartbeat.unref();

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16_384) throw new GameError('リクエストが大きすぎます', 413);
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new GameError('JSON が不正です');
    }
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function requireHost(room, req) {
    if (!safeEqual(req.headers['x-token'], room.hostToken)) throw new GameError('ホスト権限がありません', 403);
  }

  function requirePlayer(room, req) {
    const player = room.findPlayerByToken(req.headers['x-token']);
    if (!player) throw new GameError('参加者として認証できません。再参加してください', 403);
    return player;
  }

  function openEvents(room, req, res, url) {
    const tok = url.searchParams.get('token') ?? '';
    let client = { res, role: 'screen', playerId: null };
    if (tok && safeEqual(tok, room.hostToken)) client.role = 'host';
    else if (tok) {
      const player = room.findPlayerByToken(tok);
      if (!player) throw new GameError('参加者として認証できません', 403);
      client = { res, role: 'player', playerId: player.id };
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    if (!clients.has(room.id)) clients.set(room.id, new Set());
    clients.get(room.id).add(client);
    send(res, payloadFor(room, client, room.publicState(), () => room.hostView(), { kind: 'sync' }));
    req.on('close', () => clients.get(room.id)?.delete(client));
  }

  const HOST_ACTIONS = {
    start: (room) => (room.start(), { kind: 'start' }),
    pause: (room) => (room.pause(), { kind: 'pause' }),
    resume: (room) => (room.resume(), { kind: 'resume' }),
    finish: (room) => (room.finish(), { kind: 'finish' }),
    reset: (room) => (room.reset(), { kind: 'reset' }),
    draw: (room) => ({ kind: 'draw', number: room.draw() }),
    settings: (room, body) => (room.updateSettings(body), { kind: 'settings' }),
    tiebreak: (room, body) => (room.tiebreak(body.achievedAtDraw, body.method), { kind: 'tiebreak' }),
    move: (room, body) => (room.moveWinner(body.winnerId, body.dir), { kind: 'tiebreak' }),
  };

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api','rooms',id,...]
    const ip = req.socket.remoteAddress ?? '';

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
      rateLimit(`create:${ip}`, 10, 60_000);
      const body = await readJson(req);
      const room = store.create(body);
      return json(res, 201, { roomId: room.id, hostToken: room.hostToken });
    }

    if (parts[1] !== 'rooms' || !parts[2]) throw new GameError('Not Found', 404);
    const room = store.get(parts[2]);
    const action = parts.slice(3).join('/');

    if (req.method === 'GET' && action === 'events') return openEvents(room, req, res, url);
    if (req.method === 'GET' && action === '') return json(res, 200, room.publicState());
    if (req.method !== 'POST') throw new GameError('Method Not Allowed', 405);

    const body = await readJson(req);

    if (action === 'join') {
      rateLimit(`join:${ip}`, 60, 60_000);
      const player = room.addPlayer(body.name);
      store.changed(room, { kind: 'join' });
      return json(res, 201, { playerId: player.id, token: player.token });
    }

    if (action.startsWith('host/')) {
      requireHost(room, req);
      const fn = HOST_ACTIONS[action.slice(5)];
      if (!fn) throw new GameError('Not Found', 404);
      const event = fn(room, body);
      store.changed(room, event);
      return json(res, 200, { ok: true, event });
    }

    const player = requirePlayer(room, req);
    if (action === 'mark') {
      room.mark(player, body.cardId, body.index);
      store.changed(room, { kind: 'mark', playerId: player.id });
      return json(res, 200, { ok: true });
    }
    if (action === 'prefs') {
      room.setPrefs(player, body);
      store.changed(room, { kind: 'prefs', playerId: player.id });
      return json(res, 200, { ok: true });
    }
    if (action === 'claim') {
      rateLimit(`claim:${player.id}`, 3, 5_000);
      try {
        const result = room.claim(player, body.cardId);
        if (!result.duplicate) store.changed(room, { kind: 'bingo', name: player.name, winnerId: result.winner.id });
        return json(res, 200, result);
      } catch (e) {
        store.changed(room, { kind: 'claim-rejected', playerId: player.id });
        throw e;
      }
    }
    throw new GameError('Not Found', 404);
  }

  async function serveStatic(res, pathname) {
    const rel = PAGES[pathname] ?? pathname.slice(1);
    const file = normalize(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) throw new GameError('Not Found', 404);
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    } catch {
      throw new GameError('Not Found', 404);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET') await serveStatic(res, url.pathname);
      else throw new GameError('Method Not Allowed', 405);
    } catch (e) {
      const status = e instanceof GameError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'サーバーエラー' : e.message });
      else res.end();
    }
  });

  server.on('close', () => {
    clearInterval(tick);
    clearInterval(heartbeat);
    store.saveNow();
  });

  return { server, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const dataFile = process.env.DATA_FILE ?? join(ROOT, 'data', 'rooms.json');
  const { server, store } = createApp({ dataFile });
  server.listen(port, () => console.log(`BINGO server: http://localhost:${port}`));
  const shutdown = () => {
    store.saveNow();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
