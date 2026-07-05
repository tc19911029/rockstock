/**
 * 影響評估：書本 CH5-02 初篩硬規則「昨量 <500 張淘汰、股價 <5 元淘汰」要不要加進 pool。
 *
 * 方法：用「攻擊日」proxy 近似會被掃進候選池的樣本（多頭 close>MA20↑ + 紅K實體≥2%
 *   + 量比昨≥1.2 + 收盤過昨高 = 六條件④⑤ 的可轉譯核心），統計：
 *   1. 這些樣本裡 昨量<500張 / 價<5元 的佔比（=加硬篩會踢掉多少）
 *   2. 被踢組 vs 其餘組的 D5/D20 超額（^TWII 對齊）
 *   3. 誤殺檢查：被踢組裡 D20 超額 >+15% 的「大贏家」有幾筆
 * 注意：TW L1 volume 單位=張（volume unit repair 之後）。純研究報告，不動 pool。
 */
import * as fs from 'fs';
import * as path from 'path';

const CANDLE_DIR = 'data/candles/TW';
interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number }

function load(file: string): Candle[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : j.candles;
    return Array.isArray(arr) && arr.length > 120 ? arr : null;
  } catch { return null; }
}
const idx = load(path.join(CANDLE_DIR, '^TWII.json'))!;
const idxClose = new Map(idx.map((c) => [c.date, c.close]));

interface Ev { date: string; lowVol: boolean; lowPrice: boolean; ex5: number | null; ex20: number | null }
const events: Ev[] = [];
const files = fs.readdirSync(CANDLE_DIR).filter((f) => /^\d{4}\.(TW|TWO)\.json$/.test(f));

for (const f of files) {
  const candles = load(path.join(CANDLE_DIR, f));
  if (!candles) continue;
  const ma20: number[] = new Array(candles.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= 20) sum -= candles[i - 20].close;
    if (i >= 19) ma20[i] = sum / 20;
  }
  for (let i = 60; i < candles.length - 22; i++) {
    const t = candles[i], p = candles[i - 1];
    if (!p.close || !p.volume || p.close <= 0) continue;
    const body = (t.close - t.open) / t.open;
    if (!(t.close > t.open && body >= 0.02)) continue;              // 紅K實體 ≥2%
    if (!(t.volume >= p.volume * 1.2)) continue;                     // 量比 ≥1.2（課程口徑）
    if (!(t.close > p.high)) continue;                               // 過昨高
    if (!(t.close > ma20[i] && ma20[i] > ma20[i - 1])) continue;     // 多頭 proxy
    const fwd = (k: number): number | null => {
      if (i + k >= candles.length) return null;
      const a = idxClose.get(t.date), b = idxClose.get(candles[i + k].date);
      if (!a || !b) return null;
      return (candles[i + k].close / t.close - 1) - (b / a - 1);
    };
    events.push({ date: t.date, lowVol: p.volume < 500, lowPrice: t.close < 5, ex5: fwd(5), ex20: fwd(20) });
  }
}

function stats(list: Ev[], key: 'ex5' | 'ex20') {
  const v = list.map((e) => e[key]).filter((x): x is number => x != null);
  if (!v.length) return { n: 0, avg: NaN, win: NaN, bigWin: 0 };
  return {
    n: v.length,
    avg: +((v.reduce((a, b) => a + b, 0) / v.length) * 100).toFixed(2),
    win: +((v.filter((x) => x > 0).length / v.length) * 100).toFixed(1),
    bigWin: v.filter((x) => x > 0.15).length,
  };
}

const total = events.length;
for (const [label, pick] of [
  ['昨量<500張', (e: Ev) => e.lowVol],
  ['價<5元', (e: Ev) => e.lowPrice],
  ['兩者皆非（留下的）', (e: Ev) => !e.lowVol && !e.lowPrice],
] as const) {
  const list = events.filter(pick);
  const s5 = stats(list, 'ex5'), s20 = stats(list, 'ex20');
  console.log(`${label}：${list.length} 筆（佔 ${(list.length / total * 100).toFixed(1)}%）  D5 ${s5.avg}%  D20 ${s20.avg}%（勝率 ${s20.win}%）  D20>+15% 大贏家 ${s20.bigWin} 筆`);
}
console.log(`\n攻擊日樣本總數 ${total}（近似候選池，非實際 L4 名單）`);
