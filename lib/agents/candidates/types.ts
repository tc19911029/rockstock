/**
 * Candidates Pool — 三層架構的中間層
 *
 * Layer A 多源 → Layer B [Pool] → Layer C Multi-Agent
 *
 * §0 隔離原則延伸：candidate.sources 必須按面向切片給 agent，
 * 每個 agent 只看自己面向的 source attribution（contract 守）
 */

import type { MarketId } from '@/lib/scanner/types';
import type { EntryGateResult } from '@/lib/agents/entryGate';
import type { SpecScoreResult } from '@/lib/spec-score/compute';

export const POOL_SCHEMA_VERSION = 1 as const;

// ────────────────────────────────────────────────────────────────────────────
// 各 source 的 attribution schema
// ────────────────────────────────────────────────────────────────────────────

/** Technical Source 帶來的進入理由 */
export interface TechnicalSourceAttribution {
  /** 命中的買法字母（如 ['A', 'B', 'C']）*/
  matchedMethods: string[];
  /** 命中六條件分數（從 candidateRow.sixConditionsScore 拷貝）*/
  sixConditionsScore: number;
  /** 命中那一軌 mtfMode（'daily', 'B', 'C', ...）*/
  tracks: string[];
  /** 人話 reasons：UI 顯示用 */
  reasons: string[];
  /** 是否觸發任何戒律 / 淘汰法（pool layer 不擋，給 agent 知道）*/
  prohibitionHit: boolean;
  eliminationHit: boolean;
}

/** YouTube Source 帶來的進入理由（不破壞 lib/youtube schema）*/
export interface YouTubeSourceAttribution {
  /** 被提到次數 */
  mentionCount: number;
  /** 被哪幾家節目提到 */
  shows: string[];
  /** 主流 sentiment：bullish / bearish / mixed */
  sentiment: string;
  /** 是否在 high_consensus_stocks（≥2 節目同向）*/
  inHighConsensus: boolean;
  /** 平均 combined_confidence (combined_confidence ≥ 0.6 才入彙整)*/
  combinedConfidence: number;
  reasons: string[];
}

/** Chip Source 帶來的進入理由 */
export interface ChipSourceAttribution {
  /** chipScore（從 /api/chip 拷貝；可能 null 若無資料）*/
  chipScore: number | null;
  /** 觸發的籌碼條件 ID（如 'foreign_5d_buy', 'concentration_up'）*/
  signals: string[];
  reasons: string[];
}

/** Fundamental Source 帶來的進入理由（書本 9 維打分）*/
export interface FundamentalSourceAttribution {
  /** 月營收 YoY % */
  revenueYoY: number | null;
  /** 最新季 EPS YoY % */
  epsYoY: number | null;
  /** 毛利率 % */
  grossMargin: number | null;
  /** 淨利率 % */
  netMargin: number | null;
  /** 本益比（PER）*/
  per: number | null;
  /** 股價淨值比（PBR）*/
  pbr: number | null;
  /** 殖利率 % */
  dividendYield: number | null;
  /** 最新基本每股盈餘（元）*/
  eps: number | null;
  /** 書本 7 維打分 0-100（merger.fundamentalScore 直接讀這個欄位）*/
  fundamentalScore: number;
  /** 觸發的條件 ID（如 'value_undervalued', 'growth_strong', 'landmine'）*/
  signals: string[];
  reasons: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 單檔 Candidate
// ────────────────────────────────────────────────────────────────────────────

export interface CandidateSources {
  technical?:   TechnicalSourceAttribution;
  youtube?:     YouTubeSourceAttribution;
  chip?:        ChipSourceAttribution;
  fundamental?: FundamentalSourceAttribution;
}

export type SourceName = keyof CandidateSources;

export interface Candidate {
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;

  /**
   * 訊號日收盤價（pool date 當日 L1 close）— 給後續漲跌幅 forward perf 用
   * server 端 read 時補上；舊 pool JSON 內可能不存在，client 拿到 undefined 就略過 forward
   */
  lastClose?: number;

