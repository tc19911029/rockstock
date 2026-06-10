// ============================================================
// 策略排行榜 — 純函式核心（無 IO）
//
//  - metricsFromLocalCandles: 由本地 K「隔日開盤」進場，算 d1/d3/d5/d10/d20 收盤報酬
//    + 窗內最高/最低。逐字對齊 lib/cn-sanse/forwardMetrics.ts 的 metricsFromOpen，
//    但直接讀記憶體裡的 candles（零 IO、零 API），讓 2 年回測不打外部源。
//  - selStats / buildHorizonBlock / buildRow: 把每日 picks 彙整成排行榜列。
//  - buildMarkdown: 人類可讀報告。
//
// 為什麼用隔日開盤：盤後掃到 → 隔天才買（書本 13:20 看、13:25 掛市價），
// 不會用訊號日收盤成交。漲停鎖死買不到 → entryOpen=null → 該樣本剔除（不計成負）。
// ============================================================

import type {
  Horizon, HorizonBlock, LeaderboardRow, SelStats, SamplePick, LeaderboardDoc, Market,
} from './leaderboardTypes';
import { HORIZONS } from './leaderboardTypes';

/** forward 視窗（交易日）：涵蓋到 d20 並給 maxGain/maxLoss 取樣。 */
export const FORWARD_BARS = 20;

/** 各 horizon 對應「進場後第幾根」的收盤（隔日開盤那根算 d1）。 */
const HORIZON_OFFSET: Record<Horizon, number> = { d1: 1, d3: 3, d5: 5 };

export interface PickMetrics {
  d1: number | null;
  d3: number | null;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  maxGain: number | null;
  maxLoss: number | null;
}

export interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

/** 單筆 pick 在回測中的最小資訊（orchestrator 累積這個）。 */
export interface RawPick {
  date: string;
  rank: number;            // 該日該排序的名次（1 = 第一）
  symbol: string;
  name: string;
  entryOpen: number;
  m: PickMetrics;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * 由 t0Idx（掃描日那根）的「下一根開盤」進場，算各 horizon 收盤報酬 + 窗內最高/最低。
 * 買不到（漲停鎖死）或沒有隔日 K → 回 null（整筆剔除）。
 *
 * 對齊 metricsFromOpen：base = 隔日開盤；dN = (close[t0+N] − base)/base×100。
 * 漲停鎖死偵測同 ForwardAnalyzer：隔日 open===high 且 (high−low)/low < 0.5% → 買不到。
 */
export function metricsFromLocalCandles(
  candles: RawCandle[],
  t0Idx: number,
): { entryOpen: number; m: PickMetrics } | null {
  const entryIdx = t0Idx + 1;
  if (entryIdx >= candles.length) return null;          // 沒有隔日 K
  const entry = candles[entryIdx];
  const base = entry.open;
  if (!(base > 0)) return null;
  // 漲停鎖死 → 隔日開盤買不到
  if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) {
    return null;
  }

  const closeRet = (offset: number): number | null => {
    const i = t0Idx + offset;
    if (i >= candles.length) return null;
    return round2((candles[i].close - base) / base * 100);
  };

  const m: PickMetrics = {
    d1: closeRet(1),
    d3: closeRet(3),
    d5: closeRet(5),
    d10: closeRet(10),
    d20: closeRet(20),
    maxGain: null,
    maxLoss: null,
  };

  let mg = 0;
  let ml = 0;
  let saw = false;
  for (let k = 0; k < FORWARD_BARS; k++) {
    const i = entryIdx + k;
    if (i >= candles.length) break;
    saw = true;
    const hi = (candles[i].high - base) / base * 100;
    const lo = (candles[i].low - base) / base * 100;
    if (hi > mg) mg = hi;
    if (lo < ml) ml = lo;
  }
  if (saw) { m.maxGain = round2(mg); m.maxLoss = round2(ml); }
  return { entryOpen: base, m };
}

/** 一組報酬值 → 統計（過濾 null）。 */
export function selStats(values: (number | null | undefined)[]): SelStats {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  if (v.length === 0) return { n: 0, avgPct: 0, medianPct: 0, winRatePct: 0 };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const sorted = [...v].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const win = v.filter((x) => x > 0).length / v.length * 100;
  return { n: v.length, avgPct: round2(avg), medianPct: round2(median), winRatePct: round1(win) };
}

/** 某 horizon 下 top1/top3/top5/cohort（逐筆 pooled）統計 + 排序 alpha。 */
export function buildHorizonBlock(picks: RawPick[], horizon: Horizon): HorizonBlock {
  const off = HORIZON_OFFSET[horizon];
  const valOf = (p: RawPick): number | null => (off === 1 ? p.m.d1 : off === 3 ? p.m.d3 : p.m.d5);
  const top1 = selStats(picks.filter((p) => p.rank === 1).map(valOf));
  const top3 = selStats(picks.filter((p) => p.rank <= 3).map(valOf));
  const top5 = selStats(picks.filter((p) => p.rank <= 5).map(valOf));
  const cohort = selStats(picks.map(valOf));
  return { top1, top3, top5, cohort, sortAlphaPct: round2(top1.avgPct - cohort.avgPct) };
}

