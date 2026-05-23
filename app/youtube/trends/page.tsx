'use client';

/**
 * /youtube/trends — 跨日股票排行（MVP 6）
 *
 * 7d / 14d / 30d range 切換。預設 7 天。
 * 點 row 跳到 /youtube/stocks/{code}。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { YoutubeHeader } from '@/components/youtube/YoutubeHeader';
import type { StockRating } from '@/lib/youtube/analysisStorage';

type Range = '7d' | '14d' | '30d';

interface StockTrendRow {
  stock_code: string;
  stock_name: string;
  total_mentions: number;
  days_mentioned: number;
  bullish_count: number;
  bearish_count: number;
  sentiment: 'bullish' | 'bearish' | 'mixed' | 'neutral';
  latest_rating: StockRating | null;
  latest_composite_score: number | null;
  avg_composite_score: number | null;
  rating_distribution: { A: number; B: number; C: number; D: number };
  source_diversity: number;
  dates: string[];
}

interface TrendsResponse {
  ok: boolean;
  range_days: number;
  end_date: string;
  analyses_loaded: number;
  total_stocks?: number;
  stocks?: StockTrendRow[];
  message?: string;
}

export default function TrendsPage() {
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const fetchData = async () => {
    try {
      const r = await fetch(`/api/youtube/trends?range=${range}`);
      const d = await r.json();
      setData(d as TrendsResponse);
      setRefreshedAt(new Date());
    } catch (err) {
      console.error('[/youtube/trends] fetch failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const stocks = data?.stocks ?? [];

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="📺 跨日趨勢"
          backButton="/youtube"
          subtitle={
            <span>
              最近 {data?.range_days ?? range} 天 · 聚合 {data?.analyses_loaded ?? 0} 份報告 · 共 {data?.total_stocks ?? 0} 檔被提到
              {refreshedAt && <span className="ml-2 text-muted-foreground/60 hidden sm:inline">更新於 {refreshedAt.toLocaleTimeString('zh-TW', { hour12: false })}</span>}
            </span>
          }
        />
      }
    >
      <div className="max-w-7xl mx-auto p-3 sm:p-4 space-y-4 sm:space-y-6">
        <YoutubeHeader />

        {/* Range 切換 */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">區間：</span>
          {(['7d', '14d', '30d'] as Range[]).map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-3 py-1 rounded border text-xs ${
                range === r
                  ? 'bg-blue-900/40 border-blue-600 text-blue-200'
                  : 'border-border text-muted-foreground hover:bg-muted/30'
              }`}
            >
              {r === '7d' ? '近 7 天' : r === '14d' ? '近 14 天' : '近 30 天'}
            </button>
          ))}
        </div>

        {loading && !data && (
          <div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            載入中…
          </div>
        )}

        {data && data.analyses_loaded === 0 && (
          <div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {data.message ?? '這個區間還沒有分析資料 — 先在每日對話用 /youtube-analysis 寫 analysis 後再回來看。'}
          </div>
        )}

        {/* 股票排行表 */}
        {stocks.length > 0 && (
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b border-border bg-muted/20">
                <tr>
                  <th className="text-left py-2 pl-3 pr-2 whitespace-nowrap">代號</th>
                  <th className="text-left py-2 pr-2 whitespace-nowrap">名稱</th>
                  <th className="text-center py-2 pr-2">最新評級</th>
                  <th className="text-right py-2 pr-2">最新總分</th>
                  <th className="text-right py-2 pr-2">期間均分</th>
                  <th className="text-right py-2 pr-2">提到次數</th>
                  <th className="text-right py-2 pr-2">被提天數</th>
                  <th className="text-right py-2 pr-2">節目數</th>
                  <th className="text-right py-2 pr-2">看多</th>
                  <th className="text-right py-2 pr-2">看空</th>
                  <th className="text-left py-2 pr-3">傾向</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map(s => (
                  <TrendRow key={s.stock_code} s={s} range={range} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function TrendRow({ s, range }: { s: StockTrendRow; range: Range }) {
  const sentimentCls =
    s.sentiment === 'bullish' ? 'text-green-400'
    : s.sentiment === 'bearish' ? 'text-red-400'
    : s.sentiment === 'mixed' ? 'text-yellow-400'
    : 'text-muted-foreground';
  const sentimentLabel =
    s.sentiment === 'bullish' ? '看多'
    : s.sentiment === 'bearish' ? '看空'
    : s.sentiment === 'mixed' ? '分歧'
    : '中性';
  return (
    <tr className="border-b border-border/40 hover:bg-muted/30">
      <td className="py-2 pl-3 pr-2 tabular-nums">
        <Link
          href={`/youtube/stocks/${s.stock_code}?range=${range}`}
          className="text-blue-400 hover:underline"
        >
          {s.stock_code}
        </Link>
      </td>
      <td className="py-2 pr-2 font-medium">{s.stock_name}</td>
      <td className="py-2 pr-2 text-center">
        {s.latest_rating ? <RatingBadge rating={s.latest_rating} /> : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
        {s.latest_composite_score != null ? s.latest_composite_score.toFixed(1) : '—'}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
        {s.avg_composite_score != null ? s.avg_composite_score.toFixed(1) : '—'}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums">{s.total_mentions}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{s.days_mentioned}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{s.source_diversity}</td>
      <td className="py-2 pr-2 text-right tabular-nums text-green-400">{s.bullish_count || ''}</td>
      <td className="py-2 pr-2 text-right tabular-nums text-red-400">{s.bearish_count || ''}</td>
      <td className={`py-2 pr-3 ${sentimentCls}`}>{sentimentLabel}</td>
    </tr>
  );
}

function RatingBadge({ rating }: { rating: StockRating }) {
  const styleMap: Record<StockRating, string> = {
    A: 'bg-green-900/50 text-green-300 border-green-600',
    B: 'bg-blue-900/40 text-blue-300 border-blue-700',
    C: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    D: 'bg-red-900/40 text-red-300 border-red-700',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-xs font-bold ${styleMap[rating]}`}>
      {rating}
    </span>
  );
}
