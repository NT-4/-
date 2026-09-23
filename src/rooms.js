// ルーム（ゲームセッション）の状態管理と永続化
import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PATTERNS,
  TIEBREAKS,
  CENTER,
  FREE,
  MAX_NUMBER,
  cardKey,
  generateUniqueCard,
  drawNext,
  evaluate,
  openedByDraws,
  achievedAtDraw,
  rankWinners,
} from './game.js';

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLAYERS = 5000;
const MAX_CARDS = 4;

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const token = () => randomBytes(24).toString('base64url');
const shortId = (len = 8) => randomBytes(len).toString('base64url').slice(0, len);

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
  return Array.from({ length: 5 }, () => chars[randomInt(chars.length)]).join('');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

export function normalizeSettings(input = {}, base = {}) {
  const s = { ...defaultSettings(), ...base };
  if ('title' in input) s.title = cleanText(input.title, 40) || 'BINGO';
  if ('pattern' in input && input.pattern in PATTERNS) s.pattern = input.pattern;
  if ('cardsPerPlayer' in input) s.cardsPerPlayer = clampInt(input.cardsPerPlayer, 1, MAX_CARDS, 1);
  if ('allowAutoMark' in input) s.allowAutoMark = Boolean(input.allowAutoMark);
  if ('autoDrawSec' in input) s.autoDrawSec = clampInt(input.autoDrawSec, 0, 300, 0);
  if ('timeLimitMin' in input) s.timeLimitMin = clampInt(input.timeLimitMin, 0, 600, 0);
  if ('tiebreak' in input && input.tiebreak in TIEBREAKS) s.tiebreak = input.tiebreak;
  if ('prizes' in input) {
    const list = Array.isArray(input.prizes) ? input.prizes : String(input.prizes).split('\n');
    s.prizes = list.map((p) => cleanText(p, 60)).filter(Boolean).slice(0, 100);
  }
  return s;
}

function defaultSettings() {
  return {
    title: 'BINGO',
    pattern: 'line',
    cardsPerPlayer: 1,
    allowAutoMark: true,
    autoDrawSec: 0,
    timeLimitMin: 0,
    tiebreak: 'lottery',
    prizes: [],
  };
}

export class Room {
  constructor(data) {
    Object.assign(this, data);
    this.cardKeys = new Set();
    this.tokenIndex = new Map(); // token -> playerId（数千人でも O(1) で認証）
    this.hostViewCache = null;
    for (const p of Object.values(this.players)) {
      this.tokenIndex.set(p.token, p.id);
      for (const c of p.cards) this.cardKeys.add(cardKey(c.numbers));
    }
  }

  static create(settings) {
    return new Room({
      id: roomCode(),
      hostToken: token(),
      createdAt: Date.now(),
      touchedAt: Date.now(),
      settings: normalizeSettings(settings),
      status: 'waiting', // waiting | running | paused | finished
      round: 1,
      draws: [],
      lastDrawAt: 0,
      elapsedMs: 0,
      runningSince: 0,
      players: {},
      winners: [],
      rejectedClaims: 0,
    });
  }

  toJSON() {
    const { cardKeys, tokenIndex, hostViewCache, ...rest } = this;
    return rest;
  }

  touch() {
    this.touchedAt = Date.now();
  }

  // ---------- 時間 ----------
  elapsed(now = Date.now()) {
    return this.elapsedMs + (this.status === 'running' ? now - this.runningSince : 0);
  }

  remainingMs(now = Date.now()) {
    if (!this.settings.timeLimitMin) return null;
    return Math.max(0, this.settings.timeLimitMin * 60_000 - this.elapsed(now));
  }

  // ---------- 参加者 ----------
  newCard() {
    const numbers = generateUniqueCard(this.cardKeys);
    const marks = numbers.map((n) => n === FREE);
    return { id: shortId(6), numbers, marks };
  }

