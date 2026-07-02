/**
 * C21 紅K三級接 gate — 研究專用回測（不動正式線）
 *
 * 缺口（小修-2）：lib/rules/ruleUtils.ts 已定義 isMaxBullishCandle(≥6.5%)/isMediumRed(3.5%–6.5%)
 * 但沒接進任何 gate；生產選股的「進場K」仍用較鬆的 ≥2% isLongRedCandle/isMedLongRed。
 * 書本 CH2-04/2-05 K 棒三級制：小棒 / 中棒(3.5%) / 最大棒(6.5%)。
 * 2% 也有書本依據（短線做多 SOP 進場K），所以這是「收緊測試」：看把進場K門檻拉高
 * 有沒有換到更好的前瞻報酬 / 勝率，還是只是砍候選數沒換到 edge。
 *
 * 本腳本「不接生產 gate」——只是把同一個進場K門檻當成過濾器，跑歷史前瞻報酬對照。
 * 不 import 任何生產 scanner / applyPanelFilter；門檻邏輯就地複刻 ruleUtils 的三級制定義，
 * 與 lib/analysis/bookThresholds.ts 的 MAX_CANDLE_BODY_PCT=0.065 / MEDIUM_CANDLE_BODY_MIN=0.035 對齊。
 *
 * 方法（對齊 compute-honest-edge / unifiedLeaderboard 口徑）：
 *   - 訊號日 t0 = 一根「收紅且實體 ≥ 門檻」的進場K
 *   - 進場 = t0 隔一交易日「開盤」（無前視）
 *   - 前瞻報酬 dN = (t0+N 收盤 − 進場開盤) / 進場開盤
 *   - 淨報酬 = 前瞻報酬 − 來回成本 0.585%（TW 手續費×2＋證交稅）
 *   - 超額 = 候選 dN − 同訊號日 ^TWII 視窗平均 dN（剝大盤 beta）
 *   - train/test：以中位日期切兩半，要兩半同號才算有 edge
 *
 * 變體（門檻）：
 *   A_ge2     現狀生產門檻：收紅且實體 ≥ 2%（isLongRedCandle/isMedLongRed）
 *   B_medium  中棒：3.5% ≤ 實體 < 6.5%（isMediumRed，純中棒帶）
 *   C_max     最大棒：實體 ≥ 6.5%（isMaxBullishCandle）
 *   BC_ge3p5  收緊版 gate：實體 ≥ 3.5%（中棒∪最大棒，= 把 gate 從 2% 拉到 3.5%）
 *
 * Usage:
 *   npx tsx scripts/backtest-entry-k-tiers.ts
 *   FROM=2024-01-01 TO=2026-06-18 MAX_SYMBOLS=400 npx tsx scripts/backtest-entry-k-tiers.ts
 *
 * 環境變數：
 *   FROM/TO        訊號日期窗（預設全部）
 *   MAX_SYMBOLS    只掃前 N 檔（依檔名排序，預設全掃；小樣本快跑用）
 *   MIN_PRICE      進場開盤最低價過濾（預設 5，剔雞蛋水餃避免百分比失真）
 *   MIN_VOL        訊號日最低成交量（張，預設 500，剔流動性死股）
 */

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CANDLE_DIR = path.join(ROOT, 'data', 'candles', 'TW');
const OUT_PATH = path.join(ROOT, 'data', 'agents', 'backtest', 'entry-k-tiers.json');

const FROM = process.env.FROM ?? '';
const TO = process.env.TO ?? '';
const MAX_SYMBOLS = process.env.MAX_SYMBOLS ? Number(process.env.MAX_SYMBOLS) : Infinity;
const MIN_PRICE = Number(process.env.MIN_PRICE ?? 5);
const MIN_VOL = Number(process.env.MIN_VOL ?? 500);

// 來回成本（%）：TW 手續費 0.1425%×2 + 證交稅 0.3% = 0.585%（對齊 compute-honest-edge）
const ROUND_TRIP_PCT = 0.585;

// 三級制門檻（對齊 lib/analysis/bookThresholds.ts；就地複刻，不 import 生產，純研究）
const GE2 = 0.02;
const MEDIUM_MIN = 0.035;
const MAX_MIN = 0.065;

const HORIZONS = [1, 3, 5, 10, 20] as const;
type Horizon = typeof HORIZONS[number];

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number }
interface CandleFile { candles: Candle[] }

type Variant = 'A_ge2' | 'B_medium' | 'C_max' | 'BC_ge3p5';
const VARIANTS: Variant[] = ['A_ge2', 'B_medium', 'C_max', 'BC_ge3p5'];