export interface RowMeta {
  market: Market;
  engine: LeaderboardRow['engine'];
  strategyId: string;
  strategyLabel: string;
  track?: LeaderboardRow['track'];
  sortKey: string;
  sortLabel: string;
}

/** 把一個 (策略×排序) 的所有 picks 收成一列。 */
export function buildRow(meta: RowMeta, picks: RawPick[], samplePickN = 8): LeaderboardRow {
  const byHorizon = {} as Record<Horizon, HorizonBlock>;
  for (const h of HORIZONS) byHorizon[h] = buildHorizonBlock(picks, h);
  const days = new Set(picks.map((p) => p.date)).size;
  const recent = picks
    .filter((p) => p.rank === 1)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, samplePickN)
    .map<SamplePick>((p) => ({
      date: p.date, symbol: p.symbol, name: p.name, rank: p.rank,
      entryOpen: p.entryOpen, d1: p.m.d1, d3: p.m.d3, d5: p.m.d5,
    }));
  return {
    id: `${meta.market}:${meta.engine}:${meta.strategyId}:${meta.sortKey}`,
    market: meta.market,
    engine: meta.engine,
    strategyId: meta.strategyId,
    strategyLabel: meta.strategyLabel,
    track: meta.track,
    sortKey: meta.sortKey,
    sortLabel: meta.sortLabel,
    days,
    byHorizon,
    samplePicks: recent,
  };
}

// ── Markdown 報告 ────────────────────────────────────────────────────────────

const fmtSigned = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);

function rankTable(rows: LeaderboardRow[], horizon: Horizon, topN: number): string[] {
  const L: string[] = [];
  L.push(`| 策略 | 排序 | 引擎 | 天數 | top1 平均% | top1 勝率 | top5 平均% | cohort 平均% | 排序alpha |`);
  L.push('|---|---|---|---:|---:|---:|---:|---:|---:|');
  const sorted = [...rows].sort((a, b) => b.byHorizon[horizon].top1.avgPct - a.byHorizon[horizon].top1.avgPct);
  for (const r of sorted.slice(0, topN)) {
    const b = r.byHorizon[horizon];
    L.push(
      `| **${r.strategyLabel}** | ${r.sortLabel} | ${r.engine === 'buymethod' ? '買法' : '三色'} | ${r.days} | ` +
      `${fmtSigned(b.top1.avgPct)} | ${b.top1.winRatePct}% | ${fmtSigned(b.top5.avgPct)} | ${fmtSigned(b.cohort.avgPct)} | ${fmtSigned(b.sortAlphaPct)} |`,
    );
  }
  return L;
}

export function buildMarkdown(doc: LeaderboardDoc): string {
  const L: string[] = [];
  L.push(`# 策略排行榜 — 各策略 × 排序的 d1/d3/d5 漲幅（買入基準：隔日開盤）`);
  L.push('');
  L.push(`產出：${doc.generatedAt}　|　視窗：${doc.window.start} ~ ${doc.window.end}（${doc.window.tradingDays} 交易日, label=${doc.window.label}, 排除尾端 ${doc.window.forwardTd} 交易日）`);
  L.push('');
  L.push('**讀法**：把每個「策略 × 排序」當選股器。每個掃描日依排序取名次，隔日開盤進場，量 d1/d3/d5 收盤報酬。');
  L.push('- **top1** = 每天只買排序第 1 名；**top5** = 每天買前 5 名（逐筆 pooled）；**cohort** = 當日全體（與排序無關的基準）。');
  L.push('- **排序alpha** = top1 平均 − cohort 平均；>0 代表「這個排序」真的把贏家排到前面。');
  L.push(`- 樣本門檻：天數 ≥ ${doc.meta.minPicks} 才列入排行（避免僥倖小樣本霸榜）。`);
  L.push('');
  L.push(`> ⚠️ ${doc.meta.survivorshipNote}`);
  L.push('');
  L.push('---');
  L.push('');

  const minPicks = doc.meta.minPicks;
  for (const mkt of ['TW', 'CN'] as Market[]) {
    const rows = doc.rows.filter((r) => r.market === mkt && r.days >= minPicks);
    L.push(`## ${mkt === 'TW' ? '台股' : '陸股'}`);
    L.push('');
    if (rows.length === 0) { L.push('_（無足量樣本）_'); L.push(''); continue; }
    for (const h of HORIZONS) {
      L.push(`### ${h}（隔日開盤後第 ${HORIZON_OFFSET[h]} 根收盤）排行 — 依 top1 平均、Top 20`);
      L.push('');
      L.push(...rankTable(rows, h, 20));
      L.push('');
    }
    L.push('---');
    L.push('');
  }
  return L.join('\n');
}
