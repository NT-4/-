// 電波マップの共通ロジック（ブラウザとサーバーの両方から import する）

/** 物理的な回線（網）。MVNO・サブブランドはこのどれかに乗っている */
export const NETWORKS = {
  docomo: { name: 'ドコモ回線', short: 'D', color: '#e4004f' },
  au: { name: 'au回線', short: 'A', color: '#f08300' },
  softbank: { name: 'ソフトバンク回線', short: 'S', color: '#1d8fd6' },
  rakuten: { name: '楽天回線', short: 'R', color: '#a3178f' },
};

/** ブランド一覧。nets は契約時に選べる回線 */
export const CARRIERS = [
  { id: 'docomo', name: 'docomo', kind: 'MNO', nets: ['docomo'], color: '#e4004f' },
  { id: 'ahamo', name: 'ahamo', kind: 'サブブランド', nets: ['docomo'], color: '#ff4f8b' },
  { id: 'irumo', name: 'irumo', kind: 'サブブランド', nets: ['docomo'], color: '#c2185b' },
  { id: 'au', name: 'au', kind: 'MNO', nets: ['au'], color: '#f08300' },
  { id: 'uq', name: 'UQ mobile', kind: 'サブブランド', nets: ['au'], color: '#e6b800' },
  { id: 'povo', name: 'povo', kind: 'サブブランド', nets: ['au'], color: '#ffb74d' },
  { id: 'softbank', name: 'SoftBank', kind: 'MNO', nets: ['softbank'], color: '#1d8fd6' },
  { id: 'ymobile', name: 'Y!mobile', kind: 'サブブランド', nets: ['softbank'], color: '#00b8d4' },
  { id: 'linemo', name: 'LINEMO', kind: 'サブブランド', nets: ['softbank'], color: '#2fbf71' },
  { id: 'rakuten', name: '楽天モバイル', kind: 'MNO', nets: ['rakuten'], color: '#a3178f' },
  { id: 'iijmio', name: 'IIJmio', kind: 'MVNO', nets: ['docomo', 'au'], color: '#5c6bc0' },
  { id: 'mineo', name: 'mineo', kind: 'MVNO', nets: ['docomo', 'au', 'softbank'], color: '#43a047' },
  { id: 'nihontsushin', name: '日本通信SIM', kind: 'MVNO', nets: ['docomo'], color: '#6d4c41' },
  { id: 'biglobe', name: 'BIGLOBEモバイル', kind: 'MVNO', nets: ['docomo', 'au'], color: '#3949ab' },
  { id: 'aeon', name: 'イオンモバイル', kind: 'MVNO', nets: ['docomo', 'au'], color: '#8e24aa' },
  { id: 'nuro', name: 'NUROモバイル', kind: 'MVNO', nets: ['docomo', 'au', 'softbank'], color: '#546e7a' },
  { id: 'his', name: 'HISモバイル', kind: 'MVNO', nets: ['docomo', 'softbank'], color: '#00897b' },
  { id: 'jcom', name: 'J:COM MOBILE', kind: 'MVNO', nets: ['au'], color: '#d84315' },
  { id: 'libmo', name: 'LIBMO', kind: 'MVNO', nets: ['docomo'], color: '#7cb342' },
  { id: 'linksmate', name: 'LinksMate', kind: 'MVNO', nets: ['docomo'], color: '#f4511e' },
  { id: 'qt', name: 'QTモバイル', kind: 'MVNO', nets: ['docomo', 'au', 'softbank'], color: '#0097a7' },
  { id: 'other', name: 'その他の格安SIM', kind: 'MVNO', nets: ['docomo', 'au', 'softbank', 'rakuten'], color: '#9e9e9e' },
];

export const CARRIER_MAP = Object.fromEntries(CARRIERS.map((c) => [c.id, c]));

/** 端末に表示されている通信方式（ユーザー申告。ブラウザからは取得できない） */
export const GENERATIONS = ['5G', '4G', '3G', 'none'];

/** スコア帯（降雨レーダー風の凡例）。min 以上で該当 */
export const BANDS = [
  { min: 80, label: '非常に良好', color: '#1a9b8a' },
  { min: 60, label: '良好', color: '#62b84a' },
  { min: 40, label: '普通', color: '#e9c33b' },
  { min: 20, label: '弱い', color: '#ef7a2f' },
  { min: 1, label: 'かなり弱い', color: '#d6283b' },
  { min: 0, label: '不通・圏外', color: '#5b1029' },
];

