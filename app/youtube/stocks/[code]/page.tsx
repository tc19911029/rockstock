'use client';

/**
 * /youtube/stocks/[code] — 個股歷史頁（MVP 6）
 *
 * 顯示該股 7/14/30/90 天內所有 mention 時間軸 + rating 演變。
 * 時間軸 JSX 抽到 components/youtube/StockMentionTimeline.tsx 共用（與 /agents/[symbol] 共享）。
 */

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { PageShell, PageHeader } from '@/components/shared';
import { YoutubeHeader } from '@/components/youtube/YoutubeHeader';
import {
  StockMentionTimelineView,
  type MentionRange,
  type MentionTimelineData,
} from '@/components/youtube/StockMentionTimeline';
import { Brain } from 'lucide-react';

interface HistoryResponse {
  ok: boolean;
  range_days: number;
  end_date: string;
  analyses_loaded: number;
  history: MentionTimelineData | null;
  stock_code?: string;
  message?: string;
}

export default function StockHistoryPage({
  params,
}: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [range, setRange] = useState<MentionRange>('30d');
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

  const history = data?.history ?? null;
  const uniqueDates = history ? new Set(history.entries.map(e => e.date)).size : 0;

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title={`📺 ${code} ${history?.stock_name ?? ''}`}
          backButton="/youtube/trends"
          subtitle={
            data && data.history
              ? `最近 ${data.range_days} 天被提到 ${data.history.entries.length} 次 · 跨 ${uniqueDates} 天 · 聚合 ${data.analyses_loaded} 份報告`
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
        <div className="rounded-xl ring-1 ring-foreground/10 bg-card/40 px-4 py-2.5 text-xs flex items-center justify-between flex-wrap gap-2">
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
          {(['7d', '14d', '30d', '90d'] as MentionRange[]).map(r => (
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
          <div className="rounded ring-1 ring-foreground/10 bg-card p-6 text-center text-sm text-muted-foreground">
            載入中…
          </div>
        )}

        {data && !data.history && (
          <div className="rounded ring-1 ring-foreground/10 bg-card p-6 text-center text-sm text-muted-foreground">
            {data.message ?? '這個區間內沒有此股票的 mention 紀錄'}
          </div>
        )}

        {/* 評級演變 + 提及時間軸（與 /agents/[symbol] 共用同一段 JSX）*/}
        {history && (
          <StockMentionTimelineView history={history} timelineHeading="提及時間軸" />
        )}
      </div>
    </PageShell>
  );
}
