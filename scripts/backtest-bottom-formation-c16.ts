/**
 * C16 底部反轉軌（黃金右腳 / 週線型態）研究專用回測
 *   缺口 id：進場-7、進場-8、進場-15
 *
 * 目的：把「規則已寫但沒接進主掃描」的底部型態做成 research 變體，量它們選到的股
 *   在「隔日開盤」進場後 d1/d5/d10/d20 的前瞻報酬 / 扣成本淨超額 / train-test 一致性，
 *   判斷有沒有真 edge、是否值得進主視圖（CLAUDE.md 升級規則：正 alpha 且不跌出現有前 20）。
 *
 * **完全不動生產**：本腳本直接 import 現有 production detector（goldenRightFoot /
 *   accumulationVolume / maBottomConfirm / detectWeeklyW），逐檔逐日呼叫，不改 MarketScanner、
 *   不註冊字母軌、不碰 scan-parity。進場-8 的「底部第③型」與「週線版底部型態」目前生產無 detector，
 *   在本腳本內以 research-only 純函式實作（只在這支腳本存在，正式線位元不變）。
 *
 * 變體：
 *   進場-7a 黃金右腳突破（goldenRightFoot，日線）
 *   進場-7b 草叢量（accumulationVolume，日線；WATCH 類，觀察是否有前瞻 edge）
 *   進場-7c 均線打底完成（maBottomConfirm，日線）
 *   進場-7*  三條任一命中（OR 聯集，模擬「底部反轉軌」整軌）
 *   進場-8   底部第③型：先黏月線醞釀一段再帶量突破（research-only）
 *   進場-15a 週線 W 底突破（detectWeeklyW，現有唯一週線型態 → 基準）
 *   進場-15b 週線黃金右腳（goldenRightFoot 跑在週 K 上，research-only 擴充）
 *
 * 北極星口徑（對齊 backtest-flatbottom-tightness.ts）：
 *   - 進場 = 觸發日「次一交易日開盤」（對齊實單，不用收盤）
 *   - 前瞻報酬 = (dN close − entry open) / entry open
 *   - 淨超額 = 策略報酬 − 同窗 ^TWII 買入持有報酬 − 來回成本（raw 含大盤 beta，不可當 alpha）
 *   - train/test：依觸發日中位數切兩段，兩段同口徑各算一次
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/backtest-bottom-formation-c16.ts [START] [END] [MAX_FILES]
 *   預設 START=2023-06-01 END=2026-05-20（留 20 日結算尾巴）；MAX_FILES 限制掃描檔數（快測用）
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { goldenRightFoot, accumulationVolume, maBottomConfirm } from '@/lib/rules/bottomFormationRules';
import { detectWeeklyW, aggregateDailyToWeekly, type WeeklyCandle } from '@/lib/selection/weeklyWPattern';
import { FEE_RATES } from '@/lib/portfolio/fees';
import type { CandleWithIndicators } from '@/types';

const START = process.argv[2] ?? '2023-06-01';
const END = process.argv[3] ?? '2026-05-20';
const MAX_FILES = process.argv[4] ? parseInt(process.argv[4], 10) : Infinity;
const HORIZONS = [1, 5, 10, 20] as const;
const ROUND_TRIP_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100; // 來回成本 %

const ROOT = path.join(process.cwd(), 'data');
const TW_DIR = path.join(ROOT, 'candles', 'TW');

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

function loadBars(file: string): Bar[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : raw.candles ?? [];
    return arr
      .map((c: Record<string, unknown>) => ({
        date: String(c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0, high: Number(c.high) || 0,
        low: Number(c.low) || 0, close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      }))
      .filter((c: Bar) => c.date && c.close > 0)
      .sort((a: Bar, b: Bar) => a.date.localeCompare(b.date));
  } catch { return []; }
}

// ── 指數：日期 → 收盤，用來算 buy&hold 超額 ─────────────────────────────────
const idxBars = loadBars(path.join(TW_DIR, '^TWII.json'));
const idxDates = idxBars.map(b => b.date);
function idxCloseOnOrAfter(date: string): { date: string; close: number } | null {
  let lo = 0, hi = idxDates.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (idxDates[m] >= date) { ans = m; hi = m - 1; } else lo = m + 1; }
  if (ans < 0) return null;
  return { date: idxDates[ans], close: idxBars[ans].close };
}
/** 指數同窗 buy&hold 報酬 %：entryDate 開盤近似用當日收盤、出場用 entry + N 交易日 close */
function idxHoldReturn(entryDate: string, holdBars: number): number | null {
  const e = idxCloseOnOrAfter(entryDate);
  if (!e) return null;
  const ei = idxDates.indexOf(e.date);
  if (ei < 0 || ei + holdBars >= idxBars.length) return null;
  const exit = idxBars[ei + holdBars].close;
  if (!(e.close > 0)) return null;
  return (exit - e.close) / e.close * 100;
}

