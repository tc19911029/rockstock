/**
 * backtest-elimination-extra.ts — C19 淘汰法補強回測對照（研究專用，不動正式線）
 *
 * 缺口（90-rockstock缺口待辦.md 進場-9 / id 進場-9）：
 *   - 淘汰6「連3天長黑」：生產 R6 只判「高檔 ≥2 次大量長黑」，沒有「連 3 根長黑」硬編。
 *   - 淘汰7「長期打底未突破大量壓力」：生產完全無 detector。
 *   - 淘汰13/R8「三大法人連續賣超」：缺逐日法人資料 → 本腳本標 pending，不實作。
 *
 * 目的：把「在現有六條件+戒律+生產淘汰法之上，再加這兩條 research-only 淘汰」
 *       做成對照組，量「被新規則剔除的候選」事後報酬是否較差（＝剔對了＝有避雷 edge）。
 *
 * ★ 不 import 任何生產 gate 的「修改版」；evaluateElimination 仍是生產原檔（唯讀）。
 *   兩條新規則就地實作為純函式（research-only），正式 scan 行為位元不變。
 *
 * 方法（對齊 compute-honest-edge / factor-grid-search 口徑）：
 *   1. 全市場 TW 日K（窗預設 2024-01-01 起），每天每檔跑：
 *      六條件(totalScore≥minScore) → 戒律(checkLongProhibitions) → 生產淘汰(evaluateElimination)
 *      = baseline 候選池（與生產 Step1 後段一致的近似）。
 *   2. 對 baseline 候選再跑兩條 research 淘汰：
 *      - kept（兩條都沒命中）vs elimByR6（連3長黑命中）vs elimByR7（長期打底未突破命中）。
 *   3. 進場＝隔日開盤（無前視）；前瞻 dN＝收盤 vs 進場開盤；
 *      超額＝候選 − 同訊號日 ^TWII 視窗對齊前瞻；扣來回成本 0.585%。
 *   4. 依訊號日中位切 train/test，兩半都要站得住。
 *
 * 判準（北極星：賺多賠少）：
 *   - 若「被剔除組」前瞻報酬 < 「保留組」且 train/test 一致 → 新淘汰有避雷價值。
 *   - 若整池（baseline）報酬 vs baseline−新淘汰 幾乎不變 → 新淘汰只是噪音、不值得進生產。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" FROM=2024-01-01 npx tsx scripts/backtest-elimination-extra.ts
 *   小樣本快跑：MAX_SYMBOLS=120 npx tsx scripts/backtest-elimination-extra.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';
import { FEE_RATES } from '@/lib/portfolio/fees';
import type { CandleWithIndicators } from '@/types';

const MARKET = 'TW' as const;
const INDEX_SYMBOL = '^TWII';
const ROOT = path.join(process.cwd(), 'data');
const FROM = process.env.FROM ?? '2024-01-01';
const MAX_SYMBOLS = process.env.MAX_SYMBOLS ? parseInt(process.env.MAX_SYMBOLS, 10) : Infinity;
const MIN_PRICE = 5;
const MIN_VOL_LOTS = 500; // 張（= 500 * 1000 股? 本地量單位多為張，沿用 entry-k-tiers 約定）
const HORIZONS = ['d1', 'd3', 'd5', 'd10', 'd20'] as const;
const OFFSET: Record<typeof HORIZONS[number], number> = { d1: 1, d3: 3, d5: 5, d10: 10, d20: 20 };
const ROUND_TRIP_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100; // 0.585%

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

function loadCandles(symbol: string): RawCandle[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'candles', MARKET, `${symbol}.json`), 'utf-8'));
    const arr = Array.isArray(raw) ? raw : raw.candles ?? [];
    return arr
      .map((c: Record<string, unknown>) => ({
        date: String(c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0, high: Number(c.high) || 0,
        low: Number(c.low) || 0, close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      }))
      .filter((c: RawCandle) => c.date)
      .sort((a: RawCandle, b: RawCandle) => a.date.localeCompare(b.date));
  } catch { return null; }
}

function listSymbols(): string[] {
  const dir = path.join(ROOT, 'candles', MARKET);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .filter(s => s !== INDEX_SYMBOL && !s.startsWith('^'));
}

// ── research-only 淘汰規則（不進生產，正式 scan 不走） ──────────────────────

/**
 * 研究淘汰6：連 3 天長黑（書本硬編，生產 R6 缺）
 * 定義：idx、idx-1、idx-2 三根都是黑K（close<open）且實體 ≥2%（長黑）。
 * 與生產 R6（高檔 ≥2 次大量長黑）正交：這條只看「連續性」不要求量、不要求高檔。
 */