  addPlayer(name) {
    const n = Object.keys(this.players).length;
    if (n >= MAX_PLAYERS) throw new GameError('参加人数の上限に達しています', 409);
    const clean = cleanText(name, 20);
    if (!clean) throw new GameError('名前を入力してください');
    const player = {
      id: shortId(8),
      token: token(),
      name: clean,
      joinedAt: Date.now(),
      autoMark: this.settings.allowAutoMark,
      cards: [],
    };
    for (let i = 0; i < this.settings.cardsPerPlayer; i++) player.cards.push(this.newCard());
    this.syncAutoMarks(player);
    this.players[player.id] = player;
    this.tokenIndex.set(player.token, player.id);
    this.touch();
    return player;
  }

  findPlayerByToken(tok) {
    if (typeof tok !== 'string' || !tok) return null;
    const player = this.players[this.tokenIndex.get(tok)];
    return player && safeEqual(player.token, tok) ? player : null;
  }

  syncAutoMarks(player) {
    if (!(player.autoMark && this.settings.allowAutoMark)) return;
    const drawn = new Set(this.draws);
    for (const card of player.cards) {
      card.numbers.forEach((n, i) => {
        if (drawn.has(n)) card.marks[i] = true;
      });
    }
  }

  setPrefs(player, prefs) {
    if ('autoMark' in prefs) {
      player.autoMark = Boolean(prefs.autoMark) && this.settings.allowAutoMark;
      this.syncAutoMarks(player);
    }
  }

