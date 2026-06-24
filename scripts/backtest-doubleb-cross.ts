// ============================================================
// 雙B戰法 — 「站上兩條線」正確定義回測
//
// 「雙B」= 兩個 B，每個 B 是一次「站上線」：
//   B① 站上智能交易線(zhineng)        ＝ 收盤 > zhineng
//   B② 站上紅黃線(zb4 黃 / zb5 紅)     ＝ 收盤 > 黃且 > 紅（紅黃當一組要兩條都站上）
//   雙B 成立 ＝ B① 且 B② 同時站上。
//
// 進場觸發 ＝「由非雙B 翻成雙B 的那天」（價格新站上兩條線）。
//
// 為了看出「少掉那個 B 有沒有用」，同時對照：
//   單B-智能：只看新站上智能線（＝舊 b_break）
//   單B-紅黃：只看新站上紅黃線
//   雙B     ：兩條都新站上（站上其中一條時、另一條已在上方）
//
// 指標公式直接複用 lib/cn-sanse/tdx 原生函式，與走圖/掃描同一事實來源：
//   ZB      = (C+H+O+L)/4
//   zhineng = HHV(ZB,13) * 0.95            智能交易線
//   ZB3     = (3C+O+L+H)/6
//   zb4     = 20日線性加權(ZB3)            黃線
//   zb5     = MA(zb4,6)                    紅線
//   ma60    = MA(C,60)                     多空線（濾網用）
//
// 進場：訊號日隔日開盤；報酬 = (後續收盤 − 進場開盤)/進場開盤。
// 研究腳本，不動正式選股鏈路（CLAUDE.md rule #5/#10）。
//
// 用法：
//   npx tsx scripts/backtest-doubleb-cross.ts            # 有 data/candles 用全市場，否則 fixtures 示範
//   npx tsx scripts/backtest-doubleb-cross.ts TW         # 指定市場（data/candles/TW）
//   npx tsx scripts/backtest-doubleb-cross.ts CN
//   npx tsx scripts/backtest-doubleb-cross.ts fixtures   # 強制用 fixtures 示範
//   旗標：--above60  只取「站上多空線(MA60)」的訊號（順勢濾網）
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { HHV, MA, mul, isNum } from '@/lib/cn-sanse/tdx';
import type { Candle } from '@/types';

const ZB4_WEIGHTS = (() => {
  const w = new Array(21).fill(0);
  for (let lag = 0; lag <= 18; lag++) w[lag] = 20 - lag;
  w[20] = 1;
  return w; // sum = 210
})();

interface Lines { zhineng: number[]; zb4: number[]; zb5: number[]; ma60: number[] }

function computeLines(candles: Candle[]): Lines {
  const n = candles.length;
  const C = candles.map((c) => c.close);
  const ZB = candles.map((c) => (c.close + c.high + c.open + c.low) / 4);
  const zhineng = mul(HHV(ZB, 13), 0.95);
  const ZB3 = candles.map((c) => (3 * c.close + c.open + c.low + c.high) / 6);
  const zb4 = new Array(n).fill(NaN);
  for (let i = 20; i < n; i++) {
    let s = 0;
    for (let lag = 0; lag <= 20; lag++) s += ZB4_WEIGHTS[lag] * ZB3[i - lag];
    zb4[i] = s / 210;
  }
  const zb5 = MA(zb4, 6);
  const ma60 = MA(C, 60);
  return { zhineng, zb4, zb5, ma60 };
}

// 三種訊號：兩種單B 各一條線，雙B 是兩條都新站上
type Variant = 'b_smart' | 'b_yr' | 'dual';
const VARIANTS: { key: Variant; label: string }[] = [
  { key: 'b_smart', label: '單B｜新站上智能線' },
  { key: 'b_yr', label: '單B｜新站上紅黃線' },
  { key: 'dual', label: '雙B｜兩條都站上' },
];

const HOLD = [10, 20, 40] as const;
interface Trade { d: Record<number, number | null>; maxGain: number | null; maxLoss: number | null; above60: boolean }

