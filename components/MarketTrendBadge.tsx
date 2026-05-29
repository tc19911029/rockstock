'use client';

/**
 * 大盤趨勢小徽章 — 放在 ChartToolbar 的「趨勢」旁邊
 * 自己 fetch /api/scanner/market-trend，不依賴 saved scan session
 */

import { useEffect, useState } from 'react';
import type { TrendState } from '@/lib/analysis/trendAnalysis';

interface Props {
  market: 'TW' | 'CN';
  scanDate?: string | null;
}

const INDEX_NAME: Record<'TW' | 'CN', string> = {
  TW: '加權',
  CN: '上證',
};

export function MarketTrendBadge({ market, scanDate }: Props) {
  const [trend, setTrend] = useState<TrendState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ market });
    if (scanDate) params.set('date', scanDate);
    fetch(`/api/scanner/market-trend?${params}`)
      .then(r => r.json())
      .then((j: { ok?: boolean; trend?: TrendState }) => {
        if (!cancelled && j.ok && j.trend) setTrend(j.trend);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [market, scanDate]);

  if (!trend) return null;

  const arrow = trend === '多頭' ? '▲' : trend === '空頭' ? '▼' : '↔';
  const cls = trend === '多頭'
    ? 'bg-emerald-900/40 text-emerald-300'
    : trend === '空頭'
    ? 'bg-red-900/40 text-red-300'
    : 'bg-amber-900/30 text-amber-300';

  return (
    <span
      title={`大盤${INDEX_NAME[market]}：${trend}（書本 p.687：大盤站上月線才可做多）`}
      className={`text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 cursor-help ${cls}`}
    >
      大盤：{arrow} {trend}
    </span>
  );
}
