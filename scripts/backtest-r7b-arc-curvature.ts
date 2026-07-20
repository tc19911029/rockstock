/**
 * 驗證 2：圓弧底補「碗狀曲率」驗證
 *
 * 現況 lib/analysis/v12LetterN.ts detectRoundingBottom：只驗弧底落在 30 根窗口中間
 * （前後長度比 ≤1:3）+ 深度>0，無曲率判定 → V 形急殺急拉也會被貼「圓弧底」。
 * 課程 6-4：「左邊碎步下跌，底部打底盤整，右邊碎步上漲」。
 *
 * 曲率量化（自行設計，三個變體）：
 *   V1 單根支配度：左翼最大單根跌幅 / 左翼總跌幅 ≤ 0.5，且右翼同理 ≤ 0.5
 *                  （單一根就走完一半以上 = 急殺/急拉，不是碎步）
 *   V2 = V1 + 中段盤整：弧底附近 1/3 窗口的日均波動 ≤ 兩翼日均波動
 *   V3 中段盤整 only
 *
 * 事件 = 生產 detectLetterN 實際回傳 rounding-bottom 且 triggered 的股票日。
 * 比較「通過曲率（留下）」vs「不通過（被砍）」的 D5/D20 去 beta 超額。
 */
import { detectLetterN } from '@/lib/analysis/v12LetterN';
import type { CandleWithIndicators } from '@/types';
import {
  loadStocks, loadBench, benchFwd, liquid, HORIZONS,
  type Obs, reportGroup, splitDate, mean, attachUniverseExcess,
} from './backtest-r7b-common';

const LOOKBACK = 30;

interface Curv { v1: boolean; v2: boolean; v3: boolean }

/** 重算 detectRoundingBottom 的窗口，量化曲率 */
function curvature(cs: CandleWithIndicators[], idx: number): Curv | null {
  const start = Math.max(0, idx - LOOKBACK);
  if (idx - start < 20) return null;
  let arcLow = Infinity, arcLowIdx = -1;
  for (let i = start; i <= idx; i++) if (cs[i].low < arcLow) { arcLow = cs[i].low; arcLowIdx = i; }
  if (arcLowIdx < 0) return null;
  if (arcLowIdx - start < 3 || idx - arcLowIdx < 3) return null;

  // ── V1 單根支配度 ──
  let beforeHigh = -Infinity;
  for (let i = start; i <= arcLowIdx; i++) beforeHigh = Math.max(beforeHigh, cs[i].high);
  const leftDrop = beforeHigh - arcLow;
  const rightRise = cs[idx].close - arcLow;
  let maxBarDrop = 0, maxBarRise = 0;
  for (let i = start + 1; i <= arcLowIdx; i++) maxBarDrop = Math.max(maxBarDrop, cs[i - 1].close - cs[i].close);
  for (let i = arcLowIdx + 1; i <= idx; i++) maxBarRise = Math.max(maxBarRise, cs[i].close - cs[i - 1].close);
  const leftRatio = leftDrop > 0 ? maxBarDrop / leftDrop : 1;
  const rightRatio = rightRise > 0 ? maxBarRise / rightRise : 1;
  const v1 = leftRatio <= 0.5 && rightRatio <= 0.5;

  // ── V3 中段盤整：弧底附近 1/3 窗口 vs 兩翼的日均絕對變動% ──
  const len = idx - start;
  const half = Math.max(2, Math.round(len / 6));
  const mLo = Math.max(start + 1, arcLowIdx - half);
  const mHi = Math.min(idx, arcLowIdx + half);
  const dailyAbs = (a: number, b: number) => {
    const xs: number[] = [];
    for (let i = Math.max(a, start + 1); i <= b; i++) {
      if (cs[i - 1].close > 0) xs.push(Math.abs(cs[i].close / cs[i - 1].close - 1) * 100);
    }
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
  };
  const midVol = dailyAbs(mLo, mHi);
  const wingXs: number[] = [];
  for (let i = start + 1; i <= idx; i++) {
    if (i >= mLo && i <= mHi) continue;
    if (cs[i - 1].close > 0) wingXs.push(Math.abs(cs[i].close / cs[i - 1].close - 1) * 100);
  }
  const wingVol = wingXs.length ? wingXs.reduce((s, x) => s + x, 0) / wingXs.length : NaN;
  const v3 = Number.isFinite(midVol) && Number.isFinite(wingVol) && midVol <= wingVol;

  return { v1, v2: v1 && v3, v3 };
}

function main() {
  const bench = loadBench();
  const stocks = loadStocks();
  const FROM = '2023-04-13';
  const all: (Obs & { c: Curv })[] = [];
  const universe: Obs[] = [];

  let done = 0;
  for (const s of stocks) {
    const cs = s.candles;
    for (let t = 60; t + 20 < cs.length; t++) {
      const c = cs[t];
      if (c.date < FROM) continue;
      if (!liquid(c)) continue;

      const ex: Record<number, number> = {};
      let ok = true;
      for (const h of HORIZONS) {
        const b = benchFwd(bench, c.date, h);
        if (b == null) { ok = false; break; }
        ex[h] = (cs[t + h].close / c.close - 1) * 100 - b;
      }
      if (!ok) continue;
      universe.push({ date: c.date, symbol: s.symbol, ex });

      // 便宜前置：紅K + 實體≥2%，過不了就不必進 detectLetterN
      if (c.close <= c.open) continue;
      if ((c.close - c.open) / c.open * 100 < 2) continue;

      const r = detectLetterN(cs, t, 'TW', s.symbol);
      if (!r.triggered || r.patternType !== 'rounding-bottom') continue;
      const cv = curvature(cs, t);
      if (!cv) continue;
      all.push({ date: c.date, symbol: s.symbol, ex, c: cv });
    }
    if (++done % 300 === 0) process.stdout.write('.');
  }
  console.log('');
  attachUniverseExcess(universe, [universe, all]);

  console.log(`\n===== 驗證 2：圓弧底補碗狀曲率 =====`);
  console.log(`生產 rounding-bottom 訊號共 ${all.length} 筆（超額 = 個股 − ^TWII 同期）`);
  if (!all.length) { console.log('無樣本'); return; }
  const mid = splitDate(all);
  console.log(`train/test 分界 ${mid}`);

  reportGroup('現況全體（無曲率條件）', all, mid);
  for (const v of ['v1', 'v2', 'v3'] as const) {
    const keep = all.filter(o => o.c[v]);
    const cut = all.filter(o => !o.c[v]);
    console.log(`\n########## 變體 ${v.toUpperCase()} ##########`);
    reportGroup(`${v} 留下（過曲率）`, keep, mid);
    reportGroup(`${v} 被砍（不過曲率）`, cut, mid);
    const dk = mean(keep.map(o => o.exu![20])) - mean(all.map(o => o.exu![20]));
    const d5 = mean(keep.map(o => o.exu![5])) - mean(all.map(o => o.exu![5]));
    console.log(`  留下 vs 現況全體：D5 ${d5.toFixed(2)}pp  D20 ${dk.toFixed(2)}pp（正=有改善）`);
  }
  console.log('\n判讀：某變體「被砍」組 train/test 都明顯較差、且「留下」組優於現況全體 → 該變體通過。');
}
main();
