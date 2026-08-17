/**
 * Fundamental Source — 書本 7 維基本面打分
 *
 * 朱書《做對 5 步驟》Part 1 列的基本面 9 維度（取其中 7 個量化可拿）：
 *   1. 本益比 (PER)
 *   2. 股價淨值比 (PBR)
 *   3. 殖利率
 *   4. EPS (季)
 *   5. EPS YoY
 *   6. 月營收 YoY
 *   7. 毛利率 / 淨利率
 *
 * 書本未列但 FinMind/TWSE 拿不到：
 *   - ROE（要 MOPS 爬蟲）
 *
 * 書本用法：「基本面做參考，以技術面為操作依據」「不要碰沒有基本面、因為炒作超漲的股票」
 *   → 這個 source 主要職責是**排除地雷股**（PER > 100、EPS 連續大幅衰退 等），
 *     輔以「成長股加分」「價值股加分」做正向訊號。
 *
 * 與舊版差異：舊版 has_fundamental_data flag 太寬，PER 1825 兆赫也算過 → 完全沒過濾效果。
 * 新版書本 7 維打分，PER > 100 直接淘汰。
 *
 * §0 隔離：只回報估值/成長/獲利，不評論技術或籌碼。
 */

import { loadScanSession } from '@/lib/storage/scanStorage';
import { fetchJSON, internalUrl } from '@/lib/agents/agents/_fetchHelper';
import type {
  CandidateSources,
  FundamentalSourceAttribution,
  SourceCandidate,
  SourceExtractor,
  SourceResult,
} from '../types';

/** PER 超過此值直接淘汰（書本：排除地雷股，1825 倍兆赫等級）*/
const PER_LANDMINE_THRESHOLD = 100;
/** 提名門檻：fundamentalScore ≥ 此值才進 pool */
const SCORE_PROMOTE_MIN = 50;

interface FundamentalsLite {
  eps: number | null;
  epsYoY: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  revenueYoY: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
}

export const fundamentalSource: SourceExtractor = {
  source: 'fundamental',
  async extract({ market, date, strategyId }): Promise<SourceResult> {
    if (market !== 'TW') {
      return { source: 'fundamental', ran: true, candidates: [] };
    }

    try {
      const session = await loadScanSession(market, date, 'long', 'daily', strategyId);
      if (!session || !session.results) {
        return { source: 'fundamental', ran: true, candidates: [] };
      }

      const targets = session.results.slice(0, 200);

      const settled = await Promise.all(
        targets.map(async (r) => ({
          row: r,
          fundamentals: await fetchFundamentals(r.symbol),
        })),
      );

      const candidates: SourceCandidate[] = [];
      for (const { row, fundamentals } of settled) {
        if (!fundamentals) continue;

        // ── 排除地雷股 ───────────────────────────────────────────
        // PER 超過 100 倍：書本明示「不要碰沒有基本面、炒作超漲」
        if (fundamentals.per != null && fundamentals.per > PER_LANDMINE_THRESHOLD) continue;
        // 全 null（FinMind 對該檔完全無資料）→ 跳過
        const hasAny = fundamentals.per != null || fundamentals.eps != null
          || fundamentals.revenueYoY != null || fundamentals.epsYoY != null;
        if (!hasAny) continue;

        // ── 書本 7 維打分 ────────────────────────────────────────
        const { score, signals, reasons } = computeBookScore(fundamentals);
        if (score < SCORE_PROMOTE_MIN) continue;

        const attribution: FundamentalSourceAttribution = {
          revenueYoY: fundamentals.revenueYoY,
          epsYoY: fundamentals.epsYoY,
          grossMargin: fundamentals.grossMargin,
          netMargin: fundamentals.netMargin,
          per: fundamentals.per,
          pbr: fundamentals.pbr,
          dividendYield: fundamentals.dividendYield,
          eps: fundamentals.eps,
          fundamentalScore: score,
          signals,
          reasons,
        };

        candidates.push({
          symbol: row.symbol,
          name: row.name,
          market: row.market,
          industry: row.industry,
          attribution: attribution as CandidateSources['fundamental'],
        });
      }

      return { source: 'fundamental', ran: true, candidates };
    } catch (err) {
      return {
        source: 'fundamental',
        ran: false,
        error: err instanceof Error ? err.message : String(err),
        candidates: [],
      };
    }
  },
};

/**
 * 書本 7 維打分（仿籌碼面 calculateChipScore 結構）
 *
 * 起點 50，按各維度加減，clamp 0-100。
 *
 * 權重設計反映書本：PER / PBR / 殖利率 是「合理價」判斷（價值面）；
 * EPS YoY / 月營收 YoY 是「成長動能」（成長面）；毛利率 / 淨利率 是「獲利品質」。
 * 缺資料的維度 = 0 分（中性、不加不減），避免懲罰小型股。
 */
