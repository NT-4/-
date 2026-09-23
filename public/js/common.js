// 各画面で共通のユーティリティ
export const COLUMNS = ['B', 'I', 'N', 'G', 'O'];
export const letterOf = (n) => COLUMNS[Math.floor((n - 1) / 15)];
export const ROLL_MS = 1400;

export const $ = (sel, root = document) => root.querySelector(sel);
export const params = new URLSearchParams(location.search);
export const roomId = (params.get('room') ?? '').toUpperCase();

export const storage = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* プライベートモード等 */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};

export async function api(path, body, token) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `エラー (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** SSE 接続。切断時はブラウザが自動再接続し、接続直後に全状態が再送される */
export function connect(room, token, onMessage, onStatus = () => {}) {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  const es = new EventSource(`/api/rooms/${room}/events${qs}`);
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.onmessage = (e) => onMessage(JSON.parse(e.data));
  return es;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export function ball(n) {
  if (!n) return el('span', { class: 'ball' }, '?');
  return el('span', { class: `ball ${letterOf(n)}` }, el('small', {}, letterOf(n)), String(n));
}

export function setBall(target, n, cls = '') {
  const b = ball(n);
  if (cls) b.classList.add(cls);
  target.replaceChildren(b);
}

/** ドラムロール風の抽選アニメーション（全クライアントで同じ長さ） */
export function rollTo(target, n, done = () => {}) {
  const start = performance.now();
  let timer;
  const step = () => {
    const t = performance.now() - start;
    if (t >= ROLL_MS) {
      setBall(target, n, 'reveal');
      done();
      return;
    }
    setBall(target, 1 + Math.floor(Math.random() * 75), 'rolling');
    timer = setTimeout(step, 40 + (t / ROLL_MS) * 160); // だんだん遅くなる
  };
  step();
  return () => clearTimeout(timer);
}

export function renderHistory(target, draws, limit = Infinity) {
  const list = [...draws].reverse().slice(0, limit);
  target.replaceChildren(...list.map(ball));
  if (!list.length) target.append(el('span', { class: 'muted' }, 'まだ番号は出ていません'));
}

export function renderBoard(target, draws) {
  const on = new Set(draws);
  const last = draws.at(-1);
  const colors = ['var(--b)', 'var(--i)', '#868e96', 'var(--g)', '#f59f00'];
  const nodes = [];
  COLUMNS.forEach((L, c) => {
    nodes.push(el('div', { class: 'h', style: `background:${colors[c]}` }, L));
    for (let n = c * 15 + 1; n <= c * 15 + 15; n++) {
      nodes.push(el('div', { class: `n${on.has(n) ? ' on' : ''}${n === last ? ' last' : ''}` }, String(n)));
    }
  });
  target.replaceChildren(...nodes);
}

export function renderWinners(target, winners, { mine = new Set(), host = null } = {}) {
  if (!winners.length) {
    target.replaceChildren(el('li', { class: 'muted' }, 'まだビンゴした人はいません'));
    return;
  }
  target.replaceChildren(
    ...winners.map((w, i) => {
      const prev = winners[i - 1];
      const next = winners[i + 1];
      const controls = host && w.tie
        ? [
            prev?.achievedAtDraw === w.achievedAtDraw &&
              el('button', { class: 'secondary small', title: '上へ', onclick: () => host.move(w.id, 'up') }, '↑'),
            next?.achievedAtDraw === w.achievedAtDraw &&
              el('button', { class: 'secondary small', title: '下へ', onclick: () => host.move(w.id, 'down') }, '↓'),
          ]
        : [];
      return el(
        'li',
        { class: mine.has(w.cardId) ? 'me' : '' },
        el('span', { class: 'rank' }, `${w.rank}位`),
        el(
          'span',
          { class: 'name' },
          w.name,
          el('br'),
          el('span', { class: 'muted small' }, `${w.achievedAtDraw}球目で成立`),
          w.tie ? el('span', { class: 'tie' }, ' ・同時ビンゴ') : null,
          w.prize ? el('div', { class: 'prize' }, `🎁 ${w.prize}`) : null,
        ),
        ...controls,
      );
    }),
  );
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const STATUS_LABEL = { waiting: '開始前', running: '進行中', paused: '一時停止', finished: '終了' };

export function statusBadge(target, status) {
  target.className = `badge ${status}`;
  target.textContent = STATUS_LABEL[status] ?? status;
}

/** 経過・残り時間をローカルで刻む */
export function clock(target, getRoom) {
  let base = null;
  setInterval(() => {
    const room = getRoom();
    if (!room) return;
    if (base?.room !== room) base = { room, at: Date.now() };
    const delta = room.status === 'running' ? Date.now() - base.at : 0;
    const text = room.remainingMs != null
      ? `残り ${fmtTime(room.remainingMs - delta)}`
      : `経過 ${fmtTime(room.elapsedMs + delta)}`;
    target.textContent = text;
  }, 250);
}

let toastTimer;
export function toast(msg, ms = 2600) {
  let t = $('.toast');
  if (!t) {
    t = el('div', { class: 'toast', role: 'status' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

export function celebrate(title = 'BINGO!', sub = '', ms = 3500) {
  const colors = ['#4dabf7', '#ff6b6b', '#ffcc33', '#51cf66', '#ff5c8a', '#fff'];
  const overlay = el('div', { class: 'overlay', onclick: () => overlay.remove() },
    el('div', {}, el('div', { class: 'big-text' }, title), sub ? el('div', { class: 'sub' }, sub) : null));
  document.body.append(overlay);
  const pieces = [];
  for (let i = 0; i < 80; i++) {
    const p = el('div', {
      class: 'confetti',
      style: `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};animation-duration:${2 + Math.random() * 2}s;animation-delay:${Math.random() * .5}s`,
    });
    pieces.push(p);
    document.body.append(p);
  }
  setTimeout(() => {
    overlay.remove();
    pieces.forEach((p) => p.remove());
  }, ms);
  vibrate([100, 60, 200]);
}

// ---------- 共有（参加URL・QR） ----------
const isLocalHost = () => /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);

/**
 * 参加者に配る URL のベースを決める。
 * PUBLIC_URL（本番）> 今開いている URL > localhost の場合は LAN の URL
 */
export async function shareBase() {
  const cfg = await api('/api/config').catch(() => ({}));
  if (cfg.publicUrl) return { base: cfg.publicUrl, options: [cfg.publicUrl], note: null };
  if (!isLocalHost()) return { base: location.origin, options: [location.origin], note: null };
  const lan = cfg.lanUrls ?? [];
  if (lan.length) {
    return {
      base: lan[0],
      options: lan,
      note: 'localhost では他の端末から開けないため、同じ Wi-Fi 内で使える LAN のアドレスで共有しています。会場外からも参加させる場合は公開サーバーにデプロイしてください。',
    };
  }
  return { base: location.origin, options: [location.origin], note: 'この URL は他の端末から開けません。公開サーバーにデプロイするか PUBLIC_URL を設定してください。' };
}

export const joinUrlOf = (base, room) => `${base}/r/${room}`;
export const qrSrc = (text) => `/api/qr.svg?text=${encodeURIComponent(text)}`;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch {
    prompt('コピーしてください', text);
  }
}

export async function shareLink(title, url) {
  const text = `「${title}」のビンゴに参加しよう！`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyText(`${text}\n${url}`);
}

export const lineShareUrl = (title, url) =>
  `https://line.me/R/share?text=${encodeURIComponent(`「${title}」のビンゴに参加しよう！\n${url}`)}`;