// ── research-only 偵測器（只在本腳本存在，不進生產）─────────────────────────────

/**
 * 進場-8 底部第③型：反彈突破月線後「先黏月線橫盤醞釀」再帶量突破
 *   書本 CH5-04 第③型：股價打底後先沿月線（MA20）黏一段時間，量縮醞釀，再帶量突破前高。
 *   research 量化：
 *     1) 低檔：今日收盤偏離 MA60 不超過 +8%（仍在打底/初升段，不是高檔）
 *     2) 醞釀期：往前找 8~25 根，期間每根收盤都「貼著 MA20」(|close-ma20|/ma20 ≤ 6%)，
 *        且該段振幅小（區間高/低 ≤ 1.15，橫盤）
 *     3) 今日帶量突破醞釀區間高點：close > 區間高 且 量 ≥ avgVol5 × 1.5 且收長紅
 */
function detectStickMa20Breakout(c: CandleWithIndicators[], index: number): boolean {
  if (index < 65) return false;
  const cur = c[index];
  if (cur.ma20 == null || cur.ma60 == null || cur.avgVol5 == null) return false;
  // 1) 低檔（不是高檔追價）
  if (cur.close > cur.ma60 * 1.08) return false;
  // 3a) 今日帶量長紅
  const body = Math.abs(cur.close - cur.open) / cur.open;
  if (!(cur.close > cur.open && body >= 0.02)) return false;
  if (cur.volume < cur.avgVol5 * 1.5) return false;

  // 2) 找醞釀期：index-1 往前數，連續貼 MA20 的根數
  let stick = 0;
  let rangeHigh = -Infinity, rangeLow = Infinity;
  for (let i = index - 1; i >= Math.max(0, index - 30); i--) {
    const b = c[i];
    if (b.ma20 == null) break;
    const dev = Math.abs(b.close - b.ma20) / b.ma20;
    if (dev > 0.06) break;          // 脫離月線，醞釀期結束
    stick++;
    rangeHigh = Math.max(rangeHigh, b.high);
    rangeLow = Math.min(rangeLow, b.low);
  }
  if (stick < 8 || stick > 25) return false;       // 醞釀 8~25 根
  if (!(rangeLow > 0) || rangeHigh / rangeLow > 1.15) return false; // 橫盤窄幅
  // 3b) 今日突破醞釀區間高
  if (cur.close <= rangeHigh) return false;
  return true;
}

/** 把週 K 線（WeeklyCandle）轉成可餵 computeIndicators 的 Bar（用 weekEnd 當 date）。 */
function weeklyToBars(weekly: WeeklyCandle[]): Bar[] {
  return weekly.map(w => ({
    date: w.weekEnd, open: w.open, high: w.high, low: w.low, close: w.close, volume: w.volume,
  }));
}

// ── 變體定義 ──────────────────────────────────────────────────────────────────
interface Variant {
  id: string;
  label: string;
  // 回 true = 在第 index 根（日線）觸發；entry 永遠取日線 index+1 開盤
  hit: (ci: CandleWithIndicators[], index: number, weeklyCi: CandleWithIndicators[] | null, weekEndIdx: Map<string, number>) => boolean;
}

const VARIANTS: Variant[] = [
  { id: '進場-7a', label: '黃金右腳突破(日)', hit: (ci, i) => goldenRightFoot.evaluate(ci, i) != null },
  { id: '進場-7b', label: '草叢量(日)', hit: (ci, i) => accumulationVolume.evaluate(ci, i) != null },
  { id: '進場-7c', label: '均線打底完成(日)', hit: (ci, i) => maBottomConfirm.evaluate(ci, i) != null },
  {
    id: '進場-7*', label: '底部反轉軌OR(7a∪7b∪7c)',
    hit: (ci, i) => goldenRightFoot.evaluate(ci, i) != null
      || accumulationVolume.evaluate(ci, i) != null
      || maBottomConfirm.evaluate(ci, i) != null,
  },
  { id: '進場-8', label: '底部第③型黏月線再突破', hit: (ci, i) => detectStickMa20Breakout(ci, i) },
  {
    id: '進場-15a', label: '週線W底突破',
    hit: (ci, i, weeklyCi, weekEndIdx) => {
      // 只在「該日是某週的 weekEnd」評估（週線型態以週收盤確認），避免每日重複計同一週
      const widx = weekEndIdx.get(ci[i].date);
      if (widx == null || widx < 12) return false;
      // detectWeeklyW 吃 WeeklyCandle 陣列、用最後一根當突破週 → 餵 [..widx] 切片
      return false; // 由 runWeekly 專責，這裡不走（見下）
    },
  },
];

