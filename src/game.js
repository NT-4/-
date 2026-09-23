// ビンゴの純粋なゲームロジック（I/O なし・テスト容易）
import { randomInt } from 'node:crypto';

export const COLUMNS = ['B', 'I', 'N', 'G', 'O'];
export const MAX_NUMBER = 75;
export const FREE = 0; // 中央マス
export const CENTER = 12;

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const ROWS = range(0, 4).map((r) => range(0, 4).map((c) => r * 5 + c));
const COLS = range(0, 4).map((c) => range(0, 4).map((r) => r * 5 + c));
const DIAGS = [range(0, 4).map((i) => i * 6), range(0, 4).map((i) => (i + 1) * 4)];

export const PATTERNS = {
  line: { label: '1列（縦・横・斜め）', sets: [...ROWS, ...COLS, ...DIAGS] },
  cross: { label: '十字', sets: [[...new Set([...ROWS[2], ...COLS[2]])]] },
  corners: { label: '四隅', sets: [[0, 4, 20, 24]] },
  full: { label: '全開け', sets: [range(0, 24)] },
};

export const TIEBREAKS = {
  lottery: 'くじ引き（ランダム）',
  reach: '残りリーチ数が多い順',
  manual: '手動（じゃんけん等）',
};

export function letterOf(n) {
  return COLUMNS[Math.floor((n - 1) / 15)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 5×5 カード（行優先の長さ25配列、中央は FREE=0）。各列は B:1-15 … O:61-75 */
export function generateCard() {
  const cols = COLUMNS.map((_, c) => shuffle(range(c * 15 + 1, c * 15 + 15)).slice(0, 5));
  const card = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) card.push(cols[c][r]);
  card[CENTER] = FREE;
  return card;
}

export const cardKey = (card) => card.join(',');

/** 既存カードと重複しないカードを生成 */
export function generateUniqueCard(existingKeys) {
  for (let i = 0; i < 1000; i++) {
    const card = generateCard();
    const key = cardKey(card);
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      return card;
    }
  }
  throw new Error('一意なカードを生成できませんでした');
}

/** 未抽選の番号から1つを重複なしで抽出 */
export function drawNext(draws) {
  const drawn = new Set(draws);
  const remaining = range(1, MAX_NUMBER).filter((n) => !drawn.has(n));
  if (remaining.length === 0) return null;
  return remaining[randomInt(remaining.length)];
}

/** opened: 長さ25の boolean 配列 */
export function evaluate(opened, pattern = 'line') {
  const sets = PATTERNS[pattern]?.sets ?? PATTERNS.line.sets;
  const completed = [];
  const reachCells = new Set();
  for (const set of sets) {
    const missing = set.filter((i) => !opened[i]);
    if (missing.length === 0) completed.push(set);
    else if (missing.length === 1) reachCells.add(missing[0]);
  }
  return { bingo: completed.length > 0, completed, reachCells: [...reachCells] };
}

/** 抽選済み番号から開いているマスを求める（サーバー側の真実） */
export function openedByDraws(card, draws) {
  const drawn = new Set(draws);
  return card.map((n) => n === FREE || drawn.has(n));
}

/**
 * そのカードが何回目の抽選でビンゴ成立したか（1始まり）。未成立なら null。
 * 同時ビンゴ判定・順位付けに使う。
 */
export function achievedAtDraw(card, draws, pattern = 'line') {
  const order = new Map(draws.map((n, i) => [n, i + 1]));
  const sets = PATTERNS[pattern]?.sets ?? PATTERNS.line.sets;
  let best = Infinity;
  for (const set of sets) {
    let need = 0;
    for (const i of set) {
      const n = card[i];
      const at = n === FREE ? 0 : order.get(n) ?? Infinity;
      need = Math.max(need, at);
    }
    best = Math.min(best, need);
  }
  return Number.isFinite(best) ? best : null;
}

/** ソート済み winners に順位と同時ビンゴのグループ情報を付与 */
export function rankWinners(winners) {
  const sorted = [...winners].sort(
    (a, b) => a.achievedAtDraw - b.achievedAtDraw || a.order - b.order || a.claimedAt - b.claimedAt,
  );
  const groupSize = new Map();
  for (const w of sorted) groupSize.set(w.achievedAtDraw, (groupSize.get(w.achievedAtDraw) ?? 0) + 1);
  return sorted.map((w, i) => ({
    ...w,
    rank: i + 1,
    tie: groupSize.get(w.achievedAtDraw) > 1,
  }));
}
