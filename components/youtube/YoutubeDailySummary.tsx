'use client';

/**
 * YoutubeDailySummary — 首頁 YouTube「總結」子分頁：每日節目總結報告。
 *
 * 讓使用者「看報告代替看節目」，三區：
 *   ① 跨節目總結論（market_view 全文 + 多空共識 chips）— 常駐展開，這分頁的主角
 *   ② 持倉提醒（自己持股被哪個節目提到、什麼態度）— 有才渲染
 *   ③ 節目卡片列表（必看 → 略讀 → 可跳過；server 已排好）
 *
 * 資料：/api/youtube/daily-summary/[date]（server-side 已 join analysis + 持倉）。
 * Fetch/日期 pattern 照 YoutubeStocksPanel（useEffect keyed on date + cancelled flag + DatePicker meta）。
 */

import { useState, useEffect, useMemo } from 'react';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { fmtDateLabelTw } from '@/lib/dateDefaults';
import { SENTIMENT_LABEL } from './sentimentLabels';
import type { DailySummaryResponse, HoldingAlert } from '@/app/api/youtube/daily-summary/[date]/route';
import type { VideoSummary, WatchPriority } from '@/lib/youtube/analysisStorage';

interface Props {
  date: string;                                // 'YYYY-MM-DD'
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

const PRIORITY_BADGE: Record<WatchPriority, { icon: string; text: string; cls: string }> = {
  must_watch: { icon: '🔴', text: '必看',   cls: 'bg-red-900/40 text-red-300' },
  skim:       { icon: '🟡', text: '略讀',   cls: 'bg-yellow-900/40 text-yellow-300' },
  skip:       { icon: '⚪', text: '可跳過', cls: 'bg-muted/50 text-muted-foreground' },
};

const STANCE_LABEL: Record<string, { text: string; cls: string }> = {
  bullish: { text: '看多大盤', cls: 'text-bull' },
  bearish: { text: '看空大盤', cls: 'text-bear' },
  neutral: { text: '大盤中性', cls: 'text-muted-foreground' },
  mixed:   { text: '大盤多空並陳', cls: 'text-yellow-400' },
};

function videoUrl(v: VideoSummary): string {
  return v.url ?? `https://www.youtube.com/watch?v=${v.video_id}`;
}

function fmtDuration(sec?: number): string | null {
  if (!sec || sec <= 0) return null;
  return `約 ${Math.round(sec / 60)} 分鐘`;
}

export function YoutubeDailySummary({ date, onDateChange, onSelectStock, selectedCode }: Props) {
  const [data, setData] = useState<DailySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyDates, setEmptyDates] = useState<Set<string>>(() => new Set());
  const [populatedDates, setPopulatedDates] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/youtube/daily-summary/${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((json: DailySummaryResponse & { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); setData(null); return; }
        setData(json);
        if (json.has_analysis) {
          setPopulatedDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
          setEmptyDates(prev => { if (!prev.has(date)) return prev; const n = new Set(prev); n.delete(date); return n; });
        } else {
          setEmptyDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
        }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const datePickerMeta = useMemo<Record<string, DateMeta>>(() => {
    const m: Record<string, DateMeta> = {};
    emptyDates.forEach(d => { m[d] = { dim: true }; });
    populatedDates.forEach(d => { m[d] = { note: '有節目分析' }; });
    return m;
  }, [emptyDates, populatedDates]);

  const mustWatchCount = useMemo(
    () => (data?.videos ?? []).filter(v => v.watch_priority === 'must_watch').length,
    [data],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Date header ─────────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-secondary/30 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{date}</span>
          <span className="text-foreground/80">{fmtDateLabelTw(date)}</span>
          <span>· 節目總結報告</span>
          {loading && <span className="text-sky-400 animate-pulse ml-auto">載入中…</span>}
        </div>
        {onDateChange && (
          <DatePicker value={date} onChange={onDateChange} size="sm" meta={datePickerMeta} />
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && (
          <div className="m-2 text-xs text-red-400 p-2 border border-red-700/40 rounded">
            載入失敗：{error}
          </div>
        )}

        {!loading && !error && data && !data.has_analysis && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <p className="text-2xl mb-2">📋</p>
            <p className="text-xs text-muted-foreground mb-1">此日無節目分析</p>
            <p className="text-[10px] text-muted-foreground/70">
              請用上方日期切換到有資料的日期（當日分析通常於晚間 23:55 後產生）
            </p>
          </div>
        )}

        {data?.has_analysis && (
          <>
            {data.is_placeholder && (
              <div className="mx-2 mt-2 px-2 py-1 text-[10px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded">
                ⚠ 此日為示範資料，非真實節目分析
              </div>
            )}

            {/* ── ① 跨節目總結論（常駐展開）──────────────────────────── */}
            {data.consensus && (
              <div className="mx-2 mt-2 p-2 rounded border border-border bg-card/60 space-y-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="font-bold text-foreground text-xs">📊 今日跨節目總結</span>
                  <span>{data.consensus.stats.videos_analyzed} 集節目 · {data.consensus.stats.unique_stocks_total} 檔股票</span>
                  {mustWatchCount > 0 && <span className="text-red-300">必看 {mustWatchCount} 集</span>}
                </div>
                <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">
                  {data.consensus.market_view}
                </p>
                {data.consensus.bullish_consensus.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[9px] text-muted-foreground/70">看好</span>
                    {data.consensus.bullish_consensus.map((t, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded-full text-[9px] bg-secondary text-bull">{t}</span>
                    ))}
                  </div>
                )}
                {data.consensus.bearish_consensus.length > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[9px] text-muted-foreground/70">風險</span>
                    {data.consensus.bearish_consensus.map((t, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded-full text-[9px] bg-secondary text-bear">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── ② 持倉提醒 ─────────────────────────────────────────── */}
            {data.holding_alerts.length > 0 && (
              <div className="mx-2 mt-2 p-2 rounded border border-amber-900/50 bg-amber-950/20 space-y-1.5">
                <div className="text-xs font-bold text-amber-300">
                  ⚠ 你的持股今天被節目提到（{data.holding_alerts.length} 檔）
                </div>
                {data.holding_alerts.map(a => (
                  <HoldingAlertCard
                    key={a.symbol}
                    alert={a}
                    selected={selectedCode === a.code}
                    onSelect={onSelectStock}
                  />
                ))}
              </div>
            )}

            {/* ── ③ 節目卡片列表 ─────────────────────────────────────── */}
            <div className="px-2 py-2 space-y-1.5">
              {data.has_video_summaries ? (
                data.videos.map(v => (
                  <VideoSummaryCard
                    key={v.video_id}
                    video={v}
                    selectedCode={selectedCode}
                    onSelectStock={onSelectStock}
                  />
                ))
              ) : (
                <div className="text-[10px] text-muted-foreground/80 text-center py-4">
                  此日分析尚無節目摘要（skill 更新後的 nightly 分析才有）
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── ② 持倉提醒卡 ──────────────────────────────────────────────────────────────
function HoldingAlertCard({
  alert, selected, onSelect,
}: {
  alert: HoldingAlert;
  selected: boolean;
  onSelect?: (code: string) => void;
}) {
  return (
    <div
      className={`p-1.5 rounded border text-xs cursor-pointer transition-colors ${
        selected ? 'border-sky-500 bg-sky-950/30' : 'border-border/60 bg-card/50 hover:bg-card'
      }`}
      onClick={() => onSelect?.(alert.code)}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-bold text-foreground">{alert.name}</span>
        <span className="text-muted-foreground tabular-nums">({alert.code})</span>
        <span className="text-[9px] text-muted-foreground">
          進場 {alert.entry_price}{alert.holding_stop_loss != null ? ` · 停損 ${alert.holding_stop_loss}` : ''}
        </span>
        {alert.bullish_count > 0 && <span className="text-[9px] text-bull">看多 ×{alert.bullish_count}</span>}
        {alert.bearish_count > 0 && <span className="text-[9px] text-bear">看空/風險 ×{alert.bearish_count}</span>}
      </div>
      <div className="mt-1 space-y-0.5">
        {alert.mentions.map((m, i) => {
          const s = SENTIMENT_LABEL[m.sentiment] ?? { text: m.sentiment, cls: 'text-muted-foreground' };
          return (
            <div key={`${m.video_id}-${i}`} className="text-[10px] leading-snug">
              <span className="text-muted-foreground">{m.source_name}</span>
              {m.analysts && m.analysts.length > 0 && (
                <span className="text-muted-foreground/70">（{m.analysts.join('、')}）</span>
              )}
              <span className={`ml-1 font-semibold ${s.cls}`}>{m.recommendation_type ?? s.text}</span>
              {m.target_price != null && <span className="ml-1 text-muted-foreground">目標 {m.target_price}</span>}
              {m.stop_loss != null && <span className="ml-1 text-muted-foreground">停損 {m.stop_loss}</span>}
              <span className="ml-1 text-foreground/70">{m.context}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ③ 節目卡 ─────────────────────────────────────────────────────────────────
function VideoSummaryCard({
  video, selectedCode, onSelectStock,
}: {
  video: VideoSummary;
  selectedCode?: string | null;
  onSelectStock?: (code: string) => void;
}) {
  const badge = PRIORITY_BADGE[video.watch_priority] ?? PRIORITY_BADGE.skim;
  const stance = video.market_stance ? STANCE_LABEL[video.market_stance] : null;
  const dur = fmtDuration(video.duration_sec);
  const dimmed = video.watch_priority === 'skip';

  return (
    <div className={`p-2 rounded border border-border/60 bg-card/50 text-xs space-y-1 ${dimmed ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${badge.cls}`}>
          {badge.icon} {badge.text}
        </span>
        <span className="font-bold text-foreground">{video.source_name}</span>
        {stance && <span className={`text-[9px] ${stance.cls}`}>{stance.text}</span>}
        {dur && <span className="text-[9px] text-muted-foreground ml-auto">{dur}</span>}
      </div>
      <a
        href={videoUrl(video)}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-[10px] text-sky-400 hover:underline leading-snug"
        title="開啟 YouTube 影片"
      >
        {video.title}
      </a>
      {video.analysts && video.analysts.length > 0 && (
        <div className="text-[9px] text-muted-foreground">🎓 {video.analysts.join('、')}</div>
      )}
      <p className="text-[11px] text-foreground/90 leading-relaxed">{video.summary}</p>
      <p className="text-[10px] text-muted-foreground leading-snug">💡 {video.watch_reason}</p>
      {video.key_stocks.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center pt-0.5">
          {video.key_stocks.map(s => (
            <button
              key={s.code}
              type="button"
              onClick={() => onSelectStock?.(s.code)}
              className={`px-1.5 py-0.5 rounded-full text-[9px] transition-colors ${
                selectedCode === s.code
                  ? 'bg-sky-700 text-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground'
              }`}
              title="點擊載入走圖"
            >
              {s.name} {s.code}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