function researchR6_threeLongBlacks(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 2) return false;
  for (let k = 0; k < 3; k++) {
    const c = candles[idx - k];
    if (!(c.close < c.open)) return false;
    if (c.open <= 0) return false;
    if (Math.abs(c.close - c.open) / c.open < 0.02) return false; // 長黑 ≥2%
  }
  return true;
}

/**
 * 研究淘汰7：長期打底，未突破上方大量壓力
 * 書本（CH5-03）：長期盤整打底的股票，上方有「大量套牢區（大量壓力）」，
 *   在「突破該大量壓力」之前不要進場（會卡在壓力下盤整）。
 * 操作化：
 *   - 長期打底：近 LOOKBACK(=120) 天屬低波盤整（區間振幅 (max-min)/min < BASE_RANGE=0.35）。
 *   - 大量壓力：LOOKBACK 內存在「量 ≥ 區間均量 * VOL_MULT(=2)」的大量根，取其 high 為壓力價。
 *   - 未突破：今日 close < 該大量壓力 high * (1 - BREAK_MARGIN=0.005)（仍在壓力下方）。
 *  三者皆成立 → 命中（屬「卡在大量壓力下的長期打底」，書本要避）。
 */
function researchR7_baseUnbrokenResistance(candles: CandleWithIndicators[], idx: number): boolean {
  const LOOKBACK = 120;
  const BASE_RANGE = 0.35;
  const VOL_MULT = 2.0;
  const BREAK_MARGIN = 0.005;
  if (idx < LOOKBACK) return false;
  const win = candles.slice(idx - LOOKBACK, idx); // 不含今日
  if (win.length < LOOKBACK) return false;
  const lows = win.map(c => c.low).filter(x => x > 0);
  const highs = win.map(c => c.high).filter(x => x > 0);
  if (!lows.length || !highs.length) return false;
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  if (lo <= 0) return false;
  // 長期打底：低波盤整
  if ((hi - lo) / lo >= BASE_RANGE) return false;
  // 大量壓力：找區間內大量根
  const vols = win.map(c => c.volume).filter(v => v > 0);
  if (vols.length < 20) return false;
  const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
  let resistHigh = 0;
  for (const c of win) {
    if (c.volume >= avgVol * VOL_MULT && c.high > resistHigh) resistHigh = c.high;
  }
  if (resistHigh <= 0) return false;
  // 今日仍未突破該大量壓力
  const today = candles[idx];
  return today.close < resistHigh * (1 - BREAK_MARGIN);
}

// ── forward-return 統計 ────────────────────────────────────────────────────

interface Sample { date: string; ret: Record<typeof HORIZONS[number], number | null> } // 候選 raw 報酬（%）

function fwdReturns(candles: RawCandle[], t0: number): Record<typeof HORIZONS[number], number | null> {
  const out = {} as Record<typeof HORIZONS[number], number | null>;
  const entry = candles[t0 + 1];
  for (const h of HORIZONS) out[h] = null;
  if (!entry || !(entry.open > 0)) return out;
  for (const h of HORIZONS) {
    const c = candles[t0 + OFFSET[h]];
    if (c && c.close > 0) out[h] = (c.close - entry.open) / entry.open * 100;
  }
  return out;
}

// 指數逐日前瞻（進場日 → 同口徑），用於逐筆超額對齊
function buildIndexForward(candles: RawCandle[]): Map<string, Record<typeof HORIZONS[number], number | null>> {
  const m = new Map<string, Record<typeof HORIZONS[number], number | null>>();
  for (let t0 = 0; t0 < candles.length; t0++) {
    m.set(candles[t0].date, fwdReturns(candles, t0));
  }
  return m;
}