export const bandOf = (score) => BANDS.find((b) => score >= b.min) ?? BANDS.at(-1);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 実測値 → 0〜100 の総合スコア
 * down/up: Mbps, rtt: ms, rsrp: dBm（任意入力）, ok=false は通信不能
 */
export function scoreOf({ ok = true, down, up, rtt, rsrp } = {}) {
  if (ok === false) return 0;
  const parts = [];
  // 0.3Mbps → 0, 90Mbps → 1（対数）
  if (isNum(down)) parts.push([0.55, clamp01(Math.log10(Math.max(down, 1e-3) / 0.3) / Math.log10(300))]);
  // 0.2Mbps → 0, 50Mbps → 1
  if (isNum(up)) parts.push([0.15, clamp01(Math.log10(Math.max(up, 1e-3) / 0.2) / Math.log10(250))]);
  // 50ms → 1, 800ms → 0
  if (isNum(rtt)) parts.push([0.3, clamp01(1 - Math.log10(Math.max(rtt, 1) / 50) / Math.log10(16))]);
  let s = null;
  if (parts.length) {
    const w = parts.reduce((a, [wt]) => a + wt, 0);
    s = parts.reduce((a, [wt, v]) => a + wt * v, 0) / w;
  }
  if (isNum(rsrp)) {
    // -125dBm → 0, -80dBm → 1
    const r = clamp01((rsrp + 125) / 45);
    s = s === null ? r : 0.7 * s + 0.3 * r;
  }
  if (s === null) return 0;
  // 通信できた地点は最低 1（0 は「不通」専用）
  return Math.max(1, Math.round(100 * s));
}

const M_PER_DEG = 111_320;

/** 緯度経度 → 一辺 sizeM メートルのメッシュ */
export function cellOf(lat, lng, sizeM) {
  const dLat = sizeM / M_PER_DEG;
  const i = Math.floor(lat / dLat);
  const rowLat = (i + 0.5) * dLat;
  const dLng = sizeM / (M_PER_DEG * Math.cos((rowLat * Math.PI) / 180));
  const j = Math.floor(lng / dLng);
  return { key: `${i}:${j}`, s: i * dLat, n: (i + 1) * dLat, w: j * dLng, e: (j + 1) * dLng };
}

/** 2 点間の距離（m） */
export function distanceM(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

export function median(values) {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const num = (v, min, max, digits) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(Math.min(max, Math.max(min, n)) * f) / f;
};

export const MAX_ACCURACY_M = 150;

/**
 * 投稿された計測値を検証・正規化する。不正なら理由の文字列を投げる。
 * 位置は約 11m 単位に丸めて保存する（個人の行動を細かく残さない）
 */
export function normalizePoint(p, now = Date.now()) {
  if (!p || typeof p !== 'object') throw 'データが不正です';
  const carrier = CARRIER_MAP[p.c];
  if (!carrier) throw 'キャリアが不正です';
  if (!carrier.nets.includes(p.n)) throw '回線が不正です';
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw '位置が不正です';
  const acc = num(p.acc, 0, 10_000, 0);
  if (acc === null || acc > MAX_ACCURACY_M) throw '位置の精度が低すぎます';
  const t = Number(p.t);
  if (!Number.isFinite(t) || t > now + 5 * 60_000 || t < now - 30 * 86_400_000) throw '計測時刻が不正です';
  const id = String(p.id ?? '');
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(id)) throw 'ID が不正です';
  const ok = p.ok !== false;
  const point = {
    id,
    t: Math.round(t),
    lat: Math.round(lat * 1e4) / 1e4,
    lng: Math.round(lng * 1e4) / 1e4,
    acc,
    c: carrier.id,
    n: p.n,
    g: GENERATIONS.includes(p.g) ? p.g : null,
    ok,
    d: ok ? num(p.d, 0, 10_000, 2) : 0,
    u: ok ? num(p.u, 0, 10_000, 2) : null,
    r: ok ? num(p.r, 1, 60_000, 0) : null,
    p: num(p.p, -150, -30, 0),
  };
  if (ok && point.d === null && point.r === null && point.p === null) throw '計測値がありません';
  point.s = scoreOf({ ok, down: point.d ?? undefined, up: point.u ?? undefined, rtt: point.r ?? undefined, rsrp: point.p ?? undefined });
  return point;
}
