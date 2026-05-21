/**
 * Scan 模式 ABCDE — 從 StockScanResult 既有欄位算每檔 grade，不打 API
 *
 * 給 ScanResultsTable / ScanResultsCompact 兩個掃描列表共用。
 * chart 模式（單檔深度）的 grade 由 prefetchZhuChart 算（含基本面）。
 *
 * 因為 scan 模式無 fundamentals/valuation，computeScanLights 會強制把這兩個 light 設 gray，
 * 滿分上限只到 6 → 最高拿 C 級，這是預期行為（避免缺資料卻誤判 A 級）。
 */

import type { StockScanResult } from '@/lib/scanner/types';
import { computeScanGradeFromLights, computeScanLights } from './zhuLights';
import type { Grade } from './zhuTypes';

// re-export 給 UI / 測試方便引用，single source of truth 仍在 zhuLights.ts
export { computeScanGradeFromLights };

export interface IndustryRank {
  sameIndustryCount: number;
  selfRank: number | null;
}

/** 算每檔在同產業 top10 的排名 — 給 theme light 用 */
export function buildIndustryRankMap(rows: readonly StockScanResult[]): Map<string, IndustryRank> {
  const map = new Map<string, IndustryRank>();
  const byIndustry = new Map<string, StockScanResult[]>();
  for (const r of rows) {
    if (!r.industry) continue;
    const arr = byIndustry.get(r.industry) ?? [];
    arr.push(r);
    byIndustry.set(r.industry, arr);
  }
  for (const [, peers] of byIndustry) {
    peers.sort((a, b) => (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0));
    const top10 = peers.slice(0, 10);
    for (let i = 0; i < top10.length; i++) {
      map.set(top10[i].symbol, { sameIndustryCount: top10.length, selfRank: i + 1 });
    }
    for (let i = 10; i < peers.length; i++) {
      map.set(peers[i].symbol, { sameIndustryCount: top10.length, selfRank: null });
    }
  }
  return map;
}

export function computeScanGrade(row: StockScanResult, ir: IndustryRank | undefined): Grade {
  const lights = computeScanLights({
    sixCond: row.sixConditionsScore ?? 0,
    trendState: row.trendState,
    longProhibitionsCount: row.longProhibitionsReasons?.length ?? 0,
    chipScore: row.chipScore,
    consecutiveForeignBuy: row.consecutiveForeignBuy,
    sameIndustryCount: ir?.sameIndustryCount,
    selfRankInIndustry: ir?.selfRank,
  });
  return computeScanGradeFromLights(lights);
}

/** 一次把整批 scanResults 變成 symbol → grade 的 map */
export function buildGradeMap(rows: readonly StockScanResult[]): Map<string, Grade> {
  const ir = buildIndustryRankMap(rows);
  const out = new Map<string, Grade>();
  for (const r of rows) out.set(r.symbol, computeScanGrade(r, ir.get(r.symbol)));
  return out;
}

/** ABCDE chip 配色（台股紅漲：A 紅、E 灰） */
export function gradeChipStyle(g: Grade): string {
  switch (g) {
    case 'A': return 'bg-red-500/80 text-white border-red-400';
    case 'B': return 'bg-orange-500/70 text-white border-orange-400';
    case 'C': return 'bg-yellow-500/70 text-yellow-50 border-yellow-400';
    case 'D': return 'bg-zinc-500/70 text-white border-zinc-400';
    case 'E': return 'bg-zinc-700/80 text-zinc-200 border-zinc-500';
  }
}