  mark(player, cardId, index) {
    const card = player.cards.find((c) => c.id === cardId);
    if (!card) throw new GameError('カードが見つかりません', 404);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 24 || i === CENTER) throw new GameError('不正なマスです');
    if (card.marks[i]) {
      card.marks[i] = false; // 誤タップの取り消し
    } else {
      if (!this.draws.includes(card.numbers[i])) throw new GameError('その番号はまだ出ていません');
      card.marks[i] = true;
    }
    this.touch();
    return card;
  }

  // ---------- ビンゴ申請（サーバー側検証） ----------
  claim(player, cardId) {
    if (this.status === 'waiting') throw new GameError('ゲームはまだ始まっていません');
    const card = player.cards.find((c) => c.id === cardId);
    if (!card) throw new GameError('カードが見つかりません', 404);
    const existing = this.winners.find((w) => w.cardId === card.id);
    if (existing) return { ok: true, duplicate: true, winner: existing };

    // クライアント申告を信用せず、サーバー保持のカード・抽選履歴だけで判定する
    const truth = openedByDraws(card.numbers, this.draws);
    const marksValid = card.marks.every((m, i) => !m || truth[i]);
    const byMarks = evaluate(card.marks, this.settings.pattern).bingo;
    const at = achievedAtDraw(card.numbers, this.draws, this.settings.pattern);
    if (!marksValid || !byMarks || at === null) {
      this.rejectedClaims++;
      throw new GameError(
        at !== null ? 'ビンゴになっていますが、マスが開けられていません' : 'ビンゴが確認できませんでした',
        422,
      );
    }
    const winner = {
      id: shortId(6),
      playerId: player.id,
      name: player.name,
      cardId: card.id,
      achievedAtDraw: at,
      claimedAtDraw: this.draws.length,
      claimedAt: Date.now(),
      order: 0,
    };
    this.winners.push(winner);
    this.touch();
    return { ok: true, winner };
  }

  rankedWinners() {
    const prizes = this.settings.prizes;
    return rankWinners(this.winners).map((w) => ({ ...w, prize: prizes[w.rank - 1] ?? null }));
  }

  reachCount(card) {
    return evaluate(openedByDraws(card.numbers, this.draws), this.settings.pattern).reachCells.length;
  }

  // 同時ビンゴのタイブレーク
  tiebreak(achievedAt, method = this.settings.tiebreak) {
    const group = this.winners.filter((w) => w.achievedAtDraw === Number(achievedAt));
    if (group.length < 2) throw new GameError('同時ビンゴのグループがありません');
    let ordered;
    if (method === 'reach') {
      const score = new Map(
        group.map((w) => {
          const card = this.players[w.playerId]?.cards.find((c) => c.id === w.cardId);
          return [w.id, card ? this.reachCount(card) : 0];
        }),
      );
      ordered = group
        .map((w) => ({ w, r: Math.random() }))
        .sort((a, b) => score.get(b.w.id) - score.get(a.w.id) || a.r - b.r)
        .map((x) => x.w);
    } else {
      ordered = group
        .map((w) => ({ w, r: randomInt(1_000_000) }))
        .sort((a, b) => a.r - b.r)
        .map((x) => x.w);
    }
    ordered.forEach((w, i) => {
      w.order = i + 1;
    });
    this.touch();
    return ordered;
  }

  // 手動並べ替え（じゃんけん結果の反映など）
  moveWinner(winnerId, dir) {
    const ranked = rankWinners(this.winners);
    const idx = ranked.findIndex((w) => w.id === winnerId);
    if (idx < 0) throw new GameError('当選者が見つかりません', 404);
    const swapWith = idx + (dir === 'up' ? -1 : 1);
    const other = ranked[swapWith];
    if (!other || other.achievedAtDraw !== ranked[idx].achievedAtDraw) {
      throw new GameError('同じ同時ビンゴグループ内でのみ入れ替えできます');
    }
    const group = ranked.filter((w) => w.achievedAtDraw === ranked[idx].achievedAtDraw);
    [ranked[idx], ranked[swapWith]] = [ranked[swapWith], ranked[idx]];
    const orderMap = new Map(ranked.filter((w) => group.some((g) => g.id === w.id)).map((w, i) => [w.id, i + 1]));
    for (const w of this.winners) if (orderMap.has(w.id)) w.order = orderMap.get(w.id);
    this.touch();
  }

  // ---------- ゲームコントロール ----------
  start() {
    if (this.status !== 'waiting') throw new GameError('すでに開始しています');
    this.status = 'running';
    this.runningSince = Date.now();
    this.lastDrawAt = Date.now();
    this.touch();
  }

  pause() {
    if (this.status !== 'running') throw new GameError('進行中ではありません');
    this.elapsedMs = this.elapsed();
    this.status = 'paused';
    this.touch();
  }

  resume() {
    if (this.status !== 'paused') throw new GameError('一時停止中ではありません');
    this.status = 'running';
    this.runningSince = Date.now();
    this.lastDrawAt = Date.now();
    this.touch();
  }

  finish() {
    if (this.status === 'running') this.elapsedMs = this.elapsed();
    this.status = 'finished';
    this.touch();
  }

  reset() {
    this.status = 'waiting';
    this.round++;
    this.draws = [];
    this.winners = [];
    this.elapsedMs = 0;
    this.runningSince = 0;
    this.rejectedClaims = 0;
    this.cardKeys = new Set();
    for (const p of Object.values(this.players)) {
      p.cards = [];
      for (let i = 0; i < this.settings.cardsPerPlayer; i++) p.cards.push(this.newCard());
    }
    this.touch();
  }

  draw() {
    if (this.status !== 'running') throw new GameError('ゲームが進行中ではありません');
    const n = drawNext(this.draws);
    if (n === null) throw new GameError('すべての番号が出ました');
    this.draws.push(n);
    this.lastDrawAt = Date.now();
    for (const p of Object.values(this.players)) this.syncAutoMarks(p);
    if (this.draws.length >= MAX_NUMBER) this.finish();
    this.touch();
    return n;
  }

  updateSettings(input) {
    const locked = this.status !== 'waiting';
    const patch = { ...input };
    if (locked) {
      // 進行中にカード枚数・成立条件を変えると公平性が崩れるため固定
      delete patch.pattern;
      delete patch.cardsPerPlayer;
    }
    const before = this.settings.cardsPerPlayer;
    this.settings = normalizeSettings(patch, this.settings);
    if (!locked && this.settings.cardsPerPlayer !== before) {
      for (const p of Object.values(this.players)) {
        while (p.cards.length < this.settings.cardsPerPlayer) p.cards.push(this.newCard());
        for (const c of p.cards.splice(this.settings.cardsPerPlayer)) this.cardKeys.delete(cardKey(c.numbers));
      }
    }
    if (!this.settings.allowAutoMark) for (const p of Object.values(this.players)) p.autoMark = false;
    this.touch();
  }

  // ---------- ビュー ----------
  publicState(now = Date.now()) {
    const { pattern } = this.settings;
    return {
      id: this.id,
      settings: { ...this.settings, patternLabel: PATTERNS[pattern].label, tiebreakLabel: TIEBREAKS[this.settings.tiebreak] },
      status: this.status,
      round: this.round,
      draws: this.draws,
      lastDrawAt: this.lastDrawAt,
      elapsedMs: this.elapsed(now),
      remainingMs: this.remainingMs(now),
      playerCount: Object.keys(this.players).length,
      winners: this.rankedWinners().map(({ playerId, ...w }) => w),
      serverTime: now,
    };
  }

  playerView(player) {
    return {
      id: player.id,
      name: player.name,
      autoMark: player.autoMark,
      cards: player.cards.map((c) => {
        const ev = evaluate(c.marks, this.settings.pattern);
        return {
          id: c.id,
          numbers: c.numbers,
          marks: c.marks,
          reachCells: ev.reachCells,
          bingo: ev.bingo,
          completed: ev.completed,
          won: this.winners.some((w) => w.cardId === c.id),
        };
      }),
    };
  }

  /** 全参加者のリーチ集計は重いので、最大 maxAgeMs に1回だけ計算する */
  hostView(maxAgeMs = 0, now = Date.now()) {
    if (this.hostViewCache && now - this.hostViewCache.at < maxAgeMs) return this.hostViewCache.view;
    const view = this.computeHostView();
    this.hostViewCache = { at: now, view };
    return view;
  }

  computeHostView() {
    const players = Object.values(this.players).map((p) => ({
      id: p.id,
      name: p.name,
      reach: p.cards.reduce((sum, c) => sum + this.reachCount(c), 0),
      won: this.winners.some((w) => w.playerId === p.id),
    }));
    return {
      players,
      reachPlayers: players.filter((p) => p.reach > 0 && !p.won).length,
      rejectedClaims: this.rejectedClaims,
    };
  }
}

