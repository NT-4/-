// 電波メッシュマップ: 計測・同期・メッシュ集計・描画
import {
  NETWORKS,
  CARRIERS,
  CARRIER_MAP,
  BANDS,
  MAX_ACCURACY_M,
  bandOf,
  scoreOf,
  cellOf,
  distanceM,
  median,
} from './signal-core.js';

const $ = (sel) => document.querySelector(sel);
const L = window.L;

// ---------- 永続化 ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // プライベートモード等では保存しない
    }
  },
};

const prefs = {
  carrier: 'docomo',
  net: 'docomo',
  mode: 'std',
  gen: '',
  view: 'single',
  group: 'brand',
  a: 'all',
  b: 'au',
  bestOff: [],
  cell: 'auto',
  period: 0,
  tod: 'all',
  minN: 1,
  metric: 's',
  share: true,
  radius: 300,
  origin: 'me',
  tab: 'measure',
  ...store.get('sig.prefs', {}),
};
const savePrefs = () => store.set('sig.prefs', prefs);

/** 自分の計測（synced=false はサーバー未送信） */
let mine = store.get('sig.mine', []);
const saveMine = () => store.set('sig.mine', mine.slice(-5000));
/** サーバーから取得した共有データ */
const shared = new Map();
/** デモ表示用の合成データ（保存・送信しない） */
let demo = null;

// ---------- 集計のための補助 ----------
const groupOf = (p) => (prefs.group === 'brand' ? p.c : p.n);
const groupName = (k) => (k === 'all' ? 'すべて' : prefs.group === 'brand' ? CARRIER_MAP[k]?.name : NETWORKS[k]?.name) ?? k;
const groupColor = (k) => (prefs.group === 'brand' ? CARRIER_MAP[k]?.color : NETWORKS[k]?.color) ?? '#888';
const groupKeys = () => (prefs.group === 'brand' ? CARRIERS.map((c) => c.id) : Object.keys(NETWORKS));
const myGroup = () => (prefs.group === 'brand' ? prefs.carrier : prefs.net);

const TOD = {
  all: () => true,
  morning: (h) => h >= 7 && h < 10,
  noon: (h) => h >= 11 && h < 14,
  evening: (h) => h >= 17 && h < 20,
  night: (h) => h >= 20 || h < 7,
  day: (h) => h >= 10 && h < 17,
};

function allPoints() {
  const byId = new Map(shared);
  for (const p of mine) byId.set(p.id, p);
  const list = [...byId.values()];
  if (demo) list.push(...demo);
  const since = prefs.period ? Date.now() - prefs.period * 86_400_000 : 0;
  const inTod = TOD[prefs.tod] ?? TOD.all;
  return list.filter((p) => p.t >= since && inTod(new Date(p.t).getHours()));
}

function cellSize() {
  if (prefs.cell !== 'auto') return Number(prefs.cell);
  const z = map.getZoom();
  return z >= 17 ? 25 : z >= 16 ? 50 : z >= 15 ? 100 : z >= 13 ? 250 : 500;
}

/** 計測群の要約 */
function summarize(pts) {
  return {
    n: pts.length,
    s: median(pts.map((p) => p.s)),
    d: median(pts.map((p) => p.d)),
    u: median(pts.map((p) => p.u)),
    r: median(pts.map((p) => p.r)),
    p: median(pts.map((p) => p.p)),
    fail: pts.filter((p) => p.ok === false).length / (pts.length || 1),
    last: Math.max(...pts.map((p) => p.t)),
  };
}