// ── 統計工具 ────────────────────────────────────────────────────────────────
const mean = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const winRate = (a: number[]) => a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN;
type Sample = { date: string; ret: Record<number, number>; excess: Record<number, number> };

function summarize(rows: Sample[], h: number) {
  const rets = rows.map(r => r.ret[h]).filter(x => x != null && !isNaN(x));
  const exc = rows.map(r => r.excess[h]).filter(x => x != null && !isNaN(x));
  const avgRet = mean(rets);
  const avgExc = mean(exc);
  const netExc = avgExc - ROUND_TRIP_PCT;
  return {
    n: rets.length,
    avgRet: +avgRet.toFixed(2),
    win: +winRate(rets).toFixed(1),
    avgExc: +avgExc.toFixed(2),
    netExc: +netExc.toFixed(2),
  };
}
function splitTrainTest(rows: Sample[]): { train: Sample[]; test: Sample[]; cut: string } {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const cut = sorted.length ? sorted[Math.floor(sorted.length / 2)].date : '';
  return { train: sorted.filter(r => r.date < cut), test: sorted.filter(r => r.date >= cut), cut };
}

/** 給定「日線 ci + 觸發 index」算各 horizon 的報酬/超額（entry=index+1 開盤）。 */
function measure(ci: CandleWithIndicators[], idx: number): Sample | null {
  const d = ci[idx].date;
  if (!d || d < START || d > END) return null;
  const entry = ci[idx + 1];
  if (!entry || !(entry.open > 0)) return null;
  // 隔夜跳空 >25% 視為污染（停牌復牌/異常）剔除
  if (Math.abs(entry.open - ci[idx].close) / ci[idx].close > 0.25) return null;
  const ret: Record<number, number> = {};
  const excess: Record<number, number> = {};
  let ok = false;
  for (const h of HORIZONS) {
    const exitBar = ci[idx + h];
    if (!exitBar || !(exitBar.close > 0)) continue;
    const stratRet = (exitBar.close - entry.open) / entry.open * 100;
    const idxRet = idxHoldReturn(entry.date, h);
    ret[h] = stratRet;
    if (idxRet != null) excess[h] = stratRet - idxRet;
    ok = true;
  }
  return ok ? { date: d, ret, excess } : null;
}

// ════════════════════════════════════════════════════════════════════════════
// 主迴圈
// ════════════════════════════════════════════════════════════════════════════
const samples: Record<string, Sample[]> = {};
for (const v of VARIANTS) samples[v.id] = [];
samples['進場-15b'] = []; // 週線黃金右腳

let files = fs.readdirSync(TW_DIR).filter(f => /^\d{4}\.TW\.json$/.test(f));
if (MAX_FILES !== Infinity) files = files.slice(0, MAX_FILES);
let scanned = 0;
const t0 = Date.now();

