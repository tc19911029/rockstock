/**
 * Fundamental Source — 基本面候選
 *
 * MVP 做法：對 L4 daily session 的 candidates 並行打 /api/fundamentals 拿 EPS/YoY，
 * 篩 revenueYoY > 10% / epsYoY > 0 / grossMargin > 25% 的。
 *
 * §0 隔離：只回報營收 / EPS / 估值，不評論技術或籌碼。
 *
 * 注意：FinMind 對小型股可能無資料 → fundamentals 全 null 的會被跳過（不視為命中）。
 */

import { loadScanSession } from '@/lib/storage/scanStorage';
import { fetchJSON, internalUrl } from '@/lib/agents/agents/_fetchHelper';
import type { MarketId } from '@/lib/scanner/types';
import type {
  CandidateSources,
  FundamentalSourceAttribution,
  SourceCandidate,
  SourceExtractor,
  SourceResult,
} from '../types';

// FIX-4（2026-05-22）：放寬閾值，原值過嚴 5/22 命中 0 檔
const REVENUE_YOY_MIN  = 5;    // 10% → 5%
const EPS_YOY_MIN      = -10;  // 0% → -10%（容忍輕微衰退，仍可入觀察）
const GROSS_MARGIN_MIN = 20;   // 25% → 20%

interface FundamentalsLite {
  eps: number | null;
  epsYoY: number | null;
  grossMargin: number | null;
  revenueYoY: number | null;
  per: number | null;
}

export const fundamentalSource: SourceExtractor = {
  source: 'fundamental',
  async extract({ market, date }): Promise<SourceResult> {
    if (market !== 'TW') {
      // /api/fundamentals 目前只覆蓋台股
      return { source: 'fundamental', ran: true, candidates: [] };
    }

    try {
      const session = await loadScanSession(market, date, 'long', 'daily');
      if (!session || !session.results) {
        return { source: 'fundamental', ran: true, candidates: [] };
      }

      // 並行打基本面 API，但加上限以免太重
      const targets = session.results.slice(0, 200);

      const settled = await Promise.all(
        targets.map(async (r) => {
          const f = await fetchFundamentals(r.symbol);
          return { row: r, fundamentals: f };
        }),
      );

      const candidates: SourceCandidate[] = [];
      for (const { row, fundamentals } of settled) {
        if (!fundamentals) continue;

        const signals: string[] = [];
        const reasons: string[] = [];

        if (fundamentals.revenueYoY != null && fundamentals.revenueYoY >= REVENUE_YOY_MIN) {
          signals.push('revenue_yoy_high');
          reasons.push(`月營收 YoY ${fundamentals.revenueYoY >= 0 ? '+' : ''}${fundamentals.revenueYoY.toFixed(1)}%`);
        }
        if (fundamentals.epsYoY != null && fundamentals.epsYoY > EPS_YOY_MIN) {
          signals.push('eps_improving');
          reasons.push(`EPS YoY ${fundamentals.epsYoY >= 0 ? '+' : ''}${fundamentals.epsYoY.toFixed(1)}%`);
        }
        if (fundamentals.grossMargin != null && fundamentals.grossMargin >= GROSS_MARGIN_MIN) {
          signals.push('gross_margin_healthy');
          reasons.push(`毛利率 ${fundamentals.grossMargin.toFixed(1)}%`);
        }
        // FIX-4 補：閾值都沒命中但有任一基本面數字 → 至少標 'has_fundamental_data'
        // 避免小型股 FinMind 邊緣資料完全沒命中
        if (signals.length === 0) {
          const hasAnyData = fundamentals.eps != null || fundamentals.per != null
            || fundamentals.revenueYoY != null;
          if (hasAnyData) {
            signals.push('has_fundamental_data');
            const parts: string[] = [];
            if (fundamentals.eps != null) parts.push(`EPS ${fundamentals.eps.toFixed(2)}`);
            if (fundamentals.per != null) parts.push(`PER ${fundamentals.per.toFixed(1)}`);
            if (fundamentals.revenueYoY != null) parts.push(`營收 YoY ${fundamentals.revenueYoY.toFixed(1)}%`);
            reasons.push(parts.join(' / '));
          }
        }

        if (signals.length === 0) continue;

        const attribution: FundamentalSourceAttribution = {
          revenueYoY: fundamentals.revenueYoY,
          epsYoY: fundamentals.epsYoY,
          grossMargin: fundamentals.grossMargin,
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
    eps:         numOrNull('eps'),
    epsYoY:      numOrNull('epsYoY'),
    grossMargin: numOrNull('grossMargin'),
    revenueYoY:  numOrNull('revenueYoY'),
    per:         numOrNull('per'),
  };
}