function bodyPct(c: Candle): number {
  return Math.abs(c.close - c.open) / c.open;
}
function isRed(c: Candle): boolean {
  return c.close > c.open;
}
function matchVariant(c: Candle, v: Variant): boolean {
  if (!isRed(c)) return false;
  const b = bodyPct(c);
  switch (v) {
    case 'A_ge2': return b >= GE2;
    case 'B_medium': return b >= MEDIUM_MIN && b < MAX_MIN;
    case 'C_max': return b >= MAX_MIN;
    case 'BC_ge3p5': return b >= MEDIUM_MIN;
  }
}

function loadCandles(file: string): Candle[] {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, file), 'utf8')) as CandleFile;
    return (f.candles ?? [])
      .map(c => ({
        date: String(c.date).slice(0, 10),
        open: Number(c.open) || 0, high: Number(c.high) || 0,
        low: Number(c.low) || 0, close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      }))
      .filter(c => c.date && c.open > 0 && c.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

// ── 指數視窗平均 dN（剝大盤 beta），按訊號日 t0 索引 ──
const indexCandles: Candle[] = (() => {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')) as CandleFile;
    return (f.candles ?? [])
      .map(c => ({ date: String(c.date).slice(0, 10), open: +c.open || 0, high: +c.high || 0, low: +c.low || 0, close: +c.close || 0, volume: +c.volume || 0 }))
      .filter(c => c.date).sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
})();
const indexByDate = new Map<string, number>();
indexCandles.forEach((c, i) => indexByDate.set(c.date, i));

/** 指數對某訊號日 t0 的前瞻 dN 報酬（隔日開盤進場），無資料回 null */
function indexForward(t0Date: string, n: number): number | null {
  const i = indexByDate.get(t0Date);
  if (i == null) return null;
  const entry = indexCandles[i + 1];
  const exit = indexCandles[i + n];
  if (!entry || !exit || !(entry.open > 0)) return null;
  return (exit.close - entry.open) / entry.open * 100;
}

interface Sample {
  date: string;
  code: string;
  bodyPct: number;
  entryOpen: number;
  fwd: Partial<Record<Horizon, number>>;      // 候選前瞻報酬（%）
  excess: Partial<Record<Horizon, number>>;    // 超額（%）= 候選 − 指數視窗平均
}

const samplesByVariant: Record<Variant, Sample[]> = {
  A_ge2: [], B_medium: [], C_max: [], BC_ge3p5: [],
};

function main() {
  const files = fs.readdirSync(CANDLE_DIR)
    .filter(f => /\.json$/.test(f) && !f.startsWith('^'))
    .sort();
  const useFiles = files.slice(0, MAX_SYMBOLS === Infinity ? files.length : MAX_SYMBOLS);

  // 先把指數每個日期×horizon 的視窗平均算好（所有股票共用，與 compute-honest-edge 不同：
  // 這裡用「同訊號日的指數前瞻」做點對點超額，比視窗平均更貼每筆進場時點）。
  console.log(`\n📊 C21 紅K三級進場gate 回測（研究專用，不動生產）`);
  console.log(`   掃 ${useFiles.length} 檔；窗 ${FROM || '全部'} → ${TO || '全部'}；MIN_PRICE=${MIN_PRICE} MIN_VOL=${MIN_VOL}`);
  console.log(`   進場=訊號日隔日開盤；前瞻 dN=收盤 vs 進場開盤；超額=候選−同日指數前瞻\n`);

  let scanned = 0;
  for (const file of useFiles) {
    const candles = loadCandles(file);
    if (candles.length < 25) continue;
    const code = file.replace(/\.(TW|TWO)\.json$/, '').replace(/\.json$/, '');
    scanned++;
    for (let t0 = 0; t0 < candles.length - 1; t0++) {
      const c = candles[t0];
      if (FROM && c.date < FROM) continue;
      if (TO && c.date > TO) continue;
      if (c.volume < MIN_VOL) continue;
      const entry = candles[t0 + 1];
      if (!entry || entry.open < MIN_PRICE) continue;

      // 對每個變體：若該訊號日符合門檻，記一筆
      for (const v of VARIANTS) {
        if (!matchVariant(c, v)) continue;
        const fwd: Partial<Record<Horizon, number>> = {};
        const excess: Partial<Record<Horizon, number>> = {};
        for (const n of HORIZONS) {
          const exit = candles[t0 + n];
          if (!exit || !(exit.close > 0)) continue;
          const r = (exit.close - entry.open) / entry.open * 100;
          fwd[n] = r;
          const idxR = indexForward(c.date, n);
          if (idxR != null) excess[n] = r - idxR;
        }
        if (Object.keys(fwd).length === 0) continue;
        samplesByVariant[v].push({ date: c.date, code, bodyPct: +(bodyPct(c) * 100).toFixed(2), entryOpen: entry.open, fwd, excess });
      }
    }
  }

  // ── 統計工具 ──
  const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  const median = (a: number[]) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const winRate = (a: number[]) => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;

  interface HStat { n: number; avgFwd: number; medFwd: number; win: number; avgExcess: number; netAvg: number; netExcess: number }
  function statsFor(samples: Sample[], n: Horizon): HStat {
    const fwd = samples.map(s => s.fwd[n]).filter((x): x is number => x != null);
    const exc = samples.map(s => s.excess[n]).filter((x): x is number => x != null);
    const avgFwd = mean(fwd);
    const avgExc = mean(exc);
    return {
      n: fwd.length,
      avgFwd: +avgFwd.toFixed(2),
      medFwd: +median(fwd).toFixed(2),
      win: +winRate(fwd).toFixed(1),
      avgExcess: +avgExc.toFixed(2),
      netAvg: +(avgFwd - ROUND_TRIP_PCT).toFixed(2),     // 扣成本後絕對淨報酬
      netExcess: +(avgExc - ROUND_TRIP_PCT).toFixed(2),  // 扣成本後淨超額（指數買持不扣成本）
    };
  }

  // train/test 切半（依訊號日中位）
  function splitDate(samples: Sample[]): string {
    const dates = [...new Set(samples.map(s => s.date))].sort();
    return dates[Math.floor(dates.length / 2)] ?? '';
  }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    config: { from: FROM || null, to: TO || null, maxSymbols: MAX_SYMBOLS === Infinity ? null : MAX_SYMBOLS, minPrice: MIN_PRICE, minVol: MIN_VOL, roundTripPct: ROUND_TRIP_PCT },
    scannedSymbols: scanned,
    variants: {},
  };

  const fmtPct = (n: number) => isNaN(n) ? '   —  ' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}`.padStart(7);

  console.log(`掃到 ${scanned} 檔有效歷史。\n`);
  console.log(`變體定義：A=≥2%(現狀)  B=中棒3.5~6.5%  C=最大棒≥6.5%  BC=收緊≥3.5%\n`);

  for (const v of VARIANTS) {
    const all = samplesByVariant[v];
    const split = splitDate(all);
    const train = all.filter(s => s.date < split);
    const test = all.filter(s => s.date >= split);
    console.log(`\n=== 變體 ${v} ===  總候選 ${all.length} 筆（train ${train.length} / test ${test.length}，切點 ${split}）`);
    console.log(`  horizon |    n   | 平均前瞻 | 中位 | 勝率  | 平均超額 | 淨超額(扣${ROUND_TRIP_PCT}%)`);
    const vh: Record<string, unknown> = {};
    for (const n of HORIZONS) {
      const all_s = statsFor(all, n);
      const tr = statsFor(train, n);
      const te = statsFor(test, n);
      // train/test 一致判定：超額同號且都 > 0 才算 pass（北極星：扣 beta 後真贏）
      const consistent = tr.avgExcess > 0 && te.avgExcess > 0 ? 'pass' :
        (tr.avgExcess < 0 && te.avgExcess < 0 ? 'both-neg' : 'split');
      console.log(`  d${String(n).padEnd(2)}     | ${String(all_s.n).padStart(5)} | ${fmtPct(all_s.avgFwd)}% | ${fmtPct(all_s.medFwd)}% | ${all_s.win.toFixed(0).padStart(3)}% | ${fmtPct(all_s.avgExcess)}% | ${fmtPct(all_s.netExcess)}%  [train ${fmtPct(tr.avgExcess)} / test ${fmtPct(te.avgExcess)} → ${consistent}]`);
      vh[`d${n}`] = { all: all_s, train: tr, test: te, consistent };
    }
    (report.variants as Record<string, unknown>)[v] = { totalSamples: all.length, splitDate: split, trainN: train.length, testN: test.length, horizons: vh };
  }

  // ── 對照摘要：收緊 vs 現狀，看砍多少候選、換到多少 edge ──
  console.log(`\n\n=== 收緊 vs 現狀 對照（d5，扣成本淨超額）===`);
  const d5 = (v: Variant) => statsFor(samplesByVariant[v], 5);
  const a = d5('A_ge2'), bc = d5('BC_ge3p5'), c = d5('C_max');
  console.log(`  A  ≥2%(現狀)   候選 ${a.n} 筆  淨超額 ${fmtPct(a.netExcess)}%  勝率 ${a.win}%`);
  console.log(`  BC ≥3.5%(收緊) 候選 ${bc.n} 筆  淨超額 ${fmtPct(bc.netExcess)}%  勝率 ${bc.win}%   候選保留 ${a.n ? (bc.n / a.n * 100).toFixed(0) : '—'}%`);
  console.log(`  C  ≥6.5%(最緊) 候選 ${c.n} 筆  淨超額 ${fmtPct(c.netExcess)}%  勝率 ${c.win}%   候選保留 ${a.n ? (c.n / a.n * 100).toFixed(0) : '—'}%`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n✅ 寫出 ${OUT_PATH}\n`);
}

main();
