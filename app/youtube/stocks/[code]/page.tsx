'use client';

/**
 * /youtube/stocks/[code] — 個股歷史頁（MVP 6）
 *
 * 顯示該股 7/14/30/90 天內所有 mention 時間軸 + rating 演變。
 */

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { YoutubeHeader } from '@/components/youtube/YoutubeHeader';
import type { StockRating } from '@/lib/youtube/analysisStorage';
import { Brain } from 'lucide-react';

type Range = '7d' | '14d' | '30d' | '90d';

interface HistoryEntry {
  date: string;
  source_id: string;
  /** 節目顯示名（自 sourceRegistry 帶下來）*/
  display_name?: string;
  video_id: string;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'watchlist' | 'risk_warning' | 'mentioned_only';
  context: string;
  reason: string;
  combined_confidence: number;
  rating: StockRating | null;
  composite_score: number | null;
  /** 分析師名單（自 mention.analysts 帶下來，可能不存在於舊資料）*/
  analysts?: string[];
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
    <PageShell
      headerSlot={
        <PageHeader
          title={`📺 ${code} ${history?.stock_name ?? ''}`}
          backButton="/youtube/trends"
          subtitle={
            data && data.history
              ? `最近 ${data.range_days} 天被提到 ${data.history.entries.length} 次 · 跨 ${dates.length} 天 · 聚合 ${data.analyses_loaded} 份報告`
              : '載入中…'
          }
          actions={
            <a
              href={`https://tw.stock.yahoo.com/quote/${code}.TW`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-sky-400 hover:text-sky-300 transition-colors"
              title="到 Yahoo 股市看"
            >
              股價 ↗
            </a>
          }
        />
      }
    >
      <div className="max-w-5xl mx-auto p-3 sm:p-4 space-y-4 sm:space-y-6">
        <YoutubeHeader />

        {/* Stage 6：相關頁面 — 切到統一股票詳細頁看走圖 + Agent 分析 */}
        <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 text-xs flex items-center justify-between flex-wrap gap-2">
          <span className="text-muted-foreground">
            這頁只看「YouTube 視角的時間軸」。要看 K 線 + 4 面向 Agent 分析（技術 / 消息 / 籌碼 / 基本）請開
          </span>
          <Link
            href={`/agents/${code}.TW`}
            className="text-sky-400 hover:underline inline-flex items-center gap-1"
          >
            <Brain className="w-3 h-3" />
            {code} 統一股票詳細頁 →
          </Link>
        </div>

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
                    const sourceName = e.display_name || e.source_id;
                    // 過濾掉與節目同名的 analyst（如「股市易點靈（許毓玲）」內已含「許毓玲」）
                    const realAnalysts = (e.analysts ?? []).filter(
                      a => a !== sourceName && a !== '(未知)' && !a.includes('主持群') && !sourceName.includes(a),
                    );
                    // 理由是 context 的子集就不重複顯示
                    const reasonRedundant =
                      !e.reason ||
                      e.reason === e.context ||
                      (e.context && e.context.startsWith(e.reason)) ||
                      (e.context && e.context.includes(e.reason));
                    return (
                      <div key={idx} className="p-4 text-xs space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-semibold ${sent.cls}`}>{sent.text}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-foreground font-medium">{sourceName}</span>
                          {realAnalysts.length > 0 && (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <span className="text-amber-400">【{realAnalysts.join('/')}】</span>
                            </>
                          )}
                          <span className="text-muted-foreground">·</span>
                          <a
                            href={`https://www.youtube.com/watch?v=${e.video_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 hover:underline"
                          >
                            看影片 ↗
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
                        {e.context && (
                          <div className="text-foreground/90 leading-relaxed">
                            「{e.context}」
                          </div>
                        )}
                        {!reasonRedundant && (
                          <div className="text-foreground/70 leading-relaxed">
                            <span className="text-muted-foreground">摘要：</span>{e.reason}
                          </div>
                        )}
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
