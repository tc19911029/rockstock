/**
 * 強中透弱（Phase 3.1）— 強勢族群中的相對弱者領先回補
 *
 * 書本來源（rule #5 對齊）：
 *   - 朱家泓《活用技術分析寶典》Part 12 祕笈圖 #N（強勢族群輪動）
 *   - 核心心法：當族群整體強勢時，族群中漲幅落後的個股有「補漲」機會；不該選族群裡
 *     漲最多的（容易末升段）、也不該選族群弱的（沒題材）
 *
 * 模組定位：**排序因子**，不是新的過濾條件
 *   - 給 candidate 一個 [0, 1] score
 *   - 與既有六條件 / 戒律 / 淘汰法**並列**，不是取代
 *   - 主掃描預設不啟用（StrategyConfig.enhancedSelection.strongLeadsWeak = false）
 *
 * 算分規則：
 *   1. 候選的 industry 屬於「強勢族群」（60d 平均漲幅 top 20%）→ 基本 0.5
 *   2. 候選個股 5d 漲幅落在族群末段 30%（相對弱）→ 再加 0.5
 *   3. 不在強勢族群 → 0
 *
 * 不變式：
 *   - 純函式
 *   - 不讀檔
 *   - score ∈ [0, 1]
 *   - 「相對弱」不可被誤實作為「絕對弱」（5d 漲幅 < 0 不等於強中透弱）
 */

export const STRONG_LEADS_WEAK_BOOK_REF = {
  book: '朱家泓《活用技術分析寶典》',
  part: 'Part 12 祕笈圖',
  topic: '強勢族群中的相對弱者領先回補',
  rule: 'sorting_factor_only',  // 不是過濾條件
} as const;

export interface IndustryStat {
  industry: string;
  /** 該族群 60 天平均漲幅（%）*/
  sixtyDayGainAvg: number;
  /** 該族群在全市場排名（1 = 最強）*/
  rank: number;
  /** 全市場 industry 總數（給 top 20% 計算用）*/
  totalIndustries: number;
  /** 該族群內個股的 5 天漲幅 distribution（用於判斷「相對弱」）*/
  symbolFiveDayGains: Array<{ symbol: string; fiveDayGainPct: number }>;
}

export interface StrongLeadsWeakInput {
  symbol: string;
  industry?: string;
  /** 個股 5d 漲幅（%）*/
  fiveDayGainPct: number;
  industryStat?: IndustryStat;
}

export interface StrongLeadsWeakResult {
  score: number;           // [0, 1]
  isStrongIndustry: boolean;
  isRelativeWeak: boolean;
  industryRankPct?: number;   // 0=top, 1=bottom
  symbolRankPctInIndustry?: number; // 0=top, 1=bottom（相對弱者高）
  reason: string;
}

const STRONG_INDUSTRY_TOP_PCT = 0.20;
const RELATIVE_WEAK_BOTTOM_PCT = 0.30;

/** 純函式：給 candidate + industry stat → 算強中透弱 score */
export function scoreStrongLeadsWeak(input: StrongLeadsWeakInput): StrongLeadsWeakResult {
  if (!input.industry || !input.industryStat) {
    return {
      score: 0,
      isStrongIndustry: false,
      isRelativeWeak: false,
      reason: '無 industry 資料，無法判斷',
    };
  }

  const stat = input.industryStat;
  const industryRankPct = stat.rank / stat.totalIndustries;
  const isStrongIndustry = industryRankPct <= STRONG_INDUSTRY_TOP_PCT;

  if (!isStrongIndustry) {
    return {
      score: 0,
      isStrongIndustry: false,
      isRelativeWeak: false,
      industryRankPct,
      reason: `族群 ${input.industry} 排名 ${stat.rank}/${stat.totalIndustries}（${(industryRankPct * 100).toFixed(0)}%），非 top 20% 強勢族群`,
    };
  }

  // 在強勢族群中，看本檔的 5d 漲幅排名（升序：漲少在前 = 相對弱）
  const gains = stat.symbolFiveDayGains
    .map(s => s.fiveDayGainPct)
    .sort((a, b) => a - b);
  // 找 input 在排序後的 percentile
  const lowerCount = gains.filter(g => g < input.fiveDayGainPct).length;
  const symbolRankPctInIndustry = stat.symbolFiveDayGains.length > 0
    ? lowerCount / stat.symbolFiveDayGains.length
    : 0.5;
  // 注意：「相對弱」= 5d 漲幅小，但**仍為正或微負**（族群整體強勢，所以個股不該大跌）
  // symbolRankPctInIndustry ≤ 0.30 表示在族群內 5d 漲幅最後 30%
  const isRelativeWeak = symbolRankPctInIndustry <= RELATIVE_WEAK_BOTTOM_PCT
    && input.fiveDayGainPct > -3;  // 不可絕對弱（5d 跌 > 3% 視為「破壞」而非「相對弱」）

  let score = 0.5;  // 在強勢族群基本分
  if (isRelativeWeak) score += 0.5;

  const reason = isRelativeWeak
    ? `強勢族群 ${input.industry}（top ${(industryRankPct * 100).toFixed(0)}%）+ 個股 5d 漲幅 ${input.fiveDayGainPct.toFixed(1)}% 位族群末段（${(symbolRankPctInIndustry * 100).toFixed(0)}%）→ 強中透弱命中`
    : `強勢族群 ${input.industry}，但個股 5d 漲幅 ${input.fiveDayGainPct.toFixed(1)}% 非族群末段（${(symbolRankPctInIndustry * 100).toFixed(0)}%）`;

  return {
    score: Math.min(1, score),
    isStrongIndustry,
    isRelativeWeak,
    industryRankPct,
    symbolRankPctInIndustry,
    reason,
  };
}

/** 給定全市場 industry stats，輸出 top 20% 強勢族群清單 */
export function strongIndustries(stats: readonly IndustryStat[]): string[] {
  const total = stats.length;
  if (total === 0) return [];
  const cutoff = Math.max(1, Math.floor(total * STRONG_INDUSTRY_TOP_PCT));
  return [...stats]
    .sort((a, b) => a.rank - b.rank)  // rank 1 = 最強
    .slice(0, cutoff)
    .map(s => s.industry);
}

export const STRONG_LEADS_WEAK_CONST = {
  STRONG_INDUSTRY_TOP_PCT,
  RELATIVE_WEAK_BOTTOM_PCT,
} as const;