export class RoomStore extends EventEmitter {
  constructor({ file = null } = {}) {
    super();
    this.file = file;
    this.rooms = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const data of raw.rooms ?? []) {
        const room = new Room(data);
        if (room.status === 'running') {
          // サーバー停止中は経過時間に含めない
          room.runningSince = Date.now();
          room.lastDrawAt = Date.now();
        }
        this.rooms.set(room.id, room);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('状態ファイルの読み込みに失敗:', e.message);
    }
  }

  saveSoon() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1500); // 大人数時の書き込み頻度を抑える
  }

  saveNow() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ rooms: [...this.rooms.values()] }));
    renameSync(tmp, this.file);
  }

  create(settings) {
    let room;
    do room = Room.create(settings);
    while (this.rooms.has(room.id));
    this.rooms.set(room.id, room);
    this.changed(room, { kind: 'created' });
    return room;
  }

  get(id) {
    const room = this.rooms.get(String(id ?? '').toUpperCase());
    if (!room) throw new GameError('ルームが見つかりません', 404);
    return room;
  }

  changed(room, event) {
    this.saveSoon();
    this.emit('change', room, event);
  }

  /** 1秒ごと：自動抽選・制限時間・期限切れルームの掃除 */
  tick(now = Date.now()) {
    for (const room of this.rooms.values()) {
      if (now - room.touchedAt > ROOM_TTL_MS) {
        this.rooms.delete(room.id);
        this.emit('removed', room);
        continue;
      }
      if (room.status !== 'running') continue;
      const remaining = room.remainingMs(now);
      if (remaining === 0) {
        room.finish();
        this.changed(room, { kind: 'timeup' });
        continue;
      }
      if (room.settings.autoDrawSec > 0 && now - room.lastDrawAt >= room.settings.autoDrawSec * 1000) {
        try {
          const number = room.draw();
          this.changed(room, { kind: 'draw', number });
        } catch {
          /* 全番号抽選済みなど */
        }
      }
    }
  }
}
