'use client';

/**
 * /youtube/stocks/[code] — 個股歷史頁（MVP 6）
 *
 * 顯示該股 7/14/30/90 天內所有 mention 時間軸 + rating 演變。
 */

import { useEffect, useState, use } from 'react';
import { PageShell } from '@/components/shared';
import { YoutubeHeader } from '@/components/youtube/YoutubeHeader';
import type { StockRating } from '@/lib/youtube/analysisStorage';

type Range = '7d' | '14d' | '30d' | '90d';

interface HistoryEntry {
  date: string;
  source_id: string;
  video_id: string;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'watchlist' | 'risk_warning' | 'mentioned_only';
  context: string;
  reason: string;
  combined_confidence: number;
  rating: StockRating | null;
  composite_score: number | null;
}

interface StockHistoryData {
  stock_code: string;
  stock_name: string;
  entries: HistoryEntry[];
  rating_timeline: Array<{ date: string; rating: StockRating; composite_score: number }>;
}

interface HistoryResponse {
  ok: boolean;
  range_days: number;
  end_date: string;
  analyses_loaded: number;
  history: StockHistoryData | null;
  stock_code?: string;
  message?: string;
}

const SENTIMENT_LABEL: Record<HistoryEntry['sentiment'], { text: string; cls: string }> = {
  bullish:        { text: '看多',  cls: 'text-green-400' },
  bearish:        { text: '看空',  cls: 'text-red-400' },
  watchlist:      { text: '觀察',  cls: 'text-yellow-400' },
  risk_warning:   { text: '風險',  cls: 'text-orange-400' },
  neutral:        { text: '中立',  cls: 'text-muted-foreground' },
  mentioned_only: { text: '提及',  cls: 'text-muted-foreground' },
};

export default function StockHistoryPage({
  params,
}: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [range, setRange] = useState<Range>('30d');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/youtube/stocks/${code}/history?range=${range}`);
        const d = await r.json();
        if (!cancelled) setData(d as HistoryResponse);
      } catch (err) {
        console.error('[stock history] fetch failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [code, range]);

  const history = data?.history;
  // Group entries by date
  const entriesByDate = new Map<string, HistoryEntry[]>();
  if (history) {
    for (const e of history.entries) {
      if (!entriesByDate.has(e.date)) entriesByDate.set(e.date, []);
      entriesByDate.get(e.date)!.push(e);
    }
  }
  const dates = Array.from(entriesByDate.keys()).sort().reverse();

  return (
    <PageShell>
      <div className="p-4 max-w-5xl mx-auto space-y-6">
        <YoutubeHeader
          title={`${code} ${history?.stock_name ?? ''}`}
          subtitle={
            data && data.history
              ? `最近 ${data.range_days} 天被提到 ${data.history.entries.length} 次，跨 ${dates.length} 天 · 聚合 ${data.analyses_loaded} 份 analysis`
              : '載入中…'
          }
          rightExtra={
            <a
              href={`https://tw.stock.yahoo.com/quote/${code}.TW`}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              title="Yahoo 股市"
            >
              {code}.TW ↗
            </a>
          }
        />

        {/* Range 切換 */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">區間：</span>
          {(['7d', '14d', '30d', '90d'] as Range[]).map(r => (
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
              {r}
            </button>
          ))}
        </div>

        {loading && !data && (
          <div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            載入中…
          </div>
        )}

        {data && !data.history && (
          <div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {data.message ?? '這個區間內沒有此股票的 mention 紀錄'}
          </div>
        )}

        {/* Rating timeline */}
        {history && history.rating_timeline.length > 0 && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold">評級演變</h2>
            <div className="flex flex-wrap gap-2 items-center">
              {history.rating_timeline.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground tabular-nums">{t.date.slice(5)}</span>
                  <RatingBadge rating={t.rating} />
                  <span className="text-muted-foreground tabular-nums">{t.composite_score.toFixed(1)}</span>
                  {i < history.rating_timeline.length - 1 && <span className="text-muted-foreground">→</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timeline groups by date */}
        {history && dates.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold">提及時間軸</h2>
            {dates.map(date => (
              <div key={date} className="rounded-lg border border-border bg-card">
                <div className="px-4 py-2 border-b border-border bg-muted/20 flex items-baseline justify-between">
                  <span className="text-sm font-semibold tabular-nums">{date}</span>
                  <span className="text-xs text-muted-foreground">
                    {entriesByDate.get(date)!.length} 個節目提到
                  </span>
                </div>
                <div className="divide-y divide-border/40">
                  {entriesByDate.get(date)!.map((e, idx) => {
                    const sent = SENTIMENT_LABEL[e.sentiment];
                    return (
                      <div key={idx} className="p-4 text-xs space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-semibold ${sent.cls}`}>{sent.text}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">{e.source_id}</span>
                          <span className="text-muted-foreground">·</span>
                          <a
                            href={`https://www.youtube.com/watch?v=${e.video_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 hover:underline"
                          >
                            {e.video_id} ↗
                          </a>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground tabular-nums">信心 {e.combined_confidence.toFixed(2)}</span>
                          {e.rating && (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <RatingBadge rating={e.rating} />
                              <span className="text-muted-foreground tabular-nums">{e.composite_score?.toFixed(1) ?? ''}</span>
                            </>
                          )}
                        </div>
                        <div className="text-foreground">
                          <span className="text-muted-foreground">原話：</span>{e.context || '—'}
                        </div>
                        <div className="text-foreground">
                          <span className="text-muted-foreground">理由：</span>{e.reason || '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
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