function byGroup(pts) {
  const m = new Map();
  for (const p of pts) {
    const k = groupOf(p);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  return m;
}

// ---------- 色と凡例 ----------
const C = BANDS.map((b) => b.color); // 良い → 悪い
const COUNT_COLORS = ['#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];

/** 指標ごとの段階（良い順）。値がこれ以上（r は以下）で該当 */
const METRICS = {
  s: { name: '総合スコア', unit: '', steps: [80, 60, 40, 20, 1], labels: BANDS.map((b) => b.label) },
  d: { name: '下り速度', unit: 'Mbps', steps: [50, 20, 5, 1, 0.01], labels: ['50Mbps〜', '20〜50', '5〜20', '1〜5', '〜1', '不通'] },
  u: { name: '上り速度', unit: 'Mbps', steps: [20, 8, 2, 0.5, 0.01], labels: ['20Mbps〜', '8〜20', '2〜8', '0.5〜2', '〜0.5', '不通'] },
  r: { name: '応答時間', unit: 'ms', steps: [60, 120, 250, 600, Infinity], lower: true, labels: ['〜60ms', '60〜120', '120〜250', '250〜600', '600ms〜', '不通'] },
  p: { name: 'RSRP', unit: 'dBm', steps: [-85, -95, -105, -115, -150], labels: ['-85dBm〜', '-95〜-85', '-105〜-95', '-115〜-105', '〜-115', '—'] },
  n: { name: '計測数', unit: '件' },
};

function colorFor(metric, sum) {
  if (metric === 'n') {
    const n = sum.n;
    return COUNT_COLORS[n >= 30 ? 4 : n >= 10 ? 3 : n >= 4 ? 2 : n >= 2 ? 1 : 0];
  }
  const v = sum[metric];
  if (v === null) return metric === 'p' ? null : sum.fail === 1 ? C[5] : null;
  if (metric === 's') return bandOf(v).color;
  const m = METRICS[metric];
  const i = m.steps.findIndex((t) => (m.lower ? v <= t : v >= t));
  return C[i === -1 ? 5 : i];
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function renderLegend() {
  const el = $('#legend');
  let rows = '';
  let head = '';
  if (prefs.view === 'single') {
    const m = METRICS[prefs.metric];
    head = `${m.name}${prefs.a !== 'all' ? `・${groupName(prefs.a)}` : ''}`;
    if (prefs.metric === 'n') {
      rows = ['1件', '2〜3', '4〜9', '10〜29', '30件〜'].map((l, i) => [COUNT_COLORS[i], l]).reverse();
    } else {
      rows = m.labels.map((l, i) => [C[i], l]);
      if (prefs.metric === 'p') rows.pop();
    }
  } else if (prefs.view === 'best') {
    head = '最も強いのは';
    rows = groupKeys().filter((k) => winners.has(k)).map((k) => [groupColor(k), groupName(k)]);
    if (!rows.length) rows = [['transparent', 'データなし']];
  } else {
    head = '総合スコアの差';
    const a = groupName(prefs.a);
    const b = groupName(prefs.b);
    rows = [
      [cssVar('--diff-a'), `${a} が大きく上`],
      [cssVar('--diff-a') + '88', `${a} がやや上`],
      [cssVar('--diff-0'), 'ほぼ同じ（±8）'],
      [cssVar('--diff-b') + '88', `${b} がやや上`],
      [cssVar('--diff-b'), `${b} が大きく上`],
    ];
  }
  el.innerHTML = `<h4>${head}</h4>${rows.map(([c, l]) => `<div class="row"><i style="background:${c}"></i>${l}</div>`).join('')}`;
}

// ---------- 地図 ----------
const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true }).setView(
  store.get('sig.view', [35.6812, 139.7671, 16]).slice(0, 2),
  store.get('sig.view', [0, 0, 16])[2],
);
const dark = matchMedia('(prefers-color-scheme: dark)');
let tiles = null;
function setTiles() {
  tiles?.remove();
  const style = dark.matches ? 'dark_all' : 'light_all';
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  }).addTo(map);
}
setTiles();
dark.addEventListener('change', () => {
  setTiles();
  render();
});

const renderer = L.canvas({ padding: 0.3 });
const cellLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);

let cells = new Map();
/** 最強表示で 1 位になったグループ（凡例用） */
const winners = new Set();

function render() {
  const pts = allPoints();
  const size = cellSize();
  cells = new Map();
  for (const p of pts) {
    const c = cellOf(p.lat, p.lng, size);
    if (!cells.has(c.key)) cells.set(c.key, { ...c, pts: [] });
    cells.get(c.key).pts.push(p);
  }
  cellLayer.clearLayers();
  winners.clear();
  const minN = Number(prefs.minN);
  const diffA = cssVar('--diff-a');
  const diffB = cssVar('--diff-b');
  const diff0 = cssVar('--diff-0');

  for (const cell of cells.values()) {
    let color = null;
    let opacity = 0.62;
    if (prefs.view === 'single') {
      const list = prefs.a === 'all' ? cell.pts : cell.pts.filter((p) => groupOf(p) === prefs.a);
      if (list.length < minN) continue;
      const sum = summarize(list);
      color = colorFor(prefs.metric, sum);
      // 計測が少ないメッシュは薄く（信頼度）
      opacity = Math.min(0.75, 0.35 + 0.1 * list.length);
    } else {
      const groups = byGroup(cell.pts);
      if (prefs.view === 'best') {
        const ranked = [...groups]
          .filter(([k, l]) => !prefs.bestOff.includes(k) && l.length >= minN)
          .map(([k, l]) => [k, median(l.map((p) => p.s))])
          .sort((x, y) => y[1] - x[1]);
        if (!ranked.length) continue;
        color = groupColor(ranked[0][0]);
        winners.add(ranked[0][0]);
        const margin = ranked.length > 1 ? ranked[0][1] - ranked[1][1] : 10;
        opacity = Math.min(0.8, 0.3 + margin / 40);
      } else {
        const a = groups.get(prefs.a);
        const b = groups.get(prefs.b);
        if (!a || !b || a.length < minN || b.length < minN) continue;
        const d = median(a.map((p) => p.s)) - median(b.map((p) => p.s));
        const strong = Math.abs(d) >= 25;
        color = Math.abs(d) < 8 ? diff0 : d > 0 ? diffA : diffB;
        opacity = Math.abs(d) < 8 ? 0.5 : strong ? 0.78 : 0.45;
      }
    }
    if (!color) continue;
    L.rectangle(
      [
        [cell.s, cell.w],
        [cell.n, cell.e],
      ],
      { renderer, stroke: true, weight: 0.5, color, opacity: 0.9, fillColor: color, fillOpacity: opacity },
    )
      .on('click', (e) => openCellPopup(cell, e.latlng))
      .addTo(cellLayer);
  }
  renderLegend();
  renderRank();
  renderSyncInfo();
}