  /**
   * 進場時機 gate — Pool API runtime 計算（不持久化到 pool JSON）
   * 規則：連 2 漲停 / 月線乖離>15% / 季線乖離>25% / 末升段三條件 → no_chase；
   * 回測 MA5 不破 → can_enter；其他 → watch
   */
  entryGate?: EntryGateResult;

  /** 進入 pool 的所有來源（至少有一個）*/
  sources: CandidateSources;

  /** 多源命中強度（1-4），相同 sourceCount 排序時看下方 strengthSignals */
  sourceCount: number;

  /**
   * 各面向附加排序訊號（同 sourceCount 內排序用）
   * 例：technical 軌道命中數越多越前 / youtube mentionCount 越高越前
   */
  strengthSignals: {
    technicalTracksCount: number;   // 命中幾條技術軌
    youtubeMentionCount: number;
    chipScore: number;              // 0-100
    fundamentalScore: number;       // 由 source 自己給的綜合分
  };

  /**
   * specScore（2026-06-12 A3 — 規格書 4 套類型權重的【顯示層】總分）
   * pool build 時由 lib/spec-score/enrich 附掛；不參與預設排序（仍是 computeFacetScores.total）、
   * 不參與任何 gate（鐵則 #5）。合約測試 spec-score-isolation 守。
   */
  specScore?: SpecScoreResult;

  /**
   * 組合徽章（2026-06-12 A3 — 純顯示零分數影響）
   * 例：'inst_sync_buy'（外資+投信籌碼訊號同現）、'sync_buy_with_tech'（同步買 + 技術在場）。
   * 「不加組合 bonus」決議不變 — 徽章只標示不加分；要進排序先過回測（計畫 Phase 6）。
   */
  comboBadges?: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 整個 Pool
// ────────────────────────────────────────────────────────────────────────────

export interface CandidatesPool {
  schemaVersion: typeof POOL_SCHEMA_VERSION;
  date: string;
  market: MarketId;
  generatedAt: string;
  /** 各 source 是否跑成功（失敗的標 false）*/
  sourceStatus: Record<SourceName, { ran: boolean; error?: string; count: number }>;
  /** 已按 sourceCount + strengthSignals 排序 */
  candidates: Candidate[];
}

// ────────────────────────────────────────────────────────────────────────────
// Source extractor 共用介面
// ────────────────────────────────────────────────────────────────────────────

/** 每個 source 回傳的單檔 partial candidate（merger 會合併同 symbol）*/
export interface SourceCandidate {
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;
  /** 該 source 自己給的 attribution（會被塞進 candidate.sources[source]）*/
  attribution: CandidateSources[SourceName];
}

export interface SourceResult {
  source: SourceName;
  ran: boolean;
  error?: string;
  candidates: SourceCandidate[];
}

/** Source extractor 函式介面 */
export interface SourceExtractor {
  source: SourceName;
  extract(opts: { market: MarketId; date: string }): Promise<SourceResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// 哪個 agent question 可以看哪個 source（§0 隔離切片）
// ────────────────────────────────────────────────────────────────────────────

export const VISIBLE_SOURCE_BY_AGENT: Record<
  'technical' | 'news' | 'chip' | 'fundamental' | 'decision',
  ReadonlyArray<SourceName>
> = {
  technical:   ['technical'],
  news:        ['youtube'],
  chip:        ['chip'],
  fundamental: ['fundamental'],
  decision:    ['technical', 'youtube', 'chip', 'fundamental'],  // P4 才用，整合各方
};

/**
 * 按 agent 切 candidate.sources — Agent question builder 用
 * 例：sliceSourcesForAgent(candidate.sources, 'technical') 只回傳 { technical: ... }
 */
export function sliceSourcesForAgent(
  sources: CandidateSources,
  agent: keyof typeof VISIBLE_SOURCE_BY_AGENT,
): CandidateSources {
  const visible = VISIBLE_SOURCE_BY_AGENT[agent];
  const sliced: CandidateSources = {};
  for (const s of visible) {
    if (sources[s]) {
      // 用 type assertion 因為 TS 推不出聯合類型
      (sliced as Record<string, unknown>)[s] = sources[s];
    }
  }
  return sliced;
}
