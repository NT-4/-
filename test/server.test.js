import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

let app;
let base;

before(async () => {
  app = createApp({ tickMs: 50 });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.closeAllConnections();
  app.server.close();
});

async function call(path, body, token) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function setup(settings = {}) {
  const { body: created } = await call('/api/rooms', { title: 'テスト', prizes: '一等\n二等', ...settings });
  const room = app.store.get(created.roomId);
  const join = async (name) => (await call(`/api/rooms/${room.id}/join`, { name })).body;
  return { room, hostToken: created.hostToken, join };
}

test('ホスト操作にはホストトークンが必要', async () => {
  const { room, hostToken, join } = await setup();
  const p = await join('A');
  assert.equal((await call(`/api/rooms/${room.id}/host/start`, {}, p.token)).status, 403);
  assert.equal((await call(`/api/rooms/${room.id}/host/start`, {})).status, 403);
  assert.equal((await call(`/api/rooms/${room.id}/host/start`, {}, hostToken)).status, 200);
  assert.equal(room.status, 'running');
});

test('未抽選の番号は開けられず、偽ビンゴ申請は拒否される', async () => {
  const { room, hostToken, join } = await setup();
  const p = await join('Cheater');
  await call(`/api/rooms/${room.id}/host/start`, {}, hostToken);
  const card = room.players[p.playerId].cards[0];

  const mark = await call(`/api/rooms/${room.id}/mark`, { cardId: card.id, index: 0 }, p.token);
  assert.equal(mark.status, 400);

  // クライアント側でマークを偽装しても（サーバーデータを直接書き換えても）抽選履歴と矛盾すれば拒否
  card.marks = card.marks.map(() => true);
  const claim = await call(`/api/rooms/${room.id}/claim`, { cardId: card.id }, p.token);
  assert.equal(claim.status, 422);
  assert.equal(room.winners.length, 0);
  assert.equal(room.rejectedClaims, 1);
});

test('正しいビンゴはサーバー検証を通り、順位と景品が付く。同時ビンゴも検出', async () => {
  const { room, hostToken, join } = await setup();
  const a = await join('Alice');
  const b = await join('Bob');
  await call(`/api/rooms/${room.id}/host/start`, {}, hostToken);
  const ca = room.players[a.playerId].cards[0];
  const cb = room.players[b.playerId].cards[0];

  // 2人の中段（FREE含む）が同じ球で揃うように抽選履歴を作る
  const need = [...new Set([ca.numbers[10], ca.numbers[11], ca.numbers[13], ca.numbers[14],
    cb.numbers[10], cb.numbers[11], cb.numbers[13], cb.numbers[14]])];
  room.draws = need;
  for (const [p, c] of [[a, ca], [b, cb]]) {
    for (const i of [10, 11, 13, 14]) {
      const r = await call(`/api/rooms/${room.id}/mark`, { cardId: c.id, index: i }, p.token);
      assert.equal(r.status, 200);
    }
  }
  const r1 = await call(`/api/rooms/${room.id}/claim`, { cardId: cb.id }, b.token);
  const r2 = await call(`/api/rooms/${room.id}/claim`, { cardId: ca.id }, a.token);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);

  const pub = (await call(`/api/rooms/${room.id}`)).body;
  assert.equal(pub.winners.length, 2);
  const sameDraw = pub.winners[0].achievedAtDraw === pub.winners[1].achievedAtDraw;
  assert.equal(pub.winners[0].tie, sameDraw);
  assert.equal(pub.winners[0].prize, '一等');
  assert.equal(pub.winners[1].prize, '二等');
  assert.ok(!('playerId' in pub.winners[0]), '公開情報に内部IDを出さない');

  if (sameDraw) {
    const t = await call(`/api/rooms/${room.id}/host/tiebreak`, { achievedAtDraw: pub.winners[0].achievedAtDraw, method: 'lottery' }, hostToken);
    assert.equal(t.status, 200);
  }

  // 二重申請は重複扱い
  const dup = await call(`/api/rooms/${room.id}/claim`, { cardId: ca.id }, a.token);
  assert.equal(dup.body.duplicate, true);
  assert.equal(room.winners.length, 2);
});