function fmt(v, digits = 0) {
  if (v === null || v === undefined) return '—';
  return v >= 100 ? Math.round(v).toString() : v.toFixed(digits);
}

function openCellPopup(cell, latlng) {
  const rows = [...byGroup(cell.pts)]
    .map(([k, l]) => [k, summarize(l)])
    .sort((x, y) => (y[1].s ?? -1) - (x[1].s ?? -1))
    .map(
      ([k, s]) =>
        `<tr><td><i style="background:${groupColor(k)}"></i>${groupName(k)}</td><td class="r"><b>${fmt(s.s)}</b></td><td class="r">${fmt(s.d, 1)}</td><td class="r">${fmt(s.r)}</td><td class="r">${s.n}</td></tr>`,
    )
    .join('');
  const last = new Date(Math.max(...cell.pts.map((p) => p.t))).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  L.popup({ maxWidth: 320 })
    .setLatLng(latlng)
    .setContent(
      `<div class="pop"><h5>${cellSize()}m メッシュ・${cell.pts.length}件（最終 ${last}）</h5><table><tr style="color:var(--muted);font-size:11px"><td></td><td class="r">スコア</td><td class="r">下りMbps</td><td class="r">応答ms</td><td class="r">件</td></tr>${rows}</table></div>`,
    )
    .openOn(map);
}

/** パネルに隠れていない地図領域の中心へのずれ（px） */
function sheetOffset() {
  const r = $('#sheet').getBoundingClientRect();
  if (innerWidth >= 900) return L.point(-(r.right) / 2, 0);
  return L.point(0, Math.max(0, innerHeight - r.top) / 2);
}

function focusOn(latlng, zoom = map.getZoom()) {
  const center = map.unproject(map.project(latlng, zoom).add(sheetOffset()), zoom);
  map.setView(center, zoom);
}

function visibleCenter() {
  const z = map.getZoom();
  return map.unproject(map.project(map.getCenter(), z).subtract(sheetOffset()), z);
}

// ---------- 現在地 ----------
let me = null;
let meMarker = null;
let meAccuracy = null;
let radiusCircle = null;
let firstFix = true;

function updateMe(pos) {
  me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
  const ll = [me.lat, me.lng];
  if (!meMarker) {
    meAccuracy = L.circle(ll, { radius: me.acc, color: cssVar('--accent'), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), interactive: false }).addTo(meLayer);
  } else {
    meMarker.setLatLng(ll);
    meAccuracy.setLatLng(ll).setRadius(me.acc);
  }
  if (firstFix) {
    firstFix = false;
    focusOn(ll, Math.max(map.getZoom(), 16));
  }
  throttledRank();
}

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(updateMe, (err) => {
    if (err.code === err.PERMISSION_DENIED) setStatus('位置情報が許可されていません。ブラウザの設定で許可してください。', true);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
} else {
  setStatus('この端末は位置情報に対応していません。', true);
}

$('#locate').addEventListener('click', () => {
  if (me) focusOn([me.lat, me.lng], Math.max(map.getZoom(), 16));
  else setStatus('現在地を取得中です…');
});

function getFix() {
  if (me && Date.now() - me.t < 15_000 && me.acc <= 60) return Promise.resolve(me);
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updateMe(pos);
        resolve(me);
      },
      () => reject(new Error('位置を取得できませんでした')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5000 },
    );
  });
}

// ---------- 計測 ----------
const MODES = {
  light: { pings: 4, down: 300_000, up: 0, mb: 0.3, hint: '約0.3MB/回。応答時間と小さめのダウンロードのみ。連続計測向き' },
  std: { pings: 6, down: 3_000_000, up: 500_000, mb: 3.5, hint: '約3.5MB/回。下り・上り・応答をバランスよく計測' },
  full: { pings: 8, down: 15_000_000, up: 3_000_000, mb: 18, hint: '約18MB/回。高速回線（5G等）の実力を測るとき向け' },
};

