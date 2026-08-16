'use client';

/**
 * FundamentalScoreSummary — 基本面 tab 頂端的「基本面 ＋ 估值評分」摘要
 *
 * 自 fetch /api/fundamentals（基本面 raw）+ /api/valuation（三情境，取 base.fairPrice 配即時價重算上漲空間）。
 * 估值定位（偏貴/合理/偏低）：有估值檔用 base 情境，否則退回 PER vs 產業合理 PE（industryTemplate）。
 * 評分邏輯全在 lib/analysis/dimensionScore.ts。台股用；陸股估值口徑不同，走 CnFundamentalPanel 自身。
 */

import { useEffect, useState } from 'react';
import {
  scoreFundamental,
  scoreValuation,
  fundamentalValuationConclusion,
} from '@/lib/analysis/dimensionScore';
import { detectIndustryTemplate, getReasonablePeRange } from '@/lib/valuation/industryTemplate';
import { ScoreLightBadge } from '@/components/agents/ScoreLightBadge';

interface RawF {
  revenueYoY?: number; epsYoY?: number; grossMargin?: number; netMargin?: number; per?: number;
}
interface ValJson { scenarios?: { base?: { fairPrice: number } } }

export function FundamentalScoreSummary({
  symbol,
  currentPrice,
  date,
}: {
  symbol: string;
  currentPrice?: number;
  /** 歷史走圖日期；估值檔也必須取同日或該日前最近一份，避免偷看未來。 */
  date?: string;
}) {
  const [raw, setRaw] = useState<RawF | null>(null);
  const [val, setVal] = useState<ValJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    setLoading(true); setRaw(null); setVal(null); setLoadWarning(null);
    const valuationDate = date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const fetchJson = async (url: string) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    Promise.allSettled([
      fetchJson(`/api/fundamentals/${encodeURIComponent(bare)}`),
      fetchJson(`/api/valuation/${encodeURIComponent(bare)}?date=${valuationDate}`),
    ]).then(([fundamentalResult, valuationResult]) => {
      if (cancelled) return;
      const f = fundamentalResult.status === 'fulfilled' ? fundamentalResult.value : null;
      const v = valuationResult.status === 'fulfilled' ? valuationResult.value : null;
      if (f?.ok && f.data) setRaw(f.data as RawF);
      if (v?.ok && v.valuation) setVal(v.valuation as ValJson);
      if (fundamentalResult.status === 'rejected' || valuationResult.status === 'rejected') {
        setLoadWarning('部分資料逾時或暫時無法取得，評分僅使用已成功載入的資料。');
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [symbol, date]);

  if (loading) return <div className="text-[11px] text-muted-foreground animate-pulse px-1 py-2">基本面 / 估值評分載入中…</div>;
  if (!raw) return loadWarning ? (
    <div role="status" className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-200">
      {loadWarning}
    </div>
  ) : null; // 無基本面 raw → 下方 FundamentalSidebarPanel 會自行處理

  const reasonablePeBase = getReasonablePeRange(detectIndustryTemplate(null, symbol)).base;
  const price = currentPrice && currentPrice > 0 ? currentPrice : null;
  const baseFair = val?.scenarios?.base?.fairPrice ?? null;
  const baseUpside = baseFair != null && price ? (baseFair - price) / price : null;

  const fund = scoreFundamental({
    revenueYoY: raw.revenueYoY ?? null, epsYoY: raw.epsYoY ?? null,
    grossMargin: raw.grossMargin ?? null, netMargin: raw.netMargin ?? null,
    per: raw.per ?? null, roePct: null,
  });
  const val2 = scoreValuation({ conclusion: null, baseUpside, per: raw.per ?? null, reasonablePeBase });
  const conclusion = fundamentalValuationConclusion(fund, val2);

  if (fund.score == null && val2.score == null) return null;

  return (
    <div className="rounded-lg border border-cyan-700/40 bg-cyan-900/10 px-2.5 py-2 space-y-1.5 mb-2">
      <div className="text-[11px] font-semibold text-cyan-300">基本面 ＋ 估值評分</div>
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex items-center justify-between rounded ring-1 ring-foreground/10 bg-card/40 px-2 py-1">
          <span className="text-[10px] text-muted-foreground">基本面</span>
          {fund.score != null
            ? <ScoreLightBadge score={fund.score} light={fund.light} size="sm" />
            : <span className="text-[10px] text-muted-foreground">—</span>}
        </div>
        <div className="flex items-center justify-between rounded ring-1 ring-foreground/10 bg-card/40 px-2 py-1">
          <span className="text-[10px] text-muted-foreground">估值{val2.label ? `·${val2.label}` : ''}</span>
          {val2.score != null
            ? <ScoreLightBadge score={val2.score} light={val2.light} size="sm" />
            : <span className="text-[10px] text-muted-foreground">—</span>}
        </div>
      </div>
      <div className="text-[11px] text-foreground/85">{conclusion}</div>
      {loadWarning && <div role="status" className="text-[10px] text-amber-300">{loadWarning}</div>}
      {(fund.note || val2.note) && (
        <div className="text-[10px] text-muted-foreground/80 leading-snug">
          {[fund.note, val2.note].filter(Boolean).join('｜')}
        </div>
      )}
    </div>
  );
}
