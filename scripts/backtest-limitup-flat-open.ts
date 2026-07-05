/**
 * 回測：直播課 2026-07-01 Q17「漲停買不到 → 隔日開平盤附近視同昨天買到」
 *
 * 三組對照（多頭股的漲停日，隔日開盤進場）：
 *   A 開平盤 ±1%   → 課程說「視同昨天買到，可買、守 −5%」
 *   B 開高 ≥5%     → 課程說「絕不追（隔日沖賣壓）」— 驗證是不是真的差
 *   C 全部漲停事件 → 背景基準
 *
 * 出場：課程紀律 −5% 停損（收盤確認）否則持有到 D10 收盤；另報 raw D5/D20。
 * 超額 = 個股 − ^TWII 同窗；train/test 對半切；含來回成本 0.6%（券商費+證交稅約略）。
 * 多頭 gate（輕量 proxy）：收盤 > MA20 且 MA20 上揚。
 */
import * as fs from 'fs';
import * as path from 'path';

const CANDLE_DIR = 'data/candles/TW';
const COST = 0.006; // 來回成本（0.1425%×2 折讓前 + 0.3% 稅，粗估）

interface Candle { date: string; open: number; high: number; low: number; close: number }

function load(file: string): Candle[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : j.candles;
    return Array.isArray(arr) && arr.length > 120 ? arr : null;
  } catch { return null; }
}

const idx = load(path.join(CANDLE_DIR, '^TWII.json'))!;
const idxClose = new Map(idx.map((c) => [c.date, c.close]));

interface Ev { date: string; group: 'A' | 'B' | 'C'; ex5: number | null; ex20: number | null; exStop: number | null }

function idxRet(d0: string, d1: string): number | null {
  const a = idxClose.get(d0), b = idxClose.get(d1);
  return a && b ? b / a - 1 : null;
}

const events: Ev[] = [];
const files = fs.readdirSync(CANDLE_DIR).filter((f) => /^\d{4}\.(TW|TWO)\.json$/.test(f));

for (const f of files) {
  const candles = load(path.join(CANDLE_DIR, f));
  if (!candles) continue;
  // MA20
  const ma20: number[] = new Array(candles.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= 20) sum -= candles[i - 20].close;
    if (i >= 19) ma20[i] = sum / 20;
  }
  for (let i = 60; i < candles.length - 22; i++) {
    const t = candles[i], prev = candles[i - 1];
    if (!prev.close || prev.close <= 0) continue;
    const chg = t.close / prev.close - 1;
    // 漲停：+9.5% 以上且收在最高（同 conditions.ts b_limitup 口徑）；排除處置分盤異常跳階 >11%
    if (chg < 0.095 || chg > 0.11 || t.close !== t.high) continue;
    // 多頭 proxy：收盤 > MA20 且 MA20 上揚
    if (!(t.close > ma20[i] && ma20[i] > ma20[i - 1])) continue;

    const next = candles[i + 1];
    const gap = next.open / t.close - 1;
    const group: Ev['group'] = Math.abs(gap) <= 0.01 ? 'A' : gap >= 0.05 ? 'B' : 'C';

    const entry = next.open;
    if (!entry || entry <= 0) continue;
    const dEntry = next.date;
    // raw D5 / D20（自進場日開盤起算，收盤結算）
    const mk = (k: number): number | null => {
      if (i + 1 + k >= candles.length) return null;
      const exit = candles[i + 1 + k].close;
      const ir = idxRet(dEntry, candles[i + 1 + k].date);
      return ir == null ? null : (exit / entry - 1) - ir - COST;
    };
    // −5% 停損版：收盤 ≤ entry×0.95 當日收盤出，否則 D10 收盤出
    let exStop: number | null = null;
    for (let k = 0; k <= 10 && i + 1 + k < candles.length; k++) {
      const c = candles[i + 1 + k];
      const isStop = c.close <= entry * 0.95;
      if (isStop || k === 10) {
        const ir = idxRet(dEntry, c.date);
        exStop = ir == null ? null : (c.close / entry - 1) - ir - COST;
        break;
      }
    }
    events.push({ date: dEntry, group, ex5: mk(5), ex20: mk(20), exStop });
  }
}

function stats(list: Ev[], key: 'ex5' | 'ex20' | 'exStop') {
  const v = list.map((e) => e[key]).filter((x): x is number => x != null);
  if (!v.length) return { n: 0, avg: NaN, win: NaN };
  return {
    n: v.length,
    avg: +((v.reduce((a, b) => a + b, 0) / v.length) * 100).toFixed(2),
    win: +((v.filter((x) => x > 0).length / v.length) * 100).toFixed(1),
  };
}

const mid = '2024-10-01';
console.log(`漲停事件（多頭股）共 ${events.length}｜A 開平盤±1% ${events.filter(e => e.group === 'A').length}｜B 開高≥5% ${events.filter(e => e.group === 'B').length}`);
for (const [label, from, to] of [['train 2023~2024-09', '2000-01-01', mid], ['test 2024-10~', mid, '2099-01-01'], ['all', '2000-01-01', '2099-01-01']] as const) {
  console.log(`\n[${label}]`);
  for (const g of ['A', 'B', 'C'] as const) {
    const list = events.filter((e) => e.group === g && e.date >= from && e.date < to);
    const s5 = stats(list, 'ex5'), s20 = stats(list, 'ex20'), st = stats(list, 'exStop');
    console.log(`  ${g}  停損版 ${st.avg}%（勝率 ${st.win}%）  D5 ${s5.avg}%  D20 ${s20.avg}%（勝率 ${s20.win}%）  n=${s20.n}`);
  }
}