const usage = store.get('sig.usage', { day: '', bytes: 0 });
function addUsage(bytes) {
  const day = new Date().toDateString();
  if (usage.day !== day) Object.assign(usage, { day, bytes: 0 });
  usage.bytes += bytes;
  store.set('sig.usage', usage);
}

async function timed(url, opts = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const bust = () => `_=${Math.random().toString(36).slice(2)}`;

async function measurePing(n) {
  const samples = [];
  // 1 回目は接続確立を含むので捨てる
  for (let i = 0; i <= n; i++) {
    const t0 = performance.now();
    try {
      const res = await timed(`/api/signal/ping?${bust()}`, {}, 6000);
      if (!res.ok) continue;
      if (i > 0) samples.push(performance.now() - t0);
    } catch {
      // タイムアウト・不通
    }
  }
  return { rtt: median(samples), okCount: samples.length };
}

/** 本文を読み終えるまでの転送レート（最初のチャンク到着からの経過で計算） */
async function downloadOnce(bytes) {
  const t0 = performance.now();
  const res = await timed(`/api/signal/down?bytes=${bytes}&${bust()}`, {}, 25_000);
  if (!res.ok) throw new Error('download failed');
  const reader = res.body.getReader();
  let got = 0;
  let first = null;
  let afterFirst = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first === null) first = performance.now();
    else afterFirst += value.length;
    got += value.length;
  }
  const end = performance.now();
  addUsage(got);
  const span = end - (first ?? t0);
  // 小さすぎて 1 チャンクで届いた場合は全体時間で計算
  const mbps = span > 30 && afterFirst > 0 ? (afterFirst * 8) / (span * 1000) : (got * 8) / ((end - t0) * 1000);
  return { mbps, got, ms: end - t0 };
}

async function measureDown(budget) {
  const probe = await downloadOnce(Math.min(64_000, budget));
  let left = budget - probe.got;
  if (left < 32_000) return probe.mbps;
  // 約 2.5 秒で終わるサイズに合わせる
  const target = Math.min(left, Math.max(128_000, (probe.mbps * 1e6 * 2.5) / 8));
  const main = await downloadOnce(Math.round(target));
  return main.mbps;
}

async function measureUp(bytes, rtt) {
  const body = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65_536) crypto.getRandomValues(body.subarray(i, Math.min(bytes, i + 65_536)));
  const t0 = performance.now();
  const res = await timed(`/api/signal/up?${bust()}`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } }, 25_000);
  if (!res.ok) throw new Error('upload failed');
  await res.json();
  addUsage(bytes);
  const ms = Math.max(5, performance.now() - t0 - (rtt ?? 0));
  return (bytes * 8) / (ms * 1000);
}

const newId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let busy = false;
let lastMeasured = null;

