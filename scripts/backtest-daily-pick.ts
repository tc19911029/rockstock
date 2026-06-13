// ============================================================
// daily-pick 漏斗回測 —— 「末升段過濾(can_enter)到底有沒有用」
//
// daily-pick 的選股 = 三色紅+觸發 ∩ 六條件核心 ∩ 進場時機 can_enter（過末升段）。
// 前兩段（六條件∩三色）backtest-zhu-sanse-intersection 已測過（d5 +0.31%）；
// 本腳本只多測一件事：在「六條件∩三色」之上再加 computeEntryState 的 can_enter 關卡，
// 到底是加分還是減分？做法 = 把同一批 X5 樣本按進場時機拆三桶，比較前瞻報酬：
//   🟢 PICK    = X5 ∩ can_enter（完整 daily-pick 漏斗）
//   🟡 WATCH   = X5 ∩ watch
//   🔴 NOCHASE = X5 ∩ no_chase（末升段，被 daily-pick 刷掉的那批）
// 若 PICK 明顯贏 NOCHASE → 末升段過濾有 edge，daily-pick 比裸 X5 更值。
//
// 無未來偏誤紀律（與 zhu-sanse-intersection 完全一致，數字可對照）：
//   - 選股只用 candles[0..i]（三色逐日布林 O(N)、六條件 evaluateSixConditions(ci,i)、
//     進場時機 computeEntryState(candles.slice(0,i+1)) — 全部只看到第 i 根為止）
//   - 進場一律隔日(i+1)開盤；漲停買不到（一字鎖死 / 跳空 ≥9.5%）剔除
//   - 未來棒 candles[i+1..] 只拿來算報酬，永不回饋選股
//
// ⚠️ 三色/末升段是自創/書本顯示層，本腳本只供研究，不改 production、不接選股鏈路（鐵則 #5）。
// ⚠️ 本地 K 只含現存代號 → 存活偏差，絕對數字偏樂觀；看的是「桶與桶的相對差」。
//
// 用法：npx tsx scripts/backtest-daily-pick.ts [TW] [days=480] [limit=0]
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { getLocalCandleDir } from '@/lib/datasource/LocalCandleStore';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { computeDualB, computeXys } from '@/lib/cn-sanse/dualB';
import { isNum } from '@/lib/cn-sanse/tdx';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';
import { computeEntryState, type EntryState } from '@/lib/agents/entryGate';
import type { Candle } from '@/types';

const FWD_WINDOW = 32;
const ENTRY_MIN_IDX = 480;
const MIN_BARS = ENTRY_MIN_IDX + FWD_WINDOW + 8;
const LIMIT_GAP = 0.095;
const TW_INDEX = '^TWII';

const CELL_ORDER = ['ALL', 'SANSE', 'X5', 'PICK', 'WATCH', 'NOCHASE'] as const;
type CellId = typeof CELL_ORDER[number];
const CELL_LABELS: Record<CellId, string> = {
  ALL: '全體可進場K棒（基準）',
  SANSE: '三色 紅+觸發',
  X5: '六條件核心 ∩ 三色（裸 X5，未過時機）',
  PICK: '🟢 daily-pick：X5 ∩ 時機 can_enter（過末升段）',
  WATCH: '🟡 X5 ∩ 時機 watch',
  NOCHASE: '🔴 X5 ∩ 時機 no_chase（末升段，被刷掉的）',
};

interface Bars { n: number; dates: string[]; O: number[]; H: number[]; L: number[]; C: number[] }
interface Fwd { tradable: boolean; d3: number | null; d5: number | null; d10: number | null; d20: number | null; mg: number; ml: number }

function forwardMetrics(g: Bars, i: number): Fwd | null {
  if (i + 1 >= g.n) return null;
  const base = g.O[i + 1];
  if (!(base > 0)) return null;
  const eH = g.H[i + 1], eL = g.L[i + 1], eO = g.O[i + 1];
  const locked = eL > 0 && eO === eH && (eH - eL) / eL < 0.005;
  const gapUp = (g.O[i + 1] - g.C[i]) / g.C[i];
  const tradable = !(locked || gapUp >= LIMIT_GAP);
  const closeRet = (k: number): number | null => {
    const idx = i + 1 + k;
    return idx < g.n ? +(((g.C[idx] - base) / base) * 100).toFixed(3) : null;
  };
  let mg = 0, ml = 0;
  for (let k = 0; k < FWD_WINDOW && i + 1 + k < g.n; k++) {
    const hi = ((g.H[i + 1 + k] - base) / base) * 100;
    const lo = ((g.L[i + 1 + k] - base) / base) * 100;
    if (hi > mg) mg = hi;
    if (lo < ml) ml = lo;
  }
  return { tradable, d3: closeRet(2), d5: closeRet(4), d10: closeRet(9), d20: closeRet(19), mg: +mg.toFixed(3), ml: +ml.toFixed(3) };
}

