'use client';

/**
 * YoutubeDailySummary — 首頁 YouTube「總結」子分頁：每日節目總結報告。
 *
 * 2026-07-04 可讀性重設計（使用者回饋「太亂難看懂」，且需要白話短句大字）：
 *   - 先結論：頂部只放「今天一句話」+ 看好/風險 chips，大盤全文收合
 *   - 層次分明：必看=完整卡片；略讀=一行收合可展開；可跳過=一行帶過
 *   - summary 按句號拆行顯示（一句一行，不再是一坨長文）
 *   - 字級 13px、leading-relaxed、砍掉每卡重複的徽章/長標題/立場標籤
 *
 * 資料：/api/youtube/daily-summary/[date]（server-side 已 join analysis + 持倉）。
 */

import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { fmtDateLabelTw } from '@/lib/dateDefaults';
import { SENTIMENT_LABEL } from './sentimentLabels';
import type { DailySummaryResponse, HoldingAlert } from '@/app/api/youtube/daily-summary/[date]/route';
import type { VideoSummary } from '@/lib/youtube/analysisStorage';

interface Props {
  date: string;                                // 'YYYY-MM-DD'
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

/** 摘要一句一行：按全形句尾標點拆開，白話好讀的關鍵 */
function sentences(s: string): string[] {
  return s.split(/(?<=[。；！？])/).map(x => x.trim()).filter(Boolean);
}

/** 「上集/中集/下集」從標題抓出來貼在節目名旁（同節目多集才分得出誰是誰） */
function episodeTag(title: string): string | null {
  const m = title.match(/[（(]?(上集|中集|下集)[)）]?/);
  return m ? m[1] : null;
}

function videoUrl(v: VideoSummary): string {
  return v.url ?? `https://www.youtube.com/watch?v=${v.video_id}`;
}

function fmtDuration(sec?: number): string | null {
  if (!sec || sec <= 0) return null;
  return `${Math.round(sec / 60)} 分鐘`;
}

export function YoutubeDailySummary({ date, onDateChange, onSelectStock, selectedCode }: Props) {
  const [data, setData] = useState<DailySummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyDates, setEmptyDates] = useState<Set<string>>(() => new Set());
  const [populatedDates, setPopulatedDates] = useState<Set<string>>(() => new Set());
  const [marketOpen, setMarketOpen] = useState(false);

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

  const groups = useMemo(() => {
    const vs = data?.videos ?? [];
    return {
      must: vs.filter(v => v.watch_priority === 'must_watch'),
      skim: vs.filter(v => v.watch_priority === 'skim'),
      skip: vs.filter(v => v.watch_priority === 'skip'),
    };
  }, [data]);

