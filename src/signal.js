// 電波マップの計測データ（全ユーザー共有）の保持と永続化
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizePoint } from '../public/js/signal-core.js';
import { GameError } from './rooms.js';

const MAX_BATCH = 50;
const MAX_QUERY_SPAN_DEG = 1;
const MAX_RESULTS = 20_000;

export class SignalStore {
  constructor({ file = null, maxPoints = 300_000, saveDelayMs = 2000 } = {}) {
    this.file = file;
    this.maxPoints = maxPoints;
    this.saveDelayMs = saveDelayMs;
    /** 時刻順（古い → 新しい） */
    this.points = [];
    this.ids = new Set();
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const list = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(list)) return;
      this.points = list.filter((p) => p && typeof p.id === 'string').sort((a, b) => a.t - b.t);
      this.ids = new Set(this.points.map((p) => p.id));
    } catch {
      // 初回起動・壊れたファイルは空から始める
    }
  }

  /** 計測値をまとめて追加。重複 ID は無視（オフライン時の再送に対応） */
  add(list, now = Date.now()) {
    if (!Array.isArray(list) || !list.length) throw new GameError('points が空です');
    if (list.length > MAX_BATCH) throw new GameError(`一度に送れるのは ${MAX_BATCH} 件までです`);
    let added = 0;
    const rejected = [];
    for (const raw of list) {
      let p;
      try {
        p = normalizePoint(raw, now);
      } catch (reason) {
        rejected.push({ id: raw?.id ?? null, reason: String(reason) });
        continue;
      }
      if (this.ids.has(p.id)) continue;
      this.ids.add(p.id);
      // ほぼ時刻順に届くので末尾から挿入位置を探す
      let i = this.points.length;
      while (i > 0 && this.points[i - 1].t > p.t) i--;
      this.points.splice(i, 0, p);
      added++;
    }
    if (this.points.length > this.maxPoints) {
      for (const old of this.points.splice(0, this.points.length - this.maxPoints)) this.ids.delete(old.id);
    }
    if (added) this.scheduleSave();
    return { added, rejected };
  }

  /** 範囲内の計測値（新しい順に最大 MAX_RESULTS 件） */
  query({ s, w, n, e, since = 0 }) {
    if (![s, w, n, e].every(Number.isFinite) || s > n || w > e) throw new GameError('bbox が不正です');
    if (n - s > MAX_QUERY_SPAN_DEG || e - w > MAX_QUERY_SPAN_DEG) throw new GameError('範囲が広すぎます。拡大してください');
    const out = [];
    for (let i = this.points.length - 1; i >= 0 && out.length < MAX_RESULTS; i--) {
      const p = this.points[i];
      if (p.t < since) break;
      if (p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e) out.push(p);
    }
    return { points: out, truncated: out.length >= MAX_RESULTS };
  }

  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), this.saveDelayMs);
    this.timer.unref?.();
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.points));
    renameSync(tmp, this.file);
  }
}

export const parseBbox = (text) => {
  const [s, w, n, e] = String(text ?? '').split(',').map(Number);
  return { s, w, n, e };
};
