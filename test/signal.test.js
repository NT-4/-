import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { SignalStore } from '../src/signal.js';
import { scoreOf, cellOf, normalizePoint, distanceM, bandOf } from '../public/js/signal-core.js';

const point = (over = {}) => ({
  id: `p${Math.random().toString(36).slice(2, 12)}`,
  t: Date.now(),
  lat: 35.681234,
  lng: 139.767125,
  acc: 12,
  c: 'iijmio',
  n: 'au',
  d: 25,
  u: 8,
  r: 70,
  ...over,
});

test('スコアは速いほど高く、不通は 0、通信できれば最低 1', () => {
  const fast = scoreOf({ down: 120, up: 40, rtt: 45 });
  const mid = scoreOf({ down: 8, up: 2, rtt: 140 });
  const slow = scoreOf({ down: 0.2, up: 0.1, rtt: 3000 });
  assert.ok(fast > mid && mid > slow);
  assert.ok(fast >= 95);
  assert.equal(scoreOf({ ok: false, down: 100 }), 0);
  assert.equal(slow, 1);
  assert.equal(bandOf(0).label, '不通・圏外');
});

test('メッシュは同じ区画の点を同じキーにまとめ、一辺がほぼ指定サイズになる', () => {
  const a = cellOf(35.68, 139.76, 50);
  const midLat = (a.s + a.n) / 2;
  const midLng = (a.w + a.e) / 2;
  assert.equal(cellOf(midLat + 0.0001, midLng + 0.0001, 50).key, a.key);
  assert.equal(cellOf(midLat - 0.0001, midLng - 0.0001, 50).key, a.key);
  assert.ok(Math.abs(distanceM(a.s, a.w, a.n, a.w) - 50) < 0.5);
  assert.ok(Math.abs(distanceM(a.s, a.w, a.s, a.e) - 50) < 0.5);
  assert.notEqual(cellOf(35.68, 139.76, 50).key, cellOf(35.6806, 139.76, 50).key);
});

test('計測値の検証: 位置を丸め、回線の組み合わせ・精度・時刻をチェックし、スコアはサーバーで再計算', () => {
  const p = normalizePoint(point({ s: 100 }));
  assert.equal(p.lat, 35.6812);
  assert.equal(p.lng, 139.7671);
  assert.equal(p.s, scoreOf({ down: 25, up: 8, rtt: 70 }));
  assert.throws(() => normalizePoint(point({ c: 'docomo', n: 'au' })));
  assert.throws(() => normalizePoint(point({ c: 'nope' })));
  assert.throws(() => normalizePoint(point({ acc: 500 })));
  assert.throws(() => normalizePoint(point({ t: Date.now() + 3_600_000 })));
  assert.throws(() => normalizePoint(point({ d: null, u: null, r: null })));
  const fail = normalizePoint(point({ ok: false, d: 50 }));
  assert.equal(fail.s, 0);
  assert.equal(fail.d, 0);
});

test('ストア: 重複 ID を無視し、上限超過で古い順に削除し、ファイルから復元できる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-'));
  try {
    const file = join(dir, 'signal.json');
    const s = new SignalStore({ file, maxPoints: 3 });
    const pts = [1, 2, 3, 4].map((i) => point({ id: `point000${i}`, t: Date.now() - (10 - i) * 1000 }));
    assert.equal(s.add(pts.slice(0, 2)).added, 2);
    assert.equal(s.add(pts.slice(0, 2)).added, 0);
    const res = s.add([...pts.slice(2), point({ c: 'docomo', n: 'au' })]);
    assert.equal(res.added, 2);
    assert.equal(res.rejected.length, 1);
    assert.deepEqual(s.points.map((p) => p.id), ['point0002', 'point0003', 'point0004']);
    s.saveNow();
    const again = new SignalStore({ file });
    assert.equal(again.points.length, 3);
    assert.equal(again.add([pts[3]]).added, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('API: 計測用の ping / down / up', async () => {
  assert.equal((await fetch(`${base}/api/signal/ping`)).status, 204);
  const down = await fetch(`${base}/api/signal/down?bytes=200000`);
  assert.equal((await down.arrayBuffer()).byteLength, 200_000);
  const up = await fetch(`${base}/api/signal/up`, { method: 'POST', body: new Uint8Array(123_456) });
  assert.deepEqual(await up.json(), { bytes: 123_456 });
});

test('API: 投稿した計測を範囲検索で取得でき、範囲外・広すぎる範囲は返さない', async () => {
  const post = await fetch(`${base}/api/signal/points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [point({ id: 'apitest001' }), point({ id: 'apitest002', lat: 34.7, lng: 135.5, c: 'rakuten', n: 'rakuten' })] }),
  });
  assert.deepEqual(await post.json(), { added: 2, rejected: [] });
  const get = async (bbox) => (await fetch(`${base}/api/signal/points?bbox=${bbox}`)).json();
  const tokyo = await get('35.6,139.7,35.7,139.8');
  assert.deepEqual(tokyo.points.map((p) => p.id), ['apitest001']);
  assert.equal(tokyo.points[0].c, 'iijmio');
  const wide = await fetch(`${base}/api/signal/points?bbox=30,130,40,140`);
  assert.equal(wide.status, 400);
  assert.equal((await fetch(`${base}/signal`)).status, 200);
});