/** ?base= で渡された共有先を、サーバーが認めた候補の中にある場合だけ採用する */
export async function resolveShareBase() {
  const info = await shareBase();
  const wanted = params.get('base');
  if (wanted && (info.options.includes(wanted) || wanted === location.origin)) info.base = wanted;
  return info;
}

/** 画面に触れた後だけ振動させる（未操作時はブラウザが拒否して警告を出すため） */
export function vibrate(pattern) {
  if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(pattern);
}

// ---------- スマホアプリ化（PWA） ----------
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

if ('serviceWorker' in navigator && isSecureContext) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ルームを開いている間にホーム画面へ追加すると、アイコンからそのルームに直行できる
if (roomId) {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = `/manifest.webmanifest?room=${encodeURIComponent(roomId)}`;
}

/** ゲーム中に画面が消灯しないようにする（対応ブラウザのみ） */
export function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  let lock = null;
  const request = async () => {
    if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
    try {
      lock = await navigator.wakeLock.request('screen');
    } catch {
      /* 省電力モード等で拒否された場合は何もしない */
    }
  };
  document.addEventListener('visibilitychange', request);
  document.addEventListener('pointerdown', request, { once: true });
  request();
}

let deferredInstall = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  dispatchEvent(new Event('bingo:installable'));
});

/**
 * 「ホーム画面に追加」の案内を target に描画する。
 * Android/Chrome はボタン1つでインストール、iPhone は手順を表示。
 */
export function renderInstallHint(target) {
  const draw = () => {
    if (isStandalone()) return target.replaceChildren();
    if (deferredInstall) {
      target.replaceChildren(
        el('div', { class: 'install' },
          el('span', {}, '📲 ホーム画面に追加すると、アプリのように全画面で遊べます'),
          el('button', {
            class: 'small',
            onclick: async () => {
              deferredInstall.prompt();
              await deferredInstall.userChoice.catch(() => {});
              deferredInstall = null;
              draw();
            },
          }, '追加する')),
      );
    } else if (isIOS()) {
      target.replaceChildren(
        el('details', { class: 'install' },
          el('summary', {}, '📲 ホーム画面に追加してアプリのように使う'),
          el('ol', { class: 'small' },
            el('li', {}, 'Safari 下部の 共有ボタン（□↑）をタップ'),
            el('li', {}, '「ホーム画面に追加」→「追加」'),
            el('li', {}, 'ホーム画面の BINGO アイコンから起動')),
          el('p', { class: 'small muted' }, '※ iPhone ではアプリと Safari の保存データが別になります。参加する前に追加して、アプリ側から参加するのがおすすめです。')),
      );
    } else {
      target.replaceChildren();
    }
  };
  addEventListener('bingo:installable', draw);
  addEventListener('appinstalled', () => target.replaceChildren());
  draw();
}