function main(): void {
  console.log(`[C19 淘汰補強] market=${MARKET} from=${FROM} cost(來回)=${ROUND_TRIP_PCT.toFixed(3)}%`);
  const idxRaw = loadCandles(INDEX_SYMBOL);
  if (!idxRaw) { console.error('找不到指數', INDEX_SYMBOL); process.exit(1); }
  const idxFwd = buildIndexForward(idxRaw);

  let symbols = listSymbols();
  if (Number.isFinite(MAX_SYMBOLS)) symbols = symbols.slice(0, MAX_SYMBOLS as number);
  console.log(`掃描 ${symbols.length} 檔...`);

  // 三組樣本：baseline 全候選、kept(新淘汰都沒命中)、elimR6、elimR7、elimEither
  const groups = {
    baseline: [] as Sample[],
    kept: [] as Sample[],
    elimR6: [] as Sample[],
    elimR7: [] as Sample[],
    elimEither: [] as Sample[],
  };
  // 寬鬆宇宙（所有具流動性日，不過六條件/戒律/生產淘汰）— 給 R6/R7 當「純避雷訊號」公平測試
  // 書本淘汰法本意是套在 watchlist 全集，不是只套在已過六條件的多頭股；baseline 裡 R6 幾乎不存在
  const loose = {
    universe: [] as Sample[],   // 所有具流動性日（基準）
    looseR6: [] as Sample[],    // 連3長黑當天 → 隔日進場
    looseR7: [] as Sample[],    // 長期打底未破壓當天 → 隔日進場
  };

  let scanned = 0;
  for (const sym of symbols) {
    const raw = loadCandles(sym);
    if (!raw || raw.length < 130) continue;
    let ind: CandleWithIndicators[];
    try { ind = computeIndicators(raw) as CandleWithIndicators[]; } catch { continue; }
    scanned++;

    for (let idx = 0; idx < ind.length; idx++) {
      const c = ind[idx];
      if (c.date < FROM) continue;
      if (idx < 120) continue;            // 需深歷史做指標 + R7 lookback
      if (idx + 1 >= ind.length) continue; // 要有隔日開盤
      if (c.close < MIN_PRICE) continue;
      if ((c.volume ?? 0) < MIN_VOL_LOTS) continue;

      // ── 寬鬆宇宙：所有具流動性日，R6/R7 當純避雷訊號公平測試（不過任何選股 gate）──
      {
        const ret = fwdReturns(raw, idx);
        const s: Sample = { date: c.date, ret };
        loose.universe.push(s);
        if (researchR6_threeLongBlacks(ind, idx)) loose.looseR6.push(s);
        if (researchR7_baseUnbrokenResistance(ind, idx)) loose.looseR7.push(s);
      }

      // baseline gate：六條件 + 戒律 + 生產淘汰
      let six;
      try { six = evaluateSixConditions(ind, idx); } catch { continue; }
      if (six.totalScore < BASE_THRESHOLDS.minScore) continue;
      let prohib;
      try { prohib = checkLongProhibitions(ind, idx); } catch { continue; }
      if (prohib.prohibited) continue;
      let elim;
      try { elim = evaluateElimination(ind, idx); } catch { continue; }
      if (elim.eliminated) continue;

      // 到這裡 = baseline 候選（生產會留下的）
      const ret = fwdReturns(raw, idx);
      const sample: Sample = { date: c.date, ret };
      groups.baseline.push(sample);

      const hitR6 = researchR6_threeLongBlacks(ind, idx);
      const hitR7 = researchR7_baseUnbrokenResistance(ind, idx);
      if (hitR6) groups.elimR6.push(sample);
      if (hitR7) groups.elimR7.push(sample);
      if (hitR6 || hitR7) groups.elimEither.push(sample);
      else groups.kept.push(sample);
    }
  }
  console.log(`有效掃描 ${scanned} 檔；baseline 候選 ${groups.baseline.length} 筆`);

  // 切 train/test（依訊號日中位）
  const allDates = groups.baseline.map(s => s.date).sort();
  const mid = allDates.length ? allDates[Math.floor(allDates.length / 2)] : FROM;
  console.log(`train/test 切點 = ${mid}`);

  // 聚合：對每組算「淨超額（扣成本、減同訊號日指數前瞻）」與勝率
  type Agg = { n: number; net: Record<typeof HORIZONS[number], number | null>; win: Record<typeof HORIZONS[number], number | null> };
  function agg(samples: Sample[]): Agg {
    const net = {} as Record<typeof HORIZONS[number], number | null>;
    const win = {} as Record<typeof HORIZONS[number], number | null>;
    for (const h of HORIZONS) {
      const exc: number[] = [];
      let winN = 0, tot = 0;
      for (const s of samples) {
        const r = s.ret[h];
        const idxR = idxFwd.get(s.date)?.[h];
        if (r == null || idxR == null) continue;
        const e = r - idxR - ROUND_TRIP_PCT; // 淨超額（扣成本）
        exc.push(e);
        tot++;
        if (e > 0) winN++;
      }
      net[h] = exc.length ? +(exc.reduce((a, b) => a + b, 0) / exc.length).toFixed(3) : null;
      win[h] = tot ? +(winN / tot * 100).toFixed(1) : null;
    }
    return { n: samples.length, net, win };
  }

  function splitAgg(samples: Sample[]) {
    return {
      all: agg(samples),
      train: agg(samples.filter(s => s.date < mid)),
      test: agg(samples.filter(s => s.date >= mid)),
    };
  }

  const out = {
    baseline: splitAgg(groups.baseline),
    keptAfterNewElim: splitAgg(groups.kept),       // baseline − 新淘汰命中 = 加新淘汰後的池子
    elimR6: splitAgg(groups.elimR6),
    elimR7: splitAgg(groups.elimR7),
    elimEither: splitAgg(groups.elimEither),
  };

  // 報表
  const fmt = (v: number | null) => v == null ? ' n/a' : (v >= 0 ? '+' : '') + v.toFixed(2);
  function row(label: string, sa: ReturnType<typeof splitAgg>) {
    const a = sa.all, tr = sa.train, te = sa.test;
    console.log(
      `${label.padEnd(22)} n=${String(a.n).padStart(6)} | ` +
      `d5淨超額 ${fmt(a.net.d5)}%/勝${fmt(a.win.d5)}% | ` +
      `d20 ${fmt(a.net.d20)}% | train d5 ${fmt(tr.net.d5)}% → test d5 ${fmt(te.net.d5)}%`
    );
  }
  console.log('\n========== 各組 淨超額（扣成本、減同訊號日指數前瞻） ==========');
  row('baseline 全候選', out.baseline);
  row('加新淘汰後池(kept)', out.keptAfterNewElim);
  console.log('  ↓ 被新規則剔除的（報酬越差＝剔對了＝避雷有料）');
  row('  R6 連3長黑(剔除組)', out.elimR6);
  row('  R7 打底未破壓(剔除組)', out.elimR7);
  row('  R6∪R7(剔除組)', out.elimEither);

  // 差值：加淘汰後 vs baseline（>0 = 池子報酬被改善）
  console.log('\n========== 加新淘汰是否改善池子（kept − baseline）==========');
  for (const h of HORIZONS) {
    const b = out.baseline.all.net[h], k = out.keptAfterNewElim.all.net[h];
    const bt = out.baseline.train.net[h], kt = out.keptAfterNewElim.train.net[h];
    const bte = out.baseline.test.net[h], kte = out.keptAfterNewElim.test.net[h];
    const d = (b != null && k != null) ? +(k - b).toFixed(3) : null;
    const dtr = (bt != null && kt != null) ? +(kt - bt).toFixed(3) : null;
    const dte = (bte != null && kte != null) ? +(kte - bte).toFixed(3) : null;
    console.log(`  ${h}: 全 ${fmt(d)}pp | train ${fmt(dtr)}pp → test ${fmt(dte)}pp`);
  }

  // ── 寬鬆宇宙：R6/R7 當「純避雷訊號」測試（書本本意套全 watchlist）──
  const looseOut = {
    universe: splitAgg(loose.universe),
    looseR6: splitAgg(loose.looseR6),
    looseR7: splitAgg(loose.looseR7),
  };
  console.log('\n========== 寬鬆宇宙：純避雷訊號（全流動性日為基準；訊號組報酬 < 基準＝避雷有料）==========');
  row('全流動性日(基準)', looseOut.universe);
  row('  R6 連3長黑(訊號)', looseOut.looseR6);
  row('  R7 打底未破壓(訊號)', looseOut.looseR7);
  console.log('  差值（訊號 − 基準；<0 = 訊號日後較差＝該避開）');
  for (const [name, sa] of [['R6', looseOut.looseR6], ['R7', looseOut.looseR7]] as const) {
    const parts: string[] = [];
    for (const h of HORIZONS) {
      const b = looseOut.universe.all.net[h], s = sa.all.net[h];
      const bt = looseOut.universe.train.net[h], st = sa.train.net[h];
      const bte = looseOut.universe.test.net[h], ste = sa.test.net[h];
      const d = (b != null && s != null) ? +(s - b).toFixed(3) : null;
      const dtr = (bt != null && st != null) ? +(st - bt).toFixed(3) : null;
      const dte = (bte != null && ste != null) ? +(ste - bte).toFixed(3) : null;
      if (h === 'd5') parts.push(`d5 全${fmt(d)}pp train${fmt(dtr)}→test${fmt(dte)}`);
      if (h === 'd20') parts.push(`d20 全${fmt(d)}pp train${fmt(dtr)}→test${fmt(dte)}`);
    }
    console.log(`    ${name}: ${parts.join(' | ')}`);
  }

  const outDir = path.join(ROOT, 'agents', 'backtest');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'elimination-extra.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    market: MARKET, from: FROM, costRoundTripPct: ROUND_TRIP_PCT,
    trainTestSplit: mid, scannedSymbols: scanned,
    note: 'research-only 淘汰6(連3長黑)/淘汰7(長期打底未破大量壓力); R8法人連賣 pending(缺逐日資料); 不動生產 eliminationFilter',
    groups: out,
    looseUniverse: looseOut,
  }, null, 2));
  console.log(`\n寫入 ${outFile}`);
}

main();