function stat(xs: number[]) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null as number | null, median: null as number | null, win: null as number | null };
  const sorted = [...v].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const win = (v.filter((x) => x > 0).length / v.length) * 100;
  return { n: v.length, mean, median, win };
}
const fmtPct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtW = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}%`);

async function readRaw(dir: string, symbol: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.candles)) return null;
    const cs = data.candles as Candle[];
    for (const c of cs) if (typeof c.date === 'string' && c.date.endsWith('*')) c.date = c.date.slice(0, -1);
    return cs;
  } catch { return null; }
}
function isCommonTw(file: string): boolean {
  const m = file.match(/^(\d{4})\.(TW|TWO)\.json$/);
  if (!m) return false;
  if (m[1].startsWith('00')) return false;
  return true;
}
function dateToCloseMap(cs: Candle[] | null): Map<string, number> {
  const m = new Map<string, number>();
  if (cs) for (const c of cs) m.set(c.date, c.close);
  return m;
}

interface Acc { d3: number[]; d5: number[]; d10: number[]; d20: number[]; mg: number[]; ml: number[] }
const mkAcc = (): Acc => ({ d3: [], d5: [], d10: [], d20: [], mg: [], ml: [] });

async function main() {
  const days = parseInt(process.argv[3] ?? '480', 10) || 480;
  const limit = parseInt(process.argv[4] ?? '0', 10) || 0;
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = getLocalCandleDir('TW');
  const outDir = path.join(process.cwd(), 'data', 'backtest-output');
  await fs.mkdir(outDir, { recursive: true });
  const thresholds = ZHU_PURE_BOOK.thresholds;

  const idxMap = dateToCloseMap(await readRaw(dir, TW_INDEX));
  if (idxMap.size === 0) throw new Error(`找不到指數本地K線（${TW_INDEX}）`);

  let universe = (await fs.readdir(dir)).filter(isCommonTw).map((f) => f.replace(/\.json$/, ''));
  if (limit > 0) universe = universe.slice(0, limit);
  console.log(`[daily-pick] TW universe ${universe.length} 檔｜起點 ${ENTRY_MIN_IDX} 根｜每檔最多 ${days} 進場日`);

  const cellAcc = new Map<CellId, Acc>();
  const pushAcc = (id: CellId, f: Fwd) => {
    let a = cellAcc.get(id);
    if (!a) { a = mkAcc(); cellAcc.set(id, a); }
    if (f.d3 != null) a.d3.push(f.d3);
    if (f.d5 != null) a.d5.push(f.d5);
    if (f.d10 != null) a.d10.push(f.d10);
    if (f.d20 != null) a.d20.push(f.d20);
    a.mg.push(f.mg);
    a.ml.push(f.ml);
  };

  let stocksUsed = 0, stocksSkipped = 0, tradableBars = 0, limitUpExcluded = 0, entryStateCalls = 0;
  let entryDateMin = '9999', entryDateMax = '0000';
  const t0 = Date.now();

  const BATCH = 40;
  for (let b = 0; b < universe.length; b += BATCH) {
    const batch = universe.slice(b, b + BATCH);
    const loaded = await Promise.all(batch.map((sym) => readRaw(dir, sym)));
    for (let k = 0; k < batch.length; k++) {
      const symbol = batch[k];
      const candles = loaded[k];
      if (!candles || candles.length < MIN_BARS) { stocksSkipped++; continue; }
      try {
        let last = NaN;
        const indexClose = candles.map((c) => { const v = idxMap.get(c.date); if (v != null) last = v; return last; });

        // 三色逐日布林（O(N) 一次算完，只用 [0..i] 的累積值）
        const s = computeSanSe(candles, indexClose);
        const red = s.midStrength.map((x) => isNum(x) && x > 0);
        const db = computeDualB(candles);
        const xys = computeXys(candles);
        const ci = computeIndicators(candles);

        const g: Bars = {
          n: candles.length,
          dates: candles.map((c) => c.date),
          O: candles.map((c) => c.open), H: candles.map((c) => c.high),
          L: candles.map((c) => c.low), C: candles.map((c) => c.close),
        };
        const hi = g.n - 1 - FWD_WINDOW;
        const lo = Math.max(ENTRY_MIN_IDX, hi - days + 1);
        if (hi < lo) { stocksSkipped++; continue; }
        let used = false;
        for (let i = lo; i <= hi; i++) {
          const f = forwardMetrics(g, i);
          if (!f) continue;
          if (!f.tradable) { limitUpExcluded++; continue; }
          tradableBars++;
          used = true;
          if (g.dates[i] < entryDateMin) entryDateMin = g.dates[i];
          if (g.dates[i] > entryDateMax) entryDateMax = g.dates[i];

          const sanseBuy = red[i] && (db.goldCross[i] || db.breakUp[i] || xys.goldCross[i]);
          pushAcc('ALL', f);
          if (sanseBuy) pushAcc('SANSE', f);

          // 六條件核心（條件⑤要求紅K，收≤開必不過 → 省呼叫）
          let zhu5 = false;
          if (g.C[i] > g.O[i]) {
            const six = evaluateSixConditions(ci, i, thresholds);
            zhu5 = six.isCoreReady;
          }
          if (!(zhu5 && sanseBuy)) continue;
          pushAcc('X5', f);

          // ── 唯一新增維度：進場時機（末升段）。只對 X5 樣本算 → 便宜 ──
          // 無未來偏誤：slice(0, i+1) 末根 = 第 i 根（選股決策日），i+1 才進場。
          entryStateCalls++;
          const es: EntryState = computeEntryState({ symbol, candles: candles.slice(0, i + 1) }).state;
          if (es === 'can_enter') pushAcc('PICK', f);
          else if (es === 'watch') pushAcc('WATCH', f);
          else pushAcc('NOCHASE', f);
        }
        if (used) stocksUsed++; else stocksSkipped++;
      } catch (e) {
        stocksSkipped++;
        console.error(`[daily-pick] ${symbol} ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    if ((b / BATCH) % 5 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[daily-pick] 進度 ${Math.min(b + BATCH, universe.length)}/${universe.length}｜用 ${stocksUsed} 檔｜X5 樣本累積 ${entryStateCalls}｜${el}s`);
    }
  }

  const limitPct = tradableBars + limitUpExcluded > 0 ? (limitUpExcluded / (tradableBars + limitUpExcluded)) * 100 : 0;
  console.log(`[daily-pick] 完成：用 ${stocksUsed} 檔 / 跳過 ${stocksSkipped}｜可進場 ${tradableBars}｜漲停剔除 ${limitUpExcluded}（${limitPct.toFixed(1)}%）｜X5 進場時機評估 ${entryStateCalls} 次｜進場日 ${entryDateMin}~${entryDateMax}`);

  const allAcc = cellAcc.get('ALL');
  const baseD5 = allAcc ? stat(allAcc.d5).mean : null;
  const rows = CELL_ORDER.filter((id) => cellAcc.has(id)).map((id) => {
    const a = cellAcc.get(id)!;
    const d3 = stat(a.d3), d5 = stat(a.d5), d10 = stat(a.d10), d20 = stat(a.d20);
    const mg = stat(a.mg), ml = stat(a.ml);
    const excess = d5.mean != null && baseD5 != null ? d5.mean - baseD5 : null;
    return { id, label: CELL_LABELS[id], d3, d5, d10, d20, mg, ml, excess };
  });

  const lines: string[] = [];
  lines.push(`# daily-pick 漏斗回測 — 末升段過濾(can_enter)的價值（TW，${stamp}）`);
  lines.push('');
  lines.push(`用 ${stocksUsed} 檔（跳過 ${stocksSkipped}）｜可進場樣本 ${tradableBars} 筆｜進場日 ${entryDateMin} ~ ${entryDateMax}`);
  lines.push(`進場：隔日開盤｜漲停買不到剔除 ${limitUpExcluded} 筆（${limitPct.toFixed(1)}%）｜起點 480 根｜與 zhu-sanse-intersection 同框架，X5 數字可對照`);
  lines.push('');
  lines.push('> ⚠️ 本地 K 只含現存代號 → 存活偏差，絕對數字偏樂觀；重點看「PICK vs NOCHASE 的相對差」。');
  lines.push('> ⚠️ 三色/末升段為自創/顯示層，本報告不改 production（鐵則 #5）。');
  lines.push('');
  lines.push('## 進場 cell 總表（隔日開盤進場，前瞻平均報酬）');
  lines.push('');
  lines.push('| cell | n(d5) | 勝率(d5) | 平均d3 | 平均d5 | 超額d5 vs 基準 | 平均d10 | 平均d20 | 平均最高 | 平均最低 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    lines.push(`| ${r.label} | ${r.d5.n} | ${fmtW(r.d5.win)} | ${fmtPct(r.d3.mean)} | ${fmtPct(r.d5.mean)} | ${r.excess == null ? '—' : fmtPct(r.excess)} | ${fmtPct(r.d10.mean)} | ${fmtPct(r.d20.mean)} | ${fmtPct(r.mg.mean)} | ${fmtPct(r.ml.mean)} |`);
  }
  lines.push('');
  lines.push('## 中位數（抗極端值）');
  lines.push('');
  lines.push('| cell | 中位d3 | 中位d5 | 中位d10 | 中位d20 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const r of rows) {
    lines.push(`| ${r.label} | ${fmtPct(r.d3.median)} | ${fmtPct(r.d5.median)} | ${fmtPct(r.d10.median)} | ${fmtPct(r.d20.median)} |`);
  }
  lines.push('');

  // ── 自動結論：末升段過濾到底有沒有用 ──
  const pick = rows.find((r) => r.id === 'PICK');
  const noc = rows.find((r) => r.id === 'NOCHASE');
  const x5 = rows.find((r) => r.id === 'X5');
  lines.push('## 自動結論（末升段過濾的價值）');
  lines.push('');
  if (pick && noc && x5 && pick.d5.mean != null && noc.d5.mean != null && x5.d5.mean != null) {
    const pickVsNoc = pick.d5.mean - noc.d5.mean;
    const pickVsX5 = pick.d5.mean - x5.d5.mean;
    lines.push(`- 🟢 PICK（過末升段）  d5 ${fmtPct(pick.d5.mean)}（勝率 ${fmtW(pick.d5.win)}，n=${pick.d5.n}）`);
    lines.push(`- 🔴 NOCHASE（末升段） d5 ${fmtPct(noc.d5.mean)}（勝率 ${fmtW(noc.d5.win)}，n=${noc.d5.n}）`);
    lines.push(`- 裸 X5（未過時機）     d5 ${fmtPct(x5.d5.mean)}（勝率 ${fmtW(x5.d5.win)}，n=${x5.d5.n}）`);
    lines.push('');
    lines.push(`- **PICK − NOCHASE = ${fmtPct(pickVsNoc)}**（末升段那批比過關的差多少；正＝過濾有效）`);
    lines.push(`- **PICK − 裸X5 = ${fmtPct(pickVsX5)}**（加了時機關卡比不加好多少）`);
    lines.push('');
    const verdict = pickVsNoc > 0.3 && pickVsX5 > 0
      ? '✅ 末升段過濾有 edge：過關的明顯勝過被刷掉的，且優於不過濾 → daily-pick 漏斗成立。'
      : pickVsNoc > 0
        ? '➖ 末升段過濾方向對但幅度小：過關略勝被刷掉，邊際價值有限，樣本需再累積。'
        : '❌ 末升段過濾未顯出 edge（甚至反向）：此關卡在本樣本沒幫助，需重新檢討門檻。';
    lines.push(`> ${verdict}`);
  } else {
    lines.push('> 樣本不足，無法下結論（PICK/NOCHASE n 太小）。');
  }
  lines.push('');

  const md = lines.join('\n');
  const outPath = path.join(outDir, `daily-pick-backtest-${stamp}.md`);
  await fs.writeFile(outPath, md + '\n');
  console.log('\n' + md);
  console.log(`\n📄 已寫入 ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
