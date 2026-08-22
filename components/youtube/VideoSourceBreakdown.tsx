'use client';

/**
 * VideoSourceBreakdown — /health YouTube tab：每支影片「語音 vs 畫面」抓到哪些股票
 *
 * 三欄：🎙語音 / 🖼畫面獨家（老師沒唸、OCR 補到）/ 🎙🖼兩者都有。
 * 凸顯關鍵幀 OCR 的價值 — 純語音時代會漏掉「畫面獨家」那一整欄。
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { VideoBreakdownResponse } from '@/app/api/youtube/video-breakdown/route';
import type { StockSentiment } from '@/lib/youtube/analysisStorage';
import { SENTIMENT_LABEL } from './sentimentLabels';
import { stockDisplayName } from '@/lib/stocks/stockIdentity';

interface Props { date: string }

function StockChips({ stocks }: { stocks: Array<{ code: string; name: string; sentiment: StockSentiment }> }) {
  if (stocks.length === 0) return <span className="text-[11px] text-muted-foreground/50">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {stocks.map(s => {
        const lbl = SENTIMENT_LABEL[s.sentiment] ?? SENTIMENT_LABEL.mentioned_only;
        return (
          <a
            key={s.code}
            href={`/?load=${s.code}`}
            className="text-[10px] px-1 py-0.5 rounded bg-secondary/40 border border-border/40 hover:border-sky-600 whitespace-nowrap"
            title={lbl.text}
          >
            {stockDisplayName(s.name, s.code)} <span className="font-mono text-sky-300">{s.code}</span>
            <span className={cn('ml-0.5', lbl.cls)}>·{lbl.text}</span>
          </a>
        );
      })}
    </div>
  );
}

export function VideoSourceBreakdown({ date }: Props) {
  const [data, setData] = useState<VideoBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/youtube/video-breakdown?date=${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((j: VideoBreakdownResponse) => { if (!cancelled) setData(j); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  if (loading && !data) return null;
  // 防呆：API 可能回 {ok:false} 或無 videos 欄（該日無資料/錯誤）→ 不讓整頁崩
  if (!data || !Array.isArray(data.videos) || data.videos.length === 0) return null;

  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">🎙 語音 vs 🖼 畫面 — 各抓到哪些股票</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            「畫面獨家」= 老師沒唸出來、只在簡報 OCR 抓到的股票（純語音時代會整欄漏掉）
          </p>
        </div>
        <span className="text-xs whitespace-nowrap">
          {data.hasKeyframeData ? (
            <span className="text-green-400">🖼 畫面補到 {data.totals.slide} 檔獨家 · {data.totals.both} 檔雙印證</span>
          ) : (
            <span className="text-muted-foreground">此日無畫面資料（純語音）</span>
          )}
        </span>
      </div>

      <div className="space-y-2">
        {data.videos.map(v => (
          <div key={v.video_id} className="rounded-lg border border-border/60 bg-secondary/15 p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-medium">{v.display_name}</span>
              <a href={v.url} target="_blank" rel="noreferrer" className="text-[11px] text-sky-400 hover:underline" title={v.title}>看影片 ↗</a>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div>
                <div className="text-[11px] text-muted-foreground mb-1">🎙 只有語音（{v.speech.length}）</div>
                <StockChips stocks={v.speech} />
              </div>
              <div className="md:border-l md:border-border/40 md:pl-2">
                <div className="text-[11px] text-green-400 mb-1">🖼 畫面獨家（{v.slide.length}）</div>
                <StockChips stocks={v.slide} />
              </div>
              <div className="md:border-l md:border-border/40 md:pl-2">
                <div className="text-[11px] text-sky-400 mb-1">🎙🖼 兩者都有（{v.both.length}）</div>
                <StockChips stocks={v.both} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