function setStatus(text, warn = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

async function measure({ auto = false } = {}) {
  if (busy) return;
  const conn = navigator.connection;
  if (conn && (conn.type === 'wifi' || conn.type === 'ethernet')) {
    setStatus('Wi-Fi に接続中です。Wi-Fi をオフにしてモバイル回線で計測してください。', true);
    return;
  }
  busy = true;
  $('#measureBtn').disabled = true;
  try {
    setStatus('位置を取得中…');
    const fix = await getFix();
    if (fix.acc > MAX_ACCURACY_M) throw new Error(`位置の精度が低いため保存しません（±${Math.round(fix.acc)}m）。屋外や窓際で再度お試しください`);
    const mode = MODES[prefs.mode];
    const point = {
      id: newId(),
      t: Date.now(),
      lat: fix.lat,
      lng: fix.lng,
      acc: Math.round(fix.acc),
      c: prefs.carrier,
      n: prefs.net,
      g: prefs.gen || null,
      ok: true,
      d: null,
      u: null,
      r: null,
      p: $('#rsrp').value === '' ? null : Number($('#rsrp').value),
    };
    setStatus('応答時間を計測中…');
    const ping = navigator.onLine ? await measurePing(mode.pings) : { rtt: null, okCount: 0 };
    if (!ping.okCount) {
      point.ok = false;
      point.d = 0;
    } else {
      point.r = Math.round(ping.rtt);
      try {
        setStatus('下り速度を計測中…');
        point.d = Math.round((await measureDown(mode.down)) * 100) / 100;
        if (mode.up) {
          setStatus('上り速度を計測中…');
          point.u = Math.round((await measureUp(mode.up, ping.rtt)) * 100) / 100;
        }
      } catch {
        // 応答はあるが転送できない＝極端に弱い
        point.d ??= 0;
      }
    }
    point.s = scoreOf({ ok: point.ok, down: point.d ?? undefined, up: point.u ?? undefined, rtt: point.r ?? undefined, rsrp: point.p ?? undefined });
    point.synced = false;
    mine.push(point);
    saveMine();
    lastMeasured = point;
    showResult(point);
    setStatus(
      point.ok
        ? `${auto ? '自動計測' : '計測'}しました（位置 ±${point.acc}m・本日の通信量 ${(usage.bytes / 1e6).toFixed(1)}MB）`
        : '通信できませんでした。「不通」として記録し、電波が戻ったら送信します。',
      !point.ok,
    );
    render();
    sync();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    busy = false;
    $('#measureBtn').disabled = false;
  }
}

function showResult(p) {
  const el = $('#result');
  el.hidden = false;
  const band = bandOf(p.s);
  el.innerHTML = `
    <div style="box-shadow:inset 4px 0 0 ${band.color}"><b>${p.s}</b><span>${band.label}</span></div>
    <div><b>${fmt(p.d, 1)}</b><span>下り Mbps</span></div>
    <div><b>${fmt(p.u, 1)}</b><span>上り Mbps</span></div>
    <div><b>${fmt(p.r)}</b><span>応答 ms</span></div>`;
}

$('#measureBtn').addEventListener('click', () => measure());

// 連続計測：移動距離 or 90 秒ごと
let autoTimer = null;
let wakeLock = null;
async function setAuto(on) {
  clearInterval(autoTimer);
  autoTimer = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $('#autoBtn').classList.toggle('on', on);
  $('#autoBtn').setAttribute('aria-pressed', String(on));
  $('#autoBtn').textContent = on ? '連続計測中' : '連続計測';
  if (!on) return;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // 非対応端末は画面消灯で止まる
  }
  const est = Math.round(MODES[prefs.mode].mb * 40);
  setStatus(`連続計測を開始しました（最大 約${est}MB/時間）。画面を点けたままにしてください。`);
  const tick = () => {
    if (busy || !me) return;
    const moved = lastMeasured ? distanceM(lastMeasured.lat, lastMeasured.lng, me.lat, me.lng) : Infinity;
    const elapsed = lastMeasured ? Date.now() - lastMeasured.t : Infinity;
    if (moved >= Math.max(25, cellSize() * 0.6) || elapsed >= 90_000) measure({ auto: true });
  };
  autoTimer = setInterval(tick, 3000);
  tick();
}
$('#autoBtn').addEventListener('click', () => setAuto(!autoTimer));
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && autoTimer && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      // 無視
    }
  }
  if (document.visibilityState === 'hidden') wakeLock = null;
});

// ---------- 同期 ----------
let syncing = false;
async function sync() {
  if (!prefs.share || syncing || !navigator.onLine) return renderSyncInfo();
  const pending = mine.filter((p) => !p.synced);
  if (!pending.length) return renderSyncInfo();
  syncing = true;
  try {
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const res = await timed('/api/signal/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: batch.map(({ synced, ...p }) => p) }),
      });
      if (!res.ok) break;
      const { rejected } = await res.json();
      const bad = new Set(rejected.map((r) => r.id));
      for (const p of batch) {
        p.synced = true;
        if (bad.has(p.id)) p.rejected = true;
      }
    }
    saveMine();
  } catch {
    // オフライン：次の機会に再送
  } finally {
    syncing = false;
    renderSyncInfo();
  }
}
addEventListener('online', sync);
setInterval(sync, 60_000);

function renderSyncInfo() {
  const pending = mine.filter((p) => !p.synced).length;
  const text = prefs.share
    ? `自分の計測 ${mine.length} 件（未送信 ${pending} 件）・地図上の共有データ ${shared.size} 件`
    : `端末内のみに保存中：自分の計測 ${mine.length} 件。共有データの閲覧はできます。`;
  $('#syncInfo').textContent = text;
}

// ---------- 共有データの取得 ----------
let fetchTimer = null;
function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(fetchShared, 350);
}

async function fetchShared() {
  const b = map.getBounds().pad(0.4);
  const s = b.getSouth();
  const n = b.getNorth();
  const w = b.getWest();
  const e = b.getEast();
  if (n - s > 1 || e - w > 1) {
    showBanner('広域表示中：拡大するとみんなの計測を表示します');
    return;
  }
  showBanner(null);
  const since = prefs.period ? Date.now() - prefs.period * 86_400_000 : 0;
  try {
    const res = await timed(`/api/signal/points?bbox=${[s, w, n, e].map((v) => v.toFixed(5)).join(',')}&since=${since}`);
    if (!res.ok) return;
    const data = await res.json();
    if (shared.size > 60_000) shared.clear();
    for (const p of data.points) shared.set(p.id, p);
    render();
  } catch {
    // オフライン時は手元のデータだけで描画
  }
}

let bannerText = null;
function showBanner(text) {
  bannerText = text;
  const el = $('#banner');
  const t = demo ? `デモ表示中：合成データです${text ? `／${text}` : ''}` : text;
  el.hidden = !t;
  el.textContent = t ?? '';
}

