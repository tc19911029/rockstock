'use client';

/**
 * StockMentionTimeline — 單檔股票的「YouTube 提及紀錄」時間軸（按日分組）。
 *
 * 兩個 export：
 *   - StockMentionTimelineView：純展示（吃已抓好的 history data）。
 *     /youtube/stocks/[code] 整頁與本元件共用同一段 JSX（DRY）。
 *   - StockMentionTimeline：自抓 /api/youtube/stocks/[code]/history 的 wrapper，
 *     給 /agents/[symbol] 詳細頁直接嵌入用。
 *
 * 資料/欄位沿用既有 buildStockHistory / history route，不新增資料結構。
 */

import { useEffect, useState } from 'react';
import type { StockRating } from '@/lib/youtube/analysisStorage';

export type MentionRange = '7d' | '14d' | '30d' | '90d';

export interface MentionTimelineEntry {
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

export interface MentionTimelineData {
  stock_code: string;
  stock_name: string;
  entries: MentionTimelineEntry[];
  rating_timeline: Array<{ date: string; rating: StockRating; composite_score: number }>;
}

interface HistoryResponse {
  ok: boolean;
  range_days: number;
  end_date: string;
  analyses_loaded: number;
  history: MentionTimelineData | null;
  stock_code?: string;
  message?: string;
}

export const SENTIMENT_LABEL: Record<MentionTimelineEntry['sentiment'], { text: string; cls: string }> = {
  bullish:        { text: '看多',  cls: 'text-green-400' },
  bearish:        { text: '看空',  cls: 'text-red-400' },
  watchlist:      { text: '觀察',  cls: 'text-yellow-400' },
  risk_warning:   { text: '風險',  cls: 'text-orange-400' },
  neutral:        { text: '中立',  cls: 'text-muted-foreground' },
  mentioned_only: { text: '提及',  cls: 'text-muted-foreground' },
};

export function RatingBadge({ rating }: { rating: StockRating }) {
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

/**
 * 純展示：把 history data 畫成「評級演變 + 提及時間軸」。
 * @param maxDates 只顯示最近 N 天（詳細頁嵌入時可收斂；不傳=全部）
 */
export function StockMentionTimelineView({
  history,
  maxDates,
  showRatingTimeline = true,
  timelineHeading,
}: {
  history: MentionTimelineData | null;
  maxDates?: number;
  showRatingTimeline?: boolean;
  /** 評級演變區塊之後、時間軸群組之前的標題（不傳=不顯示）*/
  timelineHeading?: string;
}) {
  if (!history) return null;

  const entriesByDate = new Map<string, MentionTimelineEntry[]>();
  for (const e of history.entries) {
    if (!entriesByDate.has(e.date)) entriesByDate.set(e.date, []);
    entriesByDate.get(e.date)!.push(e);
  }
  let dates = Array.from(entriesByDate.keys()).sort().reverse();
  if (maxDates != null) dates = dates.slice(0, maxDates);

  if (dates.length === 0) return null;

  return (
    <div className="space-y-4">
      {showRatingTimeline && history.rating_timeline.length > 0 && (
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-2">
          <h3 className="text-sm font-semibold">評級演變</h3>
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

      {timelineHeading && <h2 className="text-sm font-semibold">{timelineHeading}</h2>}

      {dates.map(date => (
        <div key={date} className="rounded-xl ring-1 ring-foreground/10 bg-card">
          <div className="px-4 py-2 border-b border-border bg-muted/20 flex items-baseline justify-between">
            <span className="text-sm font-semibold tabular-nums">{date}</span>
            <span className="text-xs text-muted-foreground">
              {entriesByDate.get(date)!.length} 個節目提到
            </span>
          </div>
          <div className="divide-y divide-border/40">
            {entriesByDate.get(date)!.map((e, idx) => {
              // 防呆：資料若帶未知/缺漏 sentiment（非 enum 值），給安全 fallback 不讓整頁崩
              const sent = SENTIMENT_LABEL[e.sentiment] ?? { text: e.sentiment || '—', cls: 'text-muted-foreground' };
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
                      onClick={(ev) => ev.stopPropagation()}
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
  );
}

/**
 * 自抓 history API 的 wrapper — 給 /agents/[symbol] 等頁面直接嵌入。
 */
export function StockMentionTimeline({
  code,
  range = '30d',
  maxDates,
}: {
  code: string;
  range?: MentionRange;
  maxDates?: number;
}) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/youtube/stocks/${code}/history?range=${range}`);
        const d = await r.json();
        if (!cancelled) setData(d as HistoryResponse);
      } catch (err) {
        console.error('[StockMentionTimeline] fetch failed', err);
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [code, range]);

  if (loading && !data) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 text-center text-sm text-muted-foreground">
        載入 YouTube 提及紀錄…
      </div>
    );
  }
  if (!data?.history) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 text-center text-sm text-muted-foreground">
        近 {data?.range_days ?? 30} 天沒有此股票的 YouTube 提及紀錄
      </div>
    );
  }
  return <StockMentionTimelineView history={data.history} maxDates={maxDates} />;
}