  // 「今天一句話」= 大盤觀點第一句（先結論；全文收合在下面）
  const headline = useMemo(() => {
    const mv = data?.consensus?.market_view ?? '';
    return sentences(mv)[0] ?? '';
  }, [data]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Date header ─────────────────────────────────────────────── */}
      <div className="shrink-0 px-2.5 py-2 border-b border-border bg-secondary/30 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{date}</span>
          <span className="text-foreground/80">{fmtDateLabelTw(date)}</span>
          <span>· 節目總結</span>
          {loading && <span className="text-sky-400 animate-pulse ml-auto">載入中…</span>}
        </div>
        {onDateChange && (
          <DatePicker value={date} onChange={onDateChange} size="sm" meta={datePickerMeta} />
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-4">
        {error && (
          <div className="mt-2 text-xs text-red-400 p-2.5 border border-red-700/40 rounded">
            載入失敗：{error}
          </div>
        )}

        {!loading && !error && data && !data.has_analysis && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-2xl mb-2">📋</p>
            <p className="text-sm text-muted-foreground mb-1">這一天沒有節目分析</p>
            <p className="text-xs text-muted-foreground/70">
              用上面的日期切到別天（當天的分析要到晚上才會出來）
            </p>
          </div>
        )}

        {data?.has_analysis && (
          <div className="space-y-3 mt-3">
            {data.is_placeholder && (
              <div className="px-2.5 py-1.5 text-xs text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded">
                ⚠ 這天是示範資料，不是真實節目分析
              </div>
            )}

            {/* ── ① 今天一句話（先結論）──────────────────────────── */}
            {data.consensus && (
              <div className="p-3 rounded-lg border border-border bg-card/60 space-y-2">
                <p className="text-sm font-semibold text-foreground leading-relaxed">
                  {headline || '（本日無大盤觀點）'}
                </p>
                {(data.consensus.bullish_consensus.length > 0 || data.consensus.bearish_consensus.length > 0) && (
                  <div className="space-y-1.5">
                    {data.consensus.bullish_consensus.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <span className="text-[11px] text-muted-foreground shrink-0">看好</span>
                        {data.consensus.bullish_consensus.slice(0, 4).map((t, i) => (
                          <span key={i} className="px-2 py-0.5 rounded-full text-[11px] bg-secondary text-bull">{t}</span>
                        ))}
                      </div>
                    )}
                    {data.consensus.bearish_consensus.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <span className="text-[11px] text-muted-foreground shrink-0">風險</span>
                        {data.consensus.bearish_consensus.slice(0, 3).map((t, i) => (
                          <span key={i} className="px-2 py-0.5 rounded-full text-[11px] bg-secondary text-bear">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setMarketOpen(v => !v)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                >
                  {marketOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  完整大盤觀點
                </button>
                {marketOpen && (
                  <div className="text-xs text-foreground/85 leading-relaxed space-y-1 pt-1 border-t border-border/60">
                    {sentences(data.consensus.market_view).map((s, i) => <p key={i}>{s}</p>)}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground/70">
                  {data.consensus.stats.videos_analyzed} 集節目 · {data.consensus.stats.unique_stocks_total} 檔股票
                  {groups.must.length > 0 && <span className="text-red-300"> · 必看 {groups.must.length} 集</span>}
                </p>
              </div>
            )}

            {/* ── ② 持倉提醒 ─────────────────────────────────────── */}
            {data.holding_alerts.length > 0 && (
              <div className="p-3 rounded-lg border border-amber-900/50 bg-amber-950/20 space-y-2">
                <p className="text-sm font-bold text-amber-300">
                  ⚠ 你的持股被提到（{data.holding_alerts.length} 檔）
                </p>
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

            {/* ── ③ 必看：完整卡片 ────────────────────────────────── */}
            {!data.has_video_summaries ? (
              <p className="text-xs text-muted-foreground/80 text-center py-6">
                這天的分析還沒有節目摘要（新版分析上線後的日期才有）
              </p>
            ) : (
              <>
                {groups.must.length > 0 && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-bold text-foreground">🔴 必看（{groups.must.length} 集）</h3>
                    {groups.must.map(v => (
                      <MustWatchCard key={v.video_id} video={v} selectedCode={selectedCode} onSelectStock={onSelectStock} />
                    ))}
                  </section>
                )}

                {groups.skim.length > 0 && (
                  <section className="space-y-1.5">
                    <h3 className="text-sm font-bold text-foreground pt-1">🟡 看摘要就好（{groups.skim.length} 集）</h3>
                    {groups.skim.map(v => (
                      <SkimRow key={v.video_id} video={v} selectedCode={selectedCode} onSelectStock={onSelectStock} />
                    ))}
                  </section>
                )}

                {groups.skip.length > 0 && (
                  <section className="space-y-1">
                    <h3 className="text-sm font-bold text-muted-foreground pt-1">⚪ 可跳過（{groups.skip.length} 集）</h3>
                    {groups.skip.map(v => (
                      <p key={v.video_id} className="text-xs text-muted-foreground leading-relaxed pl-1">
                        <span className="font-semibold text-foreground/70">{v.source_name}</span>
                        <span className="mx-1">—</span>{v.watch_reason}
                      </p>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 節目名 + 集數 + 老師（一行搞定識別資訊）─────────────────────────────────
function SourceLine({ video, showAnalysts }: { video: VideoSummary; showAnalysts?: boolean }) {
  const ep = episodeTag(video.title);
  const dur = fmtDuration(video.duration_sec);
  return (
    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
      <span className="text-sm font-bold text-foreground">{video.source_name}</span>
      {ep && <span className="text-[11px] text-muted-foreground">{ep}</span>}
      {showAnalysts && video.analysts && video.analysts.length > 0 && (
        <span className="text-[11px] text-muted-foreground truncate">{video.analysts.join('、')}</span>
      )}
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {dur && <span className="text-[11px] text-muted-foreground/70">{dur}</span>}
        <a
          href={videoUrl(video)}
          target="_blank"
          rel="noopener noreferrer"
          title={video.title}
          onClick={e => e.stopPropagation()}
          className="flex items-center gap-0.5 text-[11px] text-sky-400 hover:underline"
        >
          看影片 <ExternalLink className="w-3 h-3" />
        </a>
      </span>
    </div>
  );
}

function KeyStockChips({ video, selectedCode, onSelectStock }: {
  video: VideoSummary; selectedCode?: string | null; onSelectStock?: (code: string) => void;
}) {
  if (video.key_stocks.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {video.key_stocks.map(s => (
        <button
          key={s.code}
          type="button"
          onClick={e => { e.stopPropagation(); onSelectStock?.(s.code); }}
          className={`px-2 py-0.5 rounded-full text-[11px] cursor-pointer transition-colors ${
            selectedCode === s.code
              ? 'bg-sky-700 text-foreground'
              : 'bg-secondary text-muted-foreground hover:text-foreground'
          }`}
          title="點一下載入走圖"
        >
          {s.name} {s.code}
        </button>
      ))}
    </div>
  );
}

// ── ③ 必看卡：一句一行的摘要 + 為什麼必看 ───────────────────────────────────
function MustWatchCard({ video, selectedCode, onSelectStock }: {
  video: VideoSummary; selectedCode?: string | null; onSelectStock?: (code: string) => void;
}) {
  return (
    <div className="p-3 rounded-lg border border-red-900/40 bg-card/60 space-y-2">
      <SourceLine video={video} showAnalysts />
      <div className="text-[13px] text-foreground/90 leading-relaxed space-y-1">
        {sentences(video.summary).map((s, i) => <p key={i}>{s}</p>)}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">💡 {video.watch_reason}</p>
      <KeyStockChips video={video} selectedCode={selectedCode} onSelectStock={onSelectStock} />
    </div>
  );
}

// ── ④ 略讀列：預設一行，點開看全文 ─────────────────────────────────────────
function SkimRow({ video, selectedCode, onSelectStock }: {
  video: VideoSummary; selectedCode?: string | null; onSelectStock?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const first = sentences(video.summary)[0] ?? video.summary;
  return (
    <div
      className="p-2.5 rounded-lg border border-border/60 bg-card/40 cursor-pointer hover:bg-card/70 transition-colors"
      onClick={() => setOpen(v => !v)}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <SourceLine video={video} />
          {!open && (
            <p className="text-xs text-muted-foreground leading-relaxed truncate">{first}</p>
          )}
          {open && (
            <>
              <div className="text-[13px] text-foreground/90 leading-relaxed space-y-1">
                {sentences(video.summary).map((s, i) => <p key={i}>{s}</p>)}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">💡 {video.watch_reason}</p>
              <KeyStockChips video={video} selectedCode={selectedCode} onSelectStock={onSelectStock} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ② 持倉提醒卡 ──────────────────────────────────────────────────────────────
function HoldingAlertCard({ alert, selected, onSelect }: {
  alert: HoldingAlert; selected: boolean; onSelect?: (code: string) => void;
}) {
  return (
    <div
      className={`p-2.5 rounded-lg border cursor-pointer transition-colors ${
        selected ? 'border-sky-500 bg-sky-950/30' : 'border-border/60 bg-card/50 hover:bg-card'
      }`}
      onClick={() => onSelect?.(alert.code)}
    >
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="font-bold text-foreground">{alert.name}</span>
        <span className="text-muted-foreground tabular-nums text-xs">({alert.code})</span>
        {alert.bullish_count > 0 && <span className="text-xs text-bull">看多 ×{alert.bullish_count}</span>}
        {alert.bearish_count > 0 && <span className="text-xs text-bear">看空/風險 ×{alert.bearish_count}</span>}
      </div>
      <div className="mt-1.5 space-y-1">
        {alert.mentions.map((m, i) => {
          const s = SENTIMENT_LABEL[m.sentiment] ?? { text: m.sentiment, cls: 'text-muted-foreground' };
          return (
            <p key={`${m.video_id}-${i}`} className="text-xs leading-relaxed">
              <span className="text-muted-foreground">{m.source_name}</span>
              <span className={`mx-1 font-semibold ${s.cls}`}>{m.recommendation_type ?? s.text}</span>
              <span className="text-foreground/75">{m.context}</span>
            </p>
          );
        })}
      </div>
    </div>
  );
}