function backtestStock(candles: Candle[], variant: Variant): Trade[] {
  const { zhineng, zb4, zb5, ma60 } = computeLines(candles);
  const n = candles.length;
  const C = candles.map((c) => c.close);

  // 每日「站上」狀態
  const aboveSmart: boolean[] = new Array(n).fill(false); // 站上智能線
  const aboveYR: boolean[] = new Array(n).fill(false);    // 站上紅黃線（黃且紅都站上）
  const aboveBoth: boolean[] = new Array(n).fill(false);  // 雙B 狀態
  for (let i = 0; i < n; i++) {
    aboveSmart[i] = isNum(zhineng[i]) && C[i] > zhineng[i];
    aboveYR[i] = isNum(zb4[i]) && isNum(zb5[i]) && C[i] > zb4[i] && C[i] > zb5[i];
    aboveBoth[i] = aboveSmart[i] && aboveYR[i];
  }
  // 觸發 = 由 false 翻成 true 的那天（新站上）
  const stateOf = (i: number): boolean =>
    variant === 'b_smart' ? aboveSmart[i] : variant === 'b_yr' ? aboveYR[i] : aboveBoth[i];

  const trades: Trade[] = [];
  for (let i = 1; i < n; i++) {
    if (!(stateOf(i) && !stateOf(i - 1))) continue; // 新站上才進場
    const entryIdx = i + 1;            // 隔日開盤進場
    if (entryIdx >= n) continue;
    const entry = candles[entryIdx].open;
    if (!isNum(entry) || entry <= 0) continue;
    const d: Record<number, number | null> = {};
    for (const h of HOLD) {
      const exitIdx = entryIdx + h - 1;
      d[h] = exitIdx < n ? +(((candles[exitIdx].close - entry) / entry) * 100).toFixed(2) : null;
    }
    let hi = -Infinity, lo = Infinity;
    const last = Math.min(n - 1, entryIdx + 10 - 1);
    for (let j = entryIdx; j <= last; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    const maxGain = hi > -Infinity ? +(((hi - entry) / entry) * 100).toFixed(2) : null;
    const maxLoss = lo < Infinity ? +(((lo - entry) / entry) * 100).toFixed(2) : null;
    const above60 = isNum(ma60[i]) && C[i] > ma60[i];
    trades.push({ d, maxGain, maxLoss, above60 });
  }
  return trades;
}

function summarize(trades: Trade[]) {
  const row: Record<string, string> = { n: String(trades.length) };
  for (const h of HOLD) {
    const vals = trades.map((t) => t.d[h]).filter((v): v is number => v != null);
    if (!vals.length) { row[`d${h}`] = '—'; continue; }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const win = (vals.filter((v) => v > 0).length / vals.length) * 100;
    row[`d${h}`] = `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% (勝${win.toFixed(0)}%, n=${vals.length})`;
  }
  const mg = trades.map((t) => t.maxGain).filter((v): v is number => v != null);
  const ml = trades.map((t) => t.maxLoss).filter((v): v is number => v != null);
  row.maxGain = mg.length ? `+${(mg.reduce((a, b) => a + b, 0) / mg.length).toFixed(2)}%` : '—';
  row.maxLoss = ml.length ? `${(ml.reduce((a, b) => a + b, 0) / ml.length).toFixed(2)}%` : '—';
  return row;
}

function loadCandleSet(arg: string): { source: string; stocks: { symbol: string; candles: Candle[] }[] } {
  const root = process.cwd();
  const tryDir = (m: string) => path.join(root, 'data', 'candles', m);
  let dir = '';
  let fromFixtures = false;
  if (arg === 'fixtures') { fromFixtures = true; }
  else if (arg === 'TW' || arg === 'CN') {
    dir = tryDir(arg);
    if (!existsSync(dir)) { console.warn(`[警告] ${dir} 不存在 → 改用 fixtures 示範`); fromFixtures = true; }
  } else {
    // auto
    if (existsSync(tryDir('TW'))) dir = tryDir('TW');
    else if (existsSync(tryDir('CN'))) dir = tryDir('CN');
    else fromFixtures = true;
  }

  if (fromFixtures) {
    const fdir = path.join(root, '__tests__', 'fixtures', 'candles');
    const files = readdirSync(fdir).filter((f) => f.endsWith('.json'));
    const stocks = files.map((f) => {
      const j = JSON.parse(readFileSync(path.join(fdir, f), 'utf8'));
      return { symbol: j.symbol ?? f.replace('.json', ''), candles: (j.candles ?? j) as Candle[] };
    }).filter((s) => Array.isArray(s.candles) && s.candles.length > 60);
    return { source: `fixtures (${stocks.length} 檔示範，非全市場)`, stocks };
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const stocks = files.map((f) => {
    const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    return { symbol: j.symbol ?? f.replace('.json', ''), candles: (j.candles ?? []) as Candle[] };
  }).filter((s) => Array.isArray(s.candles) && s.candles.length > 60);
  return { source: `${dir} (${stocks.length} 檔)`, stocks };
}

function main() {
  const args = process.argv.slice(2);
  const above60Only = args.includes('--above60');
  const arg = args.find((a) => !a.startsWith('--')) ?? 'auto';
  const { source, stocks } = loadCandleSet(arg);

  console.log(`\n雙B戰法回測 — 站上兩條線（智能線 + 紅黃線）`);
  console.log(`資料源：${source}`);
  console.log(`進場：訊號日隔日開盤｜持有：10/20/40 交易日收盤｜maxGain/Loss：10 日窗最高/最低`);
  if (above60Only) console.log(`濾網：僅取「站上多空線(MA60)」的訊號`);
  console.log('');

  for (const v of VARIANTS) {
    const all: Trade[] = [];
    for (const s of stocks) {
      let trades = backtestStock(s.candles, v.key);
      if (above60Only) trades = trades.filter((t) => t.above60);
      all.push(...trades);
    }
    const sum = summarize(all);
    console.log(`■ ${v.label}`);
    const holdStr = HOLD.map((h) => `${h}日 ${sum[`d${h}`]}`).join('｜');
    console.log(`   訊號數 ${sum.n}｜${holdStr}｜平均最高 ${sum.maxGain}｜平均最低 ${sum.maxLoss}`);
  }
  console.log('');
  console.log('> 雙B vs 單B 並排：若「雙B」勝率/期望優於兩個單B，代表那個「多出來的 B」確實有過濾作用。');
  console.log('> fixtures 為小樣本僅供跑通驗證；勝率結論以 data/candles/{TW,CN} 全市場為準。');
}

main();
