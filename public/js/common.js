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
  navigator.vibrate?.([100, 60, 200]);
}
