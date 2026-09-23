// 依存ゼロの HTTP + Server-Sent Events サーバー
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomInt } from 'node:crypto';
import { RoomStore, GameError, safeEqual } from './src/rooms.js';
import qrcode from './src/vendor/qrcode.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
const PAGES = {
  '/': 'index.html',
  '/host': 'host.html',
  '/play': 'play.html',
  '/screen': 'screen.html',
  '/poster': 'poster.html',
};

/** 参加URL用の QR コード（SVG） */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true, alt: text });
}

/** PWA マニフェスト。room 付きで開くと、ホーム画面のアイコンからそのルームに直行する */
export function manifestFor(room) {
  const code = /^[A-Za-z0-9]{1,12}$/.test(room ?? '') ? room.toUpperCase() : '';
  return {
    id: '/',
    name: 'リアルタイムビンゴ',
    short_name: 'BINGO',
    description: 'スマホで遊べるリアルタイム・ビンゴ',
    lang: 'ja',
    start_url: code ? `/?room=${code}` : '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f1020',
    theme_color: '#0f1020',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}

/** 会場 Wi-Fi から届く LAN 側の URL 候補 */
function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

export function createApp({
  dataFile = null,
  tickMs = 1000,
  // Render は公開URLを RENDER_EXTERNAL_URL で自動設定する
  publicUrl = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? '',
  // PaaS のプロキシ配下では X-Forwarded-For の先頭が実クライアント
  trustProxy = process.env.TRUST_PROXY === '1' || Boolean(process.env.RENDER),
  staffThrottleMs = 500,
  joinRatePerMin = Number(process.env.JOIN_RATE_PER_MIN ?? 6000),
} = {}) {
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
    res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  }

  // 共通部分(room)は1回だけ文字列化し、個人部分だけを連結する（数千接続への配信コストを削減）
  function payloadFor(room, client, pubJson, host, event) {
    let extra = '';
    if (client.role === 'host') extra = `,"host":${JSON.stringify(host())}`;
    if (client.role === 'player') {
      const player = room.players[client.playerId];
      extra = player ? `,"me":${JSON.stringify(room.playerView(player))}` : ',"kicked":true';
    }
    return `{"room":${pubJson},"event":${JSON.stringify(event ?? null)}${extra}}`;
  }

  const isStaff = (c) => c.role !== 'player';
  const staffTimers = new Map();

  function sendTo(room, filter, event) {
    const set = clients.get(room.id);
    if (!set) return;
    const pubJson = JSON.stringify(room.publicState());
    const host = () => room.hostView(staffThrottleMs);
    for (const client of set) if (filter(client)) send(client.res, payloadFor(room, client, pubJson, host, event));
  }

  /** ホスト・投影画面への更新はまとめて最大 staffThrottleMs に1回 */
  function scheduleStaff(room) {
    if (staffTimers.has(room.id)) return;
    const t = setTimeout(() => {
      staffTimers.delete(room.id);
      sendTo(room, isStaff, { kind: 'update' });
    }, staffThrottleMs);
    t.unref();
    staffTimers.set(room.id, t);
  }

  function broadcast(room, event = null) {
    const personal = event?.playerId;
    // 参加・マス開け等は全員に送らない（数千人が同時に参加しても O(N^2) にならない）
    if (personal || event?.kind === 'join') {
      if (personal) sendTo(room, (c) => c.playerId === personal, event);
      scheduleStaff(room);
      return;
    }
    clearTimeout(staffTimers.get(room.id));
    staffTimers.delete(room.id);
    room.hostViewCache = null;
    sendTo(room, () => true, event);
  }

  store.on('change', (room, event) => broadcast(room, event));
  store.on('removed', (room) => {
    for (const c of clients.get(room.id) ?? []) c.res.end();
    clients.delete(room.id);
  });

  const tick = setInterval(() => store.tick(), tickMs);
  const heartbeat = setInterval(() => {
    for (const set of clients.values()) for (const c of set) c.res.write(': ping\n\n');
    const now = Date.now();
    for (const [key, hits] of limits) if (now - hits.at(-1) > 60_000) limits.delete(key);
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
    // 再接続が一斉に押し寄せないよう待ち時間をばらす
    res.write(`retry: ${1500 + randomInt(3500)}\n\n`);
    if (!clients.has(room.id)) clients.set(room.id, new Set());
    clients.get(room.id).add(client);
    send(res, payloadFor(room, client, JSON.stringify(room.publicState()), () => room.hostView(staffThrottleMs), { kind: 'sync' }));
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
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const ip = forwarded || req.socket.remoteAddress || '';

    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { publicUrl: publicUrl.replace(/\/+$/, ''), lanUrls: lanUrls(server.address()?.port) });
    }
    if (req.method === 'GET' && url.pathname === '/api/qr.svg') {
      const text = url.searchParams.get('text') ?? '';
      if (!text || text.length > 512) throw new GameError('text が不正です');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(qrSvg(text));
    }

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
      // 会場 Wi-Fi は全員が同じグローバルIPになりやすいので上限は緩め
      rateLimit(`join:${ip}`, joinRatePerMin, 60_000);
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
      const short = url.pathname.match(/^\/r\/([A-Za-z0-9]{1,12})\/?$/);
      if (short) {
        // QR 用の短い参加URL
        res.writeHead(302, { Location: `/?room=${short[1].toUpperCase()}` });
        res.end();
      } else if (url.pathname === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(manifestFor(url.searchParams.get('room'))));
      } else if (url.pathname.startsWith('/api/')) await api(req, res, url);
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
    for (const t of staffTimers.values()) clearTimeout(t);
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