function computeBookScore(f: FundamentalsLite): {
  score: number;
  signals: string[];
  reasons: string[];
} {
  let score = 50;
  const signals: string[] = [];
  const reasons: string[] = [];

  // ── 估值面 ────────────────────────────────────────────
  // PER ≤ 0 = 公司虧損或資料異常（EPS≤0 算不出 PER），不視為「便宜」
  //
  // 強成長股 PER 警戒放寬（業界實務：高成長股本來 PER 就高、市場 priced in 成長）
  // 判定：EPS YoY > 30% 或 月營收 YoY > 30% → 「偏高」門檻從 50 → 80
  // 但「地雷」門檻仍是 PER > 100（已在 fundamentalSource extract 直接淘汰）
  const strongGrowth =
    (f.epsYoY != null && f.epsYoY > 30) ||
    (f.revenueYoY != null && f.revenueYoY > 30);
  const expensiveThreshold = strongGrowth ? 80 : 50;
  if (f.per != null && f.per > 0) {
    if (f.per <= 10)                       { score += 20; signals.push('per_cheap'); reasons.push(`PER ${f.per} 便宜`); }
    else if (f.per <= 20)                  { score += 10; reasons.push(`PER ${f.per} 合理偏低`); }
    else if (f.per <= 30)                  { /* 0 */ reasons.push(`PER ${f.per} 合理`); }
    else if (f.per <= expensiveThreshold)  { score -= 5; reasons.push(`PER ${f.per} 偏高${strongGrowth ? '（強成長放寬）' : ''}`); }
    else                                   { score -= 15; signals.push('per_expensive'); reasons.push(`PER ${f.per} 昂貴`); }
  }
  // PBR ≤ 0 同樣是資料異常，不視為「破淨」
  if (f.pbr != null && f.pbr > 0) {
    if (f.pbr < 1.5)        { score += 10; signals.push('pbr_undervalued'); reasons.push(`PBR ${f.pbr.toFixed(2)} 破淨/低估`); }
    else if (f.pbr <= 3)    { score += 5; }
    else if (f.pbr > 5)     { score -= 10; reasons.push(`PBR ${f.pbr.toFixed(2)} 高溢價`); }
  }
  if (f.dividendYield != null) {
    if (f.dividendYield >= 5)      { score += 10; signals.push('high_dividend'); reasons.push(`殖利率 ${f.dividendYield.toFixed(2)}%`); }
    else if (f.dividendYield >= 3) { score += 5; }
  }

  // ── 成長面 ────────────────────────────────────────────
  if (f.epsYoY != null) {
    if (f.epsYoY >= 30)      { score += 15; signals.push('eps_growth_strong'); reasons.push(`EPS YoY +${f.epsYoY.toFixed(1)}%`); }
    else if (f.epsYoY >= 10) { score += 10; reasons.push(`EPS YoY +${f.epsYoY.toFixed(1)}%`); }
    else if (f.epsYoY >= 0)  { score += 3; }
    else if (f.epsYoY >= -10){ score -= 5; }
    else                     { score -= 15; signals.push('eps_decline'); reasons.push(`EPS YoY ${f.epsYoY.toFixed(1)}% 衰退`); }
  }
  if (f.revenueYoY != null) {
    if (f.revenueYoY >= 30)      { score += 15; signals.push('revenue_growth_strong'); reasons.push(`月營收 YoY +${f.revenueYoY.toFixed(1)}%`); }
    else if (f.revenueYoY >= 10) { score += 10; reasons.push(`月營收 YoY +${f.revenueYoY.toFixed(1)}%`); }
    else if (f.revenueYoY >= 0)  { score += 3; }
    else if (f.revenueYoY >= -10){ score -= 5; }
    else                         { score -= 15; signals.push('revenue_decline'); reasons.push(`月營收 YoY ${f.revenueYoY.toFixed(1)}% 衰退`); }
  }

  // ── 獲利品質 ──────────────────────────────────────────
  if (f.grossMargin != null) {
    if (f.grossMargin >= 50)      { score += 10; signals.push('high_gross_margin'); reasons.push(`毛利率 ${f.grossMargin.toFixed(1)}%`); }
    else if (f.grossMargin >= 30) { score += 5; }
    else if (f.grossMargin < 10)  { score -= 10; reasons.push(`毛利率 ${f.grossMargin.toFixed(1)}% 偏薄`); }
  }
  if (f.netMargin != null) {
    if (f.netMargin >= 30)        { score += 10; signals.push('high_net_margin'); reasons.push(`淨利率 ${f.netMargin.toFixed(1)}%`); }
    else if (f.netMargin >= 10)   { score += 5; }
    else if (f.netMargin < 0)     { score -= 10; signals.push('net_loss'); reasons.push(`淨利率 ${f.netMargin.toFixed(1)}% 虧損`); }
  }

  // 高分標籤
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  if (finalScore >= 65) signals.push('fundamental_quality_high');

  return { score: finalScore, signals, reasons };
}

async function fetchFundamentals(symbol: string): Promise<FundamentalsLite | null> {
  const res = await fetchJSON(internalUrl(`/api/fundamentals/${encodeURIComponent(symbol)}?mode=full`));
  if (!res || typeof res !== 'object') return null;
  const data = (res as { data?: unknown }).data ?? res;
  if (!data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  const numOrNull = (k: string): number | null => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    eps:           numOrNull('eps'),
    epsYoY:        numOrNull('epsYoY'),
    grossMargin:   numOrNull('grossMargin'),
    netMargin:     numOrNull('netMargin'),
    revenueYoY:    numOrNull('revenueYoY'),
    per:           numOrNull('per'),
    pbr:           numOrNull('pbr'),
    dividendYield: numOrNull('dividendYield'),
  };
}