map.on('moveend', () => {
  const c = map.getCenter();
  store.set('sig.view', [c.lat, c.lng, map.getZoom()]);
  scheduleFetch();
  if (prefs.cell === 'auto') render();
  else throttledRank();
});

// ---------- 周辺比較 ----------
function rankOrigin() {
  if (prefs.origin === 'me' && me) return { lat: me.lat, lng: me.lng, label: '現在地' };
  const c = visibleCenter();
  return { lat: c.lat, lng: c.lng, label: prefs.origin === 'me' ? '地図の中心（現在地を取得中）' : '地図の中心' };
}

function renderRank() {
  const o = rankOrigin();
  const near = allPoints().filter((p) => distanceM(o.lat, o.lng, p.lat, p.lng) <= prefs.radius);
  const rows = [...byGroup(near)].map(([k, l]) => [k, summarize(l)]).sort((x, y) => (y[1].s ?? -1) - (x[1].s ?? -1));
  const r = prefs.radius >= 1000 ? `${prefs.radius / 1000}km` : `${prefs.radius}m`;
  $('#rankHint').textContent = `${o.label}から ${r} 以内・${near.length} 件の計測を${prefs.group === 'brand' ? 'ブランド' : '回線'}別に集計（中央値）`;
  if (!rows.length) {
    $('#rank').innerHTML = '<li class="empty" style="display:block">この範囲にはまだ計測がありません。<br>計測するか、「データ › デモ表示」で見え方を確認できます。</li>';
  } else {
    const mineKey = myGroup();
    $('#rank').innerHTML = rows
      .map(([k, s], i) => {
        const band = bandOf(s.s ?? 0);
        const thin = s.n < 3 ? '・データ少' : '';
        return `<li>
          <span class="name"><i style="background:${groupColor(k)}"></i>${i + 1}. ${groupName(k)}${k === mineKey ? '<em>あなた</em>' : ''}</span>
          <span class="sc">${fmt(s.s)}<small style="color:var(--muted);font-weight:500"> ${band.label}</small></span>
          <span class="bar"><i style="width:${s.s ?? 0}%;background:${band.color}"></i></span>
          <span class="meta">下り ${fmt(s.d, 1)}Mbps・応答 ${fmt(s.r)}ms・不通率 ${Math.round(s.fail * 100)}%・${s.n}件${thin}</span>
        </li>`;
      })
      .join('');
  }
  if (radiusCircle) radiusCircle.remove();
  radiusCircle = null;
  if (prefs.tab === 'compare') {
    radiusCircle = L.circle([o.lat, o.lng], { radius: prefs.radius, color: cssVar('--accent'), weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(meLayer);
  }
}

let rankTimer = null;
function throttledRank() {
  if (rankTimer) return;
  rankTimer = setTimeout(() => {
    rankTimer = null;
    renderRank();
  }, 500);
}

// ---------- デモデータ ----------
function makeDemo(center) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const m = 1 / 111_320;
  const towers = {};
  const count = { docomo: 7, au: 7, softbank: 6, rakuten: 4 };
  for (const net of Object.keys(NETWORKS)) {
    towers[net] = Array.from({ length: count[net] }, () => ({
      lat: center.lat + (rnd() - 0.5) * 2400 * m,
      lng: center.lng + ((rnd() - 0.5) * 2400 * m) / Math.cos((center.lat * Math.PI) / 180),
      power: 0.75 + rnd() * 0.45,
      reach: net === 'rakuten' ? 420 : 650,
    }));
  }
  const quality = (net, lat, lng) => {
    let q = 0;
    for (const t of towers[net]) q = Math.max(q, t.power * Math.exp(-distanceM(lat, lng, t.lat, t.lng) / t.reach));
    return Math.min(1, q);
  };
  // 大手は多めに、格安SIMは少なめに出現させる
  const brands = CARRIERS.filter((c) => c.id !== 'other').flatMap((c) => Array(c.kind === 'MNO' ? 4 : c.kind === 'MVNO' ? 1 : 2).fill(c));
  const out = [];
  const step = 30;
  const R = 1000;
  for (let y = -R; y <= R; y += step) {
    for (let x = -R; x <= R; x += step) {
      if (x * x + y * y > R * R || rnd() < 0.25) continue;
      const lat = center.lat + (y + (rnd() - 0.5) * step) * m;
      const lng = center.lng + ((x + (rnd() - 0.5) * step) * m) / Math.cos((center.lat * Math.PI) / 180);
      for (let k = 0; k < 8; k++) {
        const c = brands[Math.floor(rnd() * brands.length)];
        const net = c.nets[Math.floor(rnd() * c.nets.length)];
        const t = Date.now() - Math.floor(rnd() * 14 * 86_400_000);
        const hour = new Date(t).getHours();
        let q = quality(net, lat, lng) * (0.8 + rnd() * 0.3);
        // 格安SIMは昼休みに混雑する
        if (c.kind === 'MVNO' && hour >= 12 && hour < 13) q *= 0.45;
        if (c.kind === 'サブブランド') q *= 0.95;
        const ok = q > 0.06 || rnd() > 0.5;
        const p = {
          id: `demo${out.length}`,
          demo: true,
          t,
          lat,
          lng,
          acc: 10,
          c: c.id,
          n: net,
          g: null,
          ok,
          d: ok ? Math.round(0.3 * 300 ** q * 100) / 100 : 0,
          u: ok ? Math.round(0.2 * 250 ** (q * 0.85) * 100) / 100 : null,
          r: ok ? Math.round(50 * 16 ** (1 - q)) : null,
          p: null,
        };
        p.s = scoreOf({ ok, down: p.d, up: p.u ?? undefined, rtt: p.r ?? undefined });
        out.push(p);
      }
    }
  }
  return out;
}

$('#demoBtn').addEventListener('click', () => {
  demo = demo ? null : makeDemo(me ?? map.getCenter());
  $('#demoBtn').setAttribute('aria-pressed', String(Boolean(demo)));
  $('#demoBtn').textContent = demo ? 'デモを消す' : 'デモ表示';
  showBanner(bannerText);
  render();
});

// ---------- 書き出し・読み込み ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
$('#exportJson').addEventListener('click', () => download(`signal-${stamp()}.json`, JSON.stringify(mine, null, 1), 'application/json'));
$('#exportCsv').addEventListener('click', () => {
  const head = 'time,lat,lng,accuracy_m,carrier,network,generation,ok,score,down_mbps,up_mbps,rtt_ms,rsrp_dbm';
  const rows = mine.map((p) =>
    [new Date(p.t).toISOString(), p.lat, p.lng, p.acc, CARRIER_MAP[p.c]?.name ?? p.c, p.n, p.g ?? '', p.ok, p.s, p.d ?? '', p.u ?? '', p.r ?? '', p.p ?? ''].join(','),
  );
  download(`signal-${stamp()}.csv`, '﻿' + [head, ...rows].join('\n'), 'text/csv');
});
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const list = JSON.parse(await file.text());
    if (!Array.isArray(list)) throw new Error();
    const have = new Set(mine.map((p) => p.id));
    const add = list.filter((p) => p && typeof p.id === 'string' && !have.has(p.id) && CARRIER_MAP[p.c] && Number.isFinite(p.lat));
    for (const p of add) mine.push({ ...p, synced: false, s: scoreOf({ ok: p.ok, down: p.d ?? undefined, up: p.u ?? undefined, rtt: p.r ?? undefined, rsrp: p.p ?? undefined }) });
    saveMine();
    setStatus(`${add.length} 件を読み込みました`);
    render();
    sync();
  } catch {
    setStatus('読み込めないファイルです（このアプリで書き出した JSON を選んでください）', true);
  }
  e.target.value = '';
});
$('#clearMine').addEventListener('click', () => {
  if (!confirm('この端末に保存した自分の計測を削除します。送信済みの共有データは残ります。よろしいですか？')) return;
  mine = mine.filter((p) => !p.synced);
  if (mine.length && confirm(`未送信の ${mine.length} 件も削除しますか？`)) mine = [];
  saveMine();
  render();
});
$('#syncBtn').addEventListener('click', async () => {
  await sync();
  scheduleFetch();
});