test('自動抽選・一時停止・リセット', async () => {
  const { room, hostToken, join } = await setup({ cardsPerPlayer: 2 });
  const p = await join('Auto');
  assert.equal(room.players[p.playerId].cards.length, 2);
  await call(`/api/rooms/${room.id}/host/settings`, { autoDrawSec: 1 }, hostToken);
  await call(`/api/rooms/${room.id}/host/start`, {}, hostToken);
  room.lastDrawAt = 0;
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(room.draws.length >= 1);

  // 自動マス開け: 出た番号は開いている
  const card = room.players[p.playerId].cards[0];
  card.numbers.forEach((n, i) => {
    if (room.draws.includes(n)) assert.equal(card.marks[i], true);
  });

  await call(`/api/rooms/${room.id}/host/pause`, {}, hostToken);
  const count = room.draws.length;
  room.lastDrawAt = 0;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(room.draws.length, count, '一時停止中は抽選されない');
  assert.equal((await call(`/api/rooms/${room.id}/host/draw`, {}, hostToken)).status, 400);

  const oldCard = card.id;
  await call(`/api/rooms/${room.id}/host/reset`, {}, hostToken);
  assert.equal(room.status, 'waiting');
  assert.equal(room.draws.length, 0);
  assert.notEqual(room.players[p.playerId].cards[0].id, oldCard);
});

test('SSE で状態がリアルタイム配信され、再接続時は全状態を再送', async () => {
  const { room, hostToken, join } = await setup();
  const p = await join('Viewer');
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/rooms/${room.id}/events?token=${p.token}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value } = await reader.read();
      buf += dec.decode(value, { stream: true });
    }
  };
  const first = await next();
  assert.equal(first.event.kind, 'sync');
  assert.equal(first.me.name, 'Viewer');
  assert.equal(first.me.cards.length, 1);

  await call(`/api/rooms/${room.id}/host/start`, {}, hostToken);
  assert.equal((await next()).room.status, 'running');
  await call(`/api/rooms/${room.id}/host/draw`, {}, hostToken);
  const drawMsg = await next();
  assert.equal(drawMsg.event.kind, 'draw');
  assert.equal(drawMsg.room.draws.length, 1);
  ctrl.abort();
});

test('ホスト以外にカード情報や他人のトークンは漏れない', async () => {
  const { room } = await setup();
  const pub = (await call(`/api/rooms/${room.id}`)).body;
  const text = JSON.stringify(pub);
  assert.ok(!text.includes(room.hostToken));
  assert.ok(!('players' in pub));
});

test('短縮URL /r/CODE は参加画面へリダイレクト', async () => {
  const { room } = await setup();
  const res = await fetch(`${base}/r/${room.id.toLowerCase()}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/?room=${room.id}`);
});

test('QR コードを SVG で返し、長すぎる入力は拒否', async () => {
  const ok = await fetch(`${base}/api/qr.svg?text=${encodeURIComponent('https://example.com/r/ABCDE')}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await ok.text(), /^<svg[\s\S]*<\/svg>$/);
  const bad = await fetch(`${base}/api/qr.svg?text=${'a'.repeat(600)}`);
  assert.equal(bad.status, 400);
});

test('config は共有用URLの候補を返す', async () => {
  const { body } = await call('/api/config');
  assert.equal(typeof body.publicUrl, 'string');
  assert.ok(Array.isArray(body.lanUrls));
});

test('大人数向け: 他人の参加・マス開けは参加者に配信されない', async () => {
  const { room, hostToken, join } = await setup();
  const a = await join('A');
  await call(`/api/rooms/${room.id}/host/start`, {}, hostToken);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/rooms/${room.id}/events?token=${a.token}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let pending = null; // タイムアウトで取りこぼさないよう read() は使い回す
  const collect = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      pending ??= reader.read();
      const r = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok(null), until - Date.now()))]);
      if (!r) break;
      pending = null;
      if (r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
  };
  await collect(100);
  const before = text.split('data: ').length;
  for (let i = 0; i < 20; i++) await join(`guest${i}`);
  await collect(700);
  assert.equal(text.split('data: ').length, before, '他人の参加で配信が発生しない');
  await call(`/api/rooms/${room.id}/host/draw`, {}, hostToken);
  await collect(200);
  assert.equal(text.split('data: ').length, before + 1, '抽選は即時配信される');
  ctrl.abort();
});

test('PWA: マニフェスト（ルーム直行）・Service Worker・アイコン・ヘルスチェック', async () => {
  const m = await fetch(`${base}/manifest.webmanifest?room=abcde`);
  assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/?room=ABCDE');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
  const bad = await (await fetch(`${base}/manifest.webmanifest?room=${encodeURIComponent('<x>')}`)).json();
  assert.equal(bad.start_url, '/');

  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const icon = await fetch(`${base}/icons/icon-192.png`);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal((await call('/api/health')).body.ok, true);
});
