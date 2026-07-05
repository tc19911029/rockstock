/**
 * 回測：課程淘汰法第 13 條「三大法人高檔連續賣超 = 別碰」（R8 復活評估）
 *
 * 問題：高檔＋法人連續賣超 ≥N 天的股票，之後 D5/D20 是否系統性弱於「同樣在高檔、
 *       但法人沒有連賣」的股票？（基準設計成同位階對照，隔離「高檔」本身的效果）
 *
 * 誠實 edge 紀律：
 *   - 超額 = 個股報酬 − ^TWII 同窗報酬（逐 bar 對齊，去大盤 beta 近似）
 *   - train/test 按日期對半切，兩段方向一致才算 robust
 *   - 事件去重：連賣天數「首次達標」那天才計一次
 *
 * 結論用途：robust → 只接避雷顯示層（antiSignals pattern），不進選股 gate。
 */
import * as fs from 'fs';
import * as path from 'path';

const INST_DIR = 'data/chips/TW/inst';
const CANDLE_DIR = 'data/candles/TW';

interface InstRow { date: string; total: number }
interface Candle { date: string; close: number }

function loadCandles(file: string): Candle[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : j.candles;
    if (!Array.isArray(arr) || arr.length < 250) return null;
    return arr;
  } catch { return null; }
}

// ^TWII 收盤 by date
const idxCandles = loadCandles(path.join(CANDLE_DIR, '^TWII.json'))!;
const idxClose = new Map(idxCandles.map((c) => [c.date, c.close]));
const idxDates = idxCandles.map((c) => c.date);

interface Ev { symbol: string; date: string; ex5: number | null; ex20: number | null }

function fwdExcess(candles: Candle[], i: number, k: number): number | null {
  if (i + k >= candles.length) return null;
  const s0 = candles[i].close, s1 = candles[i + k].close;
  const i0 = idxClose.get(candles[i].date), i1 = idxClose.get(candles[i + k].date);
  if (!s0 || !s1 || !i0 || !i1) return null;
  return (s1 / s0 - 1) - (i1 / i0 - 1);
}

const STREAK_N = Number(process.env.STREAK_N ?? 3);
const events: Ev[] = [];
const baseline: Ev[] = []; // 同高檔位階、法人「沒有」連賣（streak < 2）

const files = fs.readdirSync(INST_DIR).filter((f) => /^\d{4}\.json$/.test(f)); // 4 碼個股，排除 ETF/權證
let used = 0;

for (const f of files) {
  const sym = f.replace('.json', '');
  let inst: { data: InstRow[] };
  try { inst = JSON.parse(fs.readFileSync(path.join(INST_DIR, f), 'utf8')); } catch { continue; }
  const candles = loadCandles(path.join(CANDLE_DIR, `${sym}.TW.json`)) ?? loadCandles(path.join(CANDLE_DIR, `${sym}.TWO.json`));
  if (!candles) continue;
  const totalByDate = new Map(inst.data.map((r) => [r.date, r.total]));
  used++;

  // 連賣 streak 逐日計（以 K 線日曆為準；法人資料缺日視為中斷）
  let streak = 0;
  for (let i = 60; i < candles.length - 20; i++) {
    const t = totalByDate.get(candles[i].date);
    if (t == null) { streak = 0; continue; }
    streak = t < 0 ? streak + 1 : 0;

    // 高檔 gate：收盤在近 60 根最高收盤的 90% 以上 且 近 60 根漲幅 ≥ 20%
    let hi60 = 0;
    for (let k = i - 60; k <= i; k++) hi60 = Math.max(hi60, candles[k].close);
    const gain60 = candles[i].close / candles[i - 60].close - 1;
    const isHigh = candles[i].close >= hi60 * 0.90 && gain60 >= 0.20;
    if (!isHigh) continue;

    const ev: Ev = { symbol: sym, date: candles[i].date, ex5: fwdExcess(candles, i, 5), ex20: fwdExcess(candles, i, 20) };
    if (streak === STREAK_N) events.push(ev);        // 首次達標日才計
    else if (streak === 0 && (totalByDate.get(candles[i].date) ?? 0) >= 0) {
      // 對照組抽樣：同高檔、今日法人買超或平（沒有在連賣）。抽 1/5 降樣本相關性。
      if (i % 5 === 0) baseline.push(ev);
    }
  }
}

function stats(list: Ev[], key: 'ex5' | 'ex20') {
  const v = list.map((e) => e[key]).filter((x): x is number => x != null);
  if (v.length === 0) return { n: 0, avg: NaN, winNeg: NaN };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const neg = v.filter((x) => x < 0).length / v.length; // 「避開正確率」＝事後真的輸大盤的比例
  return { n: v.length, avg: +(avg * 100).toFixed(2), winNeg: +(neg * 100).toFixed(1) };
}

const mid = '2024-10-01';
const seg = (list: Ev[], from: string, to: string) => list.filter((e) => e.date >= from && e.date < to);

console.log(`宇宙 ${used} 檔｜連賣門檻 ${STREAK_N} 天｜事件 ${events.length}｜對照(高檔無連賣) ${baseline.length}`);
for (const [label, ev, bl] of [
  ['train 2023-01~2024-09', seg(events, '2023-01-01', mid), seg(baseline, '2023-01-01', mid)],
  ['test  2024-10~2026-07', seg(events, mid, '2027-01-01'), seg(baseline, mid, '2027-01-01')],
  ['all', events, baseline],
] as const) {
  const e5 = stats(ev as Ev[], 'ex5'), e20 = stats(ev as Ev[], 'ex20');
  const b5 = stats(bl as Ev[], 'ex5'), b20 = stats(bl as Ev[], 'ex20');
  console.log(`\n[${label}]`);
  console.log(`  連賣組  D5 超額 ${e5.avg}%（跌率 ${e5.winNeg}%，n=${e5.n}）  D20 超額 ${e20.avg}%（跌率 ${e20.winNeg}%，n=${e20.n}）`);
  console.log(`  對照組  D5 超額 ${b5.avg}%（跌率 ${b5.winNeg}%，n=${b5.n}）  D20 超額 ${b20.avg}%（跌率 ${b20.winNeg}%，n=${b20.n}）`);
  console.log(`  差異    D5 ${(e5.avg - b5.avg).toFixed(2)}pp   D20 ${(e20.avg - b20.avg).toFixed(2)}pp（負=連賣組更弱=避雷有料）`);
}
