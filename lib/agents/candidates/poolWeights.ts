/**
 * 4 面向候選池權重 — single source of truth
 *
 * 用於：
 *   - app/api/agents/pool/route.ts  → 算 totalScore 排序回前端
 *   - components/CandidatesPoolPanel.tsx → 顯示加權分數、做 client display 排序
 *   - __tests__/contracts/pool-weighted-ranking.test.ts → 驗證一致
 *
 * **不可 hard-code 於 UI / scripts / scanner**（CLAUDE.md fundamental requirement #10）
 *
 * 為何權重這樣分（書本依據）：
 *   - 技術 0.35：朱書精神「先看 K 線」、買法本質是技術
 *   - 消息 0.25：YouTube 共識是「外圍訊號」、不可主導
 *   - 籌碼 0.25：投信 3 比 8 / 大戶持股是進場前必看
 *   - 基本 0.15：用於排除地雷股（最低保護）、權重最低避免主導
 *   - 總和 = 1.0（合約測試會驗）
 */

import type { Candidate, SourceName } from './types';

/** 4 面向權重（總和必須 = 1.0） */
export const POOL_WEIGHTS: Record<SourceName, number> = {
  technical:   0.35,
  youtube:     0.25,  // 消息面（YouTube source）
  chip:        0.25,
  fundamental: 0.15,
};

/** 至少 N 面向共識門檻（pool API 預設用） */
export const POOL_MIN_SOURCE_COUNT_DEFAULT = 3;

/** 各面向得分 + 加權總分 */
export interface FacetScores {
  /** 0-100 — 由 technicalTracksCount × 50（≥2 軌滿分） */
  technical: number;
  /** 0-100 — 由 youtubeMentionCount × 25（≥4 節目滿分） */
  news: number;
  /** 0-100 — 直接用 chipScore */
  chip: number;
  /** 0-100 — 直接用 fundamentalScore */
  fundamental: number;
  /** 0-100 — 加權總分 = Σ(facet × weight) */
  total: number;
}

/**
 * 從 Candidate.strengthSignals + sources 算各面向分數 + 加權總分。
 *
 * Normalize 規則（書本沒有明文，這是 UI ranking 需要）：
 *   - technical: tracksCount × 50, clip ≤100（≥2 軌即滿分）
 *   - news: mentionCount × 25, clip ≤100（≥4 節目即滿分）
 *   - chip / fundamental: 已是 0-100，直接用
 *   - 沒過該面向 → 該分數 0（不是 missing，避免 NaN）
 */
export function computeFacetScores(c: Candidate): FacetScores {
  const tech = c.sources.technical
    ? Math.min(100, c.strengthSignals.technicalTracksCount * 50)
    : 0;
  const news = c.sources.youtube
    ? Math.min(100, c.strengthSignals.youtubeMentionCount * 25)
    : 0;
  const chip = c.sources.chip ? c.strengthSignals.chipScore : 0;
  const fund = c.sources.fundamental ? c.strengthSignals.fundamentalScore : 0;

  const total = Math.round(
    tech * POOL_WEIGHTS.technical +
    news * POOL_WEIGHTS.youtube +
    chip * POOL_WEIGHTS.chip +
    fund * POOL_WEIGHTS.fundamental,
  );

  return { technical: tech, news, chip, fundamental: fund, total };
}