// ---------- UI の組み立て ----------
function carrierOptions(selectEl, value, withAll) {
  const kinds = ['MNO', 'サブブランド', 'MVNO'];
  const label = { MNO: '大手キャリア', サブブランド: 'サブブランド・オンライン専用', MVNO: '格安SIM（MVNO）' };
  selectEl.innerHTML =
    (withAll ? '<option value="all">すべて</option>' : '') +
    kinds.map((k) => `<optgroup label="${label[k]}">${CARRIERS.filter((c) => c.kind === k).map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</optgroup>`).join('');
  selectEl.value = value;
}

function netOptions(selectEl, value, nets, withAll) {
  selectEl.innerHTML = (withAll ? '<option value="all">すべて</option>' : '') + nets.map((n) => `<option value="${n}">${NETWORKS[n].name}</option>`).join('');
  selectEl.value = value;
}

function refreshMine() {
  carrierOptions($('#myCarrier'), prefs.carrier, false);
  const nets = CARRIER_MAP[prefs.carrier].nets;
  if (!nets.includes(prefs.net)) prefs.net = nets[0];
  netOptions($('#myNet'), prefs.net, nets, false);
  $('#myNetField').hidden = nets.length === 1;
  $('#gen').value = prefs.gen;
}

function refreshView() {
  const keys = groupKeys();
  if (prefs.a !== 'all' && !keys.includes(prefs.a)) prefs.a = myGroup();
  if (!keys.includes(prefs.b) || prefs.b === prefs.a) prefs.b = keys.find((k) => k !== prefs.a && k !== 'all') ?? keys[0];
  if (prefs.view === 'diff' && prefs.a === 'all') prefs.a = myGroup();
  const fill = (el, v, withAll) => (prefs.group === 'brand' ? carrierOptions(el, v, withAll) : netOptions(el, v, keys, withAll));
  fill($('#selA'), prefs.a, prefs.view === 'single');
  fill($('#selB'), prefs.b, false);
  $('#aField').hidden = prefs.view === 'best';
  $('#bField').hidden = prefs.view !== 'diff';
  $('#aField label').textContent = prefs.view === 'diff' ? '基準' : '対象';
  $('#bestChipsWrap').hidden = prefs.view !== 'best';
  $('#bestChips').innerHTML = keys
    .map((k) => `<button data-k="${k}" aria-pressed="${!prefs.bestOff.includes(k)}"><span style="color:${groupColor(k)}">●</span> ${groupName(k)}</button>`)
    .join('');
  $('#metric').disabled = prefs.view !== 'single';
  $('#viewHint').textContent = {
    single: '選んだ1社（またはすべて）の実測値をメッシュで塗り分けます。指標は右上で切替',
    best: 'メッシュごとに総合スコアが最も高い回線の色で塗ります。濃いほど2位との差が大きい',
    diff: '2社の総合スコアの差を塗り分けます。乗り換え検討や、自宅・職場周辺の比較に',
  }[prefs.view];
  $('#cellSize').value = prefs.cell;
  $('#period').value = String(prefs.period);
  $('#tod').value = prefs.tod;
  $('#minN').value = String(prefs.minN);
  $('#metric').value = prefs.metric;
}

