import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCard,
  generateUniqueCard,
  cardKey,
  drawNext,
  evaluate,
  openedByDraws,
  achievedAtDraw,
  rankWinners,
  FREE,
  CENTER,
} from '../src/game.js';

test('カードは各列の範囲内・重複なし・中央FREE', () => {
  for (let k = 0; k < 200; k++) {
    const card = generateCard();
    assert.equal(card.length, 25);
    assert.equal(card[CENTER], FREE);
    const nums = card.filter((n) => n !== FREE);
    assert.equal(new Set(nums).size, 24);
    card.forEach((n, i) => {
      if (i === CENTER) return;
      const c = i % 5;
      assert.ok(n >= c * 15 + 1 && n <= c * 15 + 15, `列${c}に${n}`);
    });
  }
});

test('generateUniqueCard は既存カードと重複しない', () => {
  const keys = new Set();
  for (let i = 0; i < 500; i++) generateUniqueCard(keys);
  assert.equal(keys.size, 500);
});

test('drawNext は75球すべてを重複なく出す', () => {
  const draws = [];
  for (let i = 0; i < 75; i++) draws.push(drawNext(draws));
  assert.equal(new Set(draws).size, 75);
  assert.equal(drawNext(draws), null);
});

test('evaluate: 横・縦・斜め・リーチ判定', () => {
  const opened = Array(25).fill(false);
  opened[CENTER] = true;
  [10, 11, 13].forEach((i) => (opened[i] = true)); // 中段 14 だけ未開
  let ev = evaluate(opened, 'line');
  assert.equal(ev.bingo, false);
  assert.deepEqual(ev.reachCells, [14]);
  opened[14] = true;
  ev = evaluate(opened, 'line');
  assert.equal(ev.bingo, true);

  const diag = Array(25).fill(false);
  [0, 6, 12, 18, 24].forEach((i) => (diag[i] = true));
  assert.equal(evaluate(diag, 'line').bingo, true);
  assert.equal(evaluate(diag, 'corners').bingo, false);
});

test('evaluate: 十字・四隅・全開け', () => {
  const cross = Array(25).fill(false);
  [2, 7, 12, 17, 22, 10, 11, 13, 14].forEach((i) => (cross[i] = true));
  assert.equal(evaluate(cross, 'cross').bingo, true);
  const corners = Array(25).fill(false);
  [0, 4, 20, 24].forEach((i) => (corners[i] = true));
  assert.equal(evaluate(corners, 'corners').bingo, true);
  assert.equal(evaluate(Array(25).fill(true), 'full').bingo, true);
  assert.equal(evaluate(corners, 'full').bingo, false);
});

test('achievedAtDraw は成立した抽選回を返す', () => {
  const card = generateCard();
  const row0 = card.slice(0, 5);
  const miss = Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !card.includes(n));
  const draws = [miss[0], ...row0.slice(0, 4), miss[1], row0[4]]; // 7球目で横1列目が揃う
  assert.equal(achievedAtDraw(card, draws, 'line'), 7);
  assert.equal(achievedAtDraw(card, [row0[0]], 'line'), null);
  // 中央FREEを含む列は4球で成立
  const midRow = [card[10], card[11], card[13], card[14]];
  assert.equal(achievedAtDraw(card, midRow, 'line'), 4);
  assert.deepEqual(openedByDraws(card, midRow).slice(10, 15), [true, true, true, true, true]);
});

test('rankWinners: 成立球数順・同時ビンゴ検出', () => {
  const ranked = rankWinners([
    { id: 'a', achievedAtDraw: 12, order: 0, claimedAt: 3 },
    { id: 'b', achievedAtDraw: 10, order: 0, claimedAt: 5 },
    { id: 'c', achievedAtDraw: 12, order: 0, claimedAt: 1 },
  ]);
  assert.deepEqual(ranked.map((w) => w.id), ['b', 'c', 'a']);
  assert.deepEqual(ranked.map((w) => w.tie), [false, true, true]);
  assert.deepEqual(ranked.map((w) => w.rank), [1, 2, 3]);
});

test('cardKey は内容が同じなら一致', () => {
  const c = generateCard();
  assert.equal(cardKey(c), cardKey([...c]));
});