for (const f of files) {
  const bars = loadBars(path.join(TW_DIR, f));
  if (bars.length < 80) continue;
  const ci: CandleWithIndicators[] = computeIndicators(bars as CandleWithIndicators[]);
  scanned++;

  // 預備週線（給進場-15）：聚合 → computeIndicators，並建 weekEnd date → 週 index
  const weekly = aggregateDailyToWeekly(bars);
  const weeklyCi = weekly.length >= 14 ? computeIndicators(weeklyToBars(weekly) as CandleWithIndicators[]) : null;
  const weekEndToWeekIdx = new Map<string, number>();
  weekly.forEach((w, wi) => weekEndToWeekIdx.set(w.weekEnd, wi));
  // 把每個週 weekEnd 對到「日線 index」（用來算 entry=次一日開盤、forward 報酬走日線）
  const dayDateToIdx = new Map<string, number>();
  ci.forEach((b, i) => dayDateToIdx.set(b.date, i));

  for (let idx = 65; idx < ci.length - 1; idx++) {
    const d = ci[idx].date;
    if (!d || d < START || d > END) continue;

    // 日線變體（7a/7b/7c/7*/8）
    for (const v of VARIANTS) {
      if (v.id.startsWith('進場-15')) continue;
      if (v.hit(ci, idx, weeklyCi, weekEndToWeekIdx)) {
        const s = measure(ci, idx);
        if (s) samples[v.id].push(s);
      }
    }
  }

  // ── 進場-15：週線型態（以「週 weekEnd 當天」為觸發日，forward 走日線報酬）──
  if (weekly.length >= 14 && weeklyCi) {
    for (let wi = 12; wi < weekly.length; wi++) {
      const weekEndDate = weekly[wi].weekEnd;
      if (weekEndDate < START || weekEndDate > END) continue;
      const dayIdx = dayDateToIdx.get(weekEndDate);
      if (dayIdx == null || dayIdx >= ci.length - 1) continue;

      // 15a：週線 W 底突破（用 [..wi] 週切片，最後一根 = 該週 = 突破週）
      const wSlice = weekly.slice(0, wi + 1);
      const wres = detectWeeklyW(wSlice);
      if (wres.detected) {
        const s = measure(ci, dayIdx);
        if (s) samples['進場-15a'].push(s);
      }

      // 15b：週線黃金右腳（goldenRightFoot 跑在週 K 指標序列上，需 ≥40 根週 K → 本市場多半不足，
      //       但有長歷史的大型股可命中；研究擴充）
      if (wi >= 40 && goldenRightFoot.evaluate(weeklyCi, wi) != null) {
        const s = measure(ci, dayIdx);
        if (s) samples['進場-15b'].push(s);
      }
    }
  }
}

// ── 輸出 ────────────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n=== C16 底部反轉軌回測（${START} ~ ${END}）===`);
console.log(`掃描 ${scanned} 檔 / 來回成本 ${ROUND_TRIP_PCT.toFixed(3)}% / 耗時 ${elapsed}s`);
console.log(`基準：現有 TW 前 20 策略 d5 raw cohort 報酬門檻 ≈ +0.65%（strategy-leaderboard.json）\n`);

const ALL_IDS = ['進場-7a', '進場-7b', '進場-7c', '進場-7*', '進場-8', '進場-15a', '進場-15b'];
const labelOf: Record<string, string> = {};
for (const v of VARIANTS) labelOf[v.id] = v.label;
labelOf['進場-15a'] = '週線W底突破';
labelOf['進場-15b'] = '週線黃金右腳';

for (const id of ALL_IDS) {
  const rows = samples[id];
  console.log(`【${id} ${labelOf[id]}】候選 ${rows.length} 筆`);
  if (rows.length === 0) { console.log('  （無命中）\n'); continue; }
  console.log('  期別          H    n     平均報酬%  勝率%   平均超額%  淨超額%');
  const { train, test, cut } = splitTrainTest(rows);
  const segs: Array<[string, Sample[]]> = [['全部', rows], [`train<${cut}`, train], [`test≥${cut}`, test]];
  for (const [name, seg] of segs) {
    for (const h of HORIZONS) {
      const s = summarize(seg, h);
      console.log(`  ${name.padEnd(14)} d${String(h).padEnd(2)} ${String(s.n).padStart(5)}  ${String(s.avgRet).padStart(8)}  ${String(s.win).padStart(6)}  ${String(s.avgExc).padStart(8)}  ${String(s.netExc).padStart(7)}`);
    }
  }
  console.log('');
}

// ── d5/d20 對照表（北極星：淨超額 + train/test 一致 + 是否贏過前 20 門檻 0.65%）──
console.log('=== 變體總表（d5 / d20；判準：raw cohort 報酬 vs 前20門檻0.65% + 淨超額 + train/test 同號）===');
console.log('  變體                       H   n全   raw報酬%  淨超額%  train淨超%  test淨超%  一致?');
for (const id of ALL_IDS) {
  const rows = samples[id];
  if (rows.length === 0) continue;
  const { train, test } = splitTrainTest(rows);
  for (const h of [5, 20] as const) {
    const all = summarize(rows, h);
    const tr = summarize(train, h);
    const te = summarize(test, h);
    const consistent = (tr.netExc > 0 && te.netExc > 0) ? '✓正' : (tr.netExc < 0 && te.netExc < 0) ? '✓負' : '✗分歧';
    const tag = `${id} ${labelOf[id]}`.slice(0, 24);
    console.log(`  ${tag.padEnd(26)} d${String(h).padEnd(2)} ${String(all.n).padStart(4)}  ${String(all.avgRet).padStart(7)}  ${String(all.netExc).padStart(6)}  ${String(tr.netExc).padStart(9)}  ${String(te.netExc).padStart(8)}   ${consistent}`);
  }
}
console.log('');