function bindSeg(id, key, cast = String, after = () => {}) {
  const seg = $(id);
  const sync = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(cast(b.dataset.v) === prefs[key])));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs[key] = cast(b.dataset.v);
    savePrefs();
    sync();
    after();
  });
  sync();
  return sync;
}

function changed() {
  savePrefs();
  refreshView();
  render();
}

bindSeg('#modeSeg', 'mode', String, () => ($('#modeHint').textContent = MODES[prefs.mode].hint));
$('#modeHint').textContent = MODES[prefs.mode].hint;
bindSeg('#radiusSeg', 'radius', Number, renderRank);
bindSeg('#originSeg', 'origin', String, renderRank);
bindSeg('#viewSeg', 'view', String, () => {
  // 同じ網のブランドは基地局も同じなので、最強表示は回線単位の方が読みやすい
  if (prefs.view === 'best' && prefs.group === 'brand') {
    prefs.group = 'net';
    prefs.bestOff = [];
    groupSegSync();
  }
  changed();
});
const groupSegSync = bindSeg('#groupSeg', 'group', String, () => {
  prefs.bestOff = [];
  prefs.a = prefs.view === 'single' ? 'all' : myGroup();
  changed();
});
bindSeg('#shareSeg', 'share', (v) => v === 'on', () => {
  renderSyncInfo();
  sync();
});

$('#myCarrier').addEventListener('change', (e) => {
  prefs.carrier = e.target.value;
  refreshMine();
  savePrefs();
  renderRank();
});
$('#myNet').addEventListener('change', (e) => {
  prefs.net = e.target.value;
  savePrefs();
  renderRank();
});
$('#gen').addEventListener('change', (e) => {
  prefs.gen = e.target.value;
  savePrefs();
});
$('#selA').addEventListener('change', (e) => {
  prefs.a = e.target.value;
  changed();
});
$('#selB').addEventListener('change', (e) => {
  prefs.b = e.target.value;
  changed();
});
$('#bestChips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const k = b.dataset.k;
  prefs.bestOff = prefs.bestOff.includes(k) ? prefs.bestOff.filter((x) => x !== k) : [...prefs.bestOff, k];
  changed();
});
for (const [id, key, cast] of [
  ['#cellSize', 'cell', String],
  ['#tod', 'tod', String],
  ['#minN', 'minN', Number],
  ['#metric', 'metric', String],
]) {
  $(id).addEventListener('change', (e) => {
    prefs[key] = cast(e.target.value);
    changed();
  });
}
$('#period').addEventListener('change', (e) => {
  prefs.period = Number(e.target.value);
  changed();
  scheduleFetch();
});

// タブ・シート
function selectTab(tab) {
  prefs.tab = tab;
  savePrefs();
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  $('#sheet').classList.remove('collapsed');
  renderRank();
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) selectTab(b.dataset.tab);
});
$('#handle').addEventListener('click', () => $('#sheet').classList.toggle('collapsed'));

if (!navigator.connection) {
  setStatus('この端末は接続種別を判定できません。Wi-Fi をオフにしてから計測してください。');
}

refreshMine();
refreshView();
selectTab(prefs.tab);
render();
fetchShared();
sync();
