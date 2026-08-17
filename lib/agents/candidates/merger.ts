/**
 * Candidates Merger — 把 4 個 source 結果合併成最終 Pool
 *
 * 行為：
 *   1. 同 symbol 合併（去重），各自 source.attribution 塞進 candidate.sources[source]
 *   2. 計算 sourceCount = 命中幾個 source（1-4）
 *   3. 計算 strengthSignals 供同 sourceCount 內排序
 *   4. 按 sourceCount DESC、strengthSignals 多源加權 DESC 排序
 *
 * §0 隔離：merger 不評估「優劣」，只合併資料；agent 才決定 verdict。
 */

import {
  Candidate,
  CandidatesPool,
  POOL_SCHEMA_VERSION,
  SourceCandidate,
  SourceName,
  SourceResult,
} from './types';
import type { MarketId } from '@/lib/scanner/types';
import { computeRedFlags } from '@/lib/redflags/compute';

export interface MergeArgs {
  market: MarketId;
  date: string;
  strategyId?: string;
  results: SourceResult[];
}

export function mergeCandidates(args: MergeArgs): CandidatesPool {
  const { market, date, strategyId, results } = args;

  // symbol → 合併中的 Candidate
  const merged = new Map<string, Candidate>();

  for (const result of results) {
    if (!result.ran) continue;
    for (const sc of result.candidates) {
      const key = sc.symbol;
      const existing = merged.get(key);
      if (existing) {
        // 同 symbol：把 attribution 塞進對應 source
        (existing.sources as Record<string, unknown>)[result.source] = sc.attribution;
        // industry 用第一個有值的
        if (!existing.industry && sc.industry) existing.industry = sc.industry;
      } else {
        merged.set(key, makeNewCandidate(sc, result.source));
      }
    }
  }

  // 計算 sourceCount + strengthSignals（+ comboBadges 純顯示徽章，不參與排序）
  const candidates: Candidate[] = [];
  for (const c of merged.values()) {
    c.sourceCount = countSources(c);
    c.strengthSignals = computeStrengthSignals(c);
    c.comboBadges = computeComboBadges(c);
    const flags = computeCandidateRedFlags(c);
    if (flags.length > 0) c.redFlags = flags;
    candidates.push(c);
  }

  // 排序：sourceCount DESC → 多源加權強度 DESC → symbol asc
  candidates.sort((a, b) => {
    if (a.sourceCount !== b.sourceCount) return b.sourceCount - a.sourceCount;
    const aw = weightedStrength(a);
    const bw = weightedStrength(b);
    if (aw !== bw) return bw - aw;
    return a.symbol.localeCompare(b.symbol);
  });

  // sourceStatus 摘要
  const sourceStatus = {} as CandidatesPool['sourceStatus'];
  for (const r of results) {
    sourceStatus[r.source] = {
      ran: r.ran,
      error: r.error,
      count: r.candidates.length,
    };
  }
  // 補沒跑的 source（保持 schema 完整）
  for (const s of ['technical', 'youtube', 'chip', 'fundamental'] as SourceName[]) {
    if (!sourceStatus[s]) sourceStatus[s] = { ran: false, count: 0 };
  }

  return {
    schemaVersion: POOL_SCHEMA_VERSION,
    date,
    market,
    ...(strategyId ? { strategyId } : {}),
    generatedAt: new Date().toISOString(),
    sourceStatus,
    candidates,
  };
}

function makeNewCandidate(sc: SourceCandidate, source: SourceName): Candidate {
  return {
    symbol: sc.symbol,
    name: sc.name,
    market: sc.market,
    industry: sc.industry,
    sources: { [source]: sc.attribution } as Candidate['sources'],
    sourceCount: 1,
    strengthSignals: {
      technicalTracksCount: 0,
      youtubeMentionCount: 0,
      chipScore: 0,
      fundamentalScore: 0,
    },
  };
}

function countSources(c: Candidate): number {
  return Object.keys(c.sources).filter((k) =>
    c.sources[k as SourceName] !== undefined,
  ).length;
}

/**
 * 組合徽章（2026-06-12 A3）— 純顯示，不參與 countSources / strengthSignals / 排序。
 * 「pool 不加組合 bonus」決議不變：徽章標示組合事實，分數一分不加。
 */
export function computeComboBadges(c: Candidate): string[] {
  const badges: string[] = [];
  const chipSignals = c.sources.chip?.signals ?? [];
  const foreignBuy = chipSignals.includes('foreign_strong_buy');
  const trustBuy = chipSignals.includes('trust_buy');
  if (foreignBuy && trustBuy) {
    badges.push(c.sources.technical ? 'sync_buy_with_tech' : 'inst_sync_buy');
  }
  if (c.sourceCount === 4) badges.push('full_house');
  return badges;
}

/**
 * 買進前紅旗（2026-06-13）— 純顯示零分數影響（同 comboBadges）。
 * TW pool 階段先用 candidate 已有的 fundamental attribution（epsYoY/per）算
 * 業績爆雷 / 獲利衰退 / 本益比虛高；籌碼/治理類旗待接 TW 資料源後在 build 端補。
 */
export function computeCandidateRedFlags(c: Candidate) {
  const f = c.sources.fundamental;
  if (!f) return [];
  return computeRedFlags({
    epsYoYPct: f.epsYoY ?? null,
    per: f.per ?? null,
  });
}

function computeStrengthSignals(c: Candidate): Candidate['strengthSignals'] {
  const tech = c.sources.technical;
  const yt = c.sources.youtube;
  const chip = c.sources.chip;
  const fund = c.sources.fundamental;

  return {
    technicalTracksCount: tech?.tracks?.length ?? 0,
    youtubeMentionCount:  yt?.mentionCount ?? 0,
    chipScore:            chip?.chipScore ?? 0,
    fundamentalScore:     computeFundamentalScore(fund),
  };
}

/**
 * 讀 attribution.fundamentalScore（書本 7 維打分，2026-05-25 重寫）
 *
 * 舊版這裡硬算 revenueYoY + epsYoY + grossMargin，但無法反映書本「排除地雷」精神。
 * 新版打分邏輯統一在 fundamentalSource.computeBookScore 內。
 */
function computeFundamentalScore(fund: Candidate['sources']['fundamental']): number {
  if (!fund) return 0;
  // 向下相容：attribution.fundamentalScore 存在則直接用，沒有 fallback 到舊算法
  if (typeof (fund as { fundamentalScore?: number }).fundamentalScore === 'number') {
    return (fund as { fundamentalScore: number }).fundamentalScore;
  }
  let s = 0;
  if (fund.revenueYoY != null && fund.revenueYoY > 0) s += Math.min(40, fund.revenueYoY);
  if (fund.epsYoY != null && fund.epsYoY > 0)         s += Math.min(30, fund.epsYoY);
  if (fund.grossMargin != null)                        s += Math.min(30, fund.grossMargin * 0.8);
  return Math.round(s);
}

function weightedStrength(c: Candidate): number {
  const s = c.strengthSignals;
  // DF5：normalize 與 poolWeights.computeFacetScores 對齊（後者才是 UI/合約的 ranking 單一事實；
  // 本函數只在 sort=sourceCount 當 tie-break、UI 從不請求）。對齊避免兩套分歧。
  return (
    Math.min(100, s.technicalTracksCount * 50) +  // ≥2 軌 → 滿分
    Math.min(100, s.youtubeMentionCount * 25) +    // ≥4 節目 → 滿分
    s.chipScore +
    s.fundamentalScore
  );
}
