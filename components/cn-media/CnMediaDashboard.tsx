'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Clock3,
  ExternalLink,
  FileText,
  LoaderCircle,
  Radio,
  RefreshCw,
  SearchX,
  ShieldAlert,
  Sparkles,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/DatePicker';
import { cn } from '@/lib/utils';
import { fmtDateLabelTw } from '@/lib/dateDefaults';
import type {
  CnMediaDailyAnalysis,
  CnMediaMention,
  CnMediaStockScoring,
} from '@/lib/cn-media/analysisStorage';
import type { CnMediaScanResult, CnMediaSource, CnMediaVideo } from '@/lib/cn-media/types';

type ViewKey = 'summary' | 'stocks' | 'sources';

interface AggregatedStock {
  code: string;
  name: string;
  mentions: CnMediaMention[];
  bullish: number;
  bearish: number;
  scoring: CnMediaStockScoring | null;
}

interface AnalysisResponse {
  ok: boolean;
  date: string;
  analysis: CnMediaDailyAnalysis | null;
  stocks: AggregatedStock[];
  error?: string;
}

interface TranscriptState {
  video_id: string;
  status: 'available' | 'low_quality' | 'failed' | 'pending';
  quality_score: number | null;
  char_count: number;
  error: string | null;
}

interface VideosResponse {
  ok: boolean;
  date: string;
  videos: CnMediaVideo[];
  sources: CnMediaSource[];
  scan_results: CnMediaScanResult[];
  transcripts: TranscriptState[];
  error?: string;
}

const TABS: Array<{ key: ViewKey; label: string; icon: typeof Sparkles }> = [
  { key: 'summary', label: '今日總覽', icon: Sparkles },
  { key: 'stocks', label: '股票提及', icon: Target },
  { key: 'sources', label: '來源狀態', icon: Radio },
];

function shiftDate(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00+08:00`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(parsed);
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '時長未知';
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分` : `${minutes} 分鐘`;
}

function sentences(value: string): string[] {
  return value.split(/(?<=[。；！？])/).map(item => item.trim()).filter(Boolean);
}

function cnChartSymbol(code: string): string | null {
  if (/^6\d{5}$/.test(code)) return `${code}.SS`;
  if (/^[023]\d{5}$/.test(code)) return `${code}.SZ`;
  return null;
}

function stanceLabel(stance: CnMediaDailyAnalysis['video_summaries'][number]['market_stance']) {
  return ({ bullish: '偏多', bearish: '偏空', neutral: '中性', mixed: '分歧' } as const)[stance];
}

function stanceClass(stance: CnMediaDailyAnalysis['video_summaries'][number]['market_stance']) {
  if (stance === 'bullish') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
  if (stance === 'bearish') return 'border-rose-500/30 bg-rose-500/10 text-rose-400';
  return 'border-border bg-secondary text-muted-foreground';
}

function ratingClass(rating: string | undefined) {
  if (rating === 'A') return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400';
  if (rating === 'B') return 'border-sky-500/30 bg-sky-500/15 text-sky-400';
  if (rating === 'C') return 'border-amber-500/30 bg-amber-500/15 text-amber-400';
  return 'border-rose-500/30 bg-rose-500/15 text-rose-400';
}

function EmptyState({ hasVideos, compact = false }: { hasVideos: boolean; compact?: boolean }) {
  return (
    <Card className="border-dashed bg-card/50">
      <CardContent className={cn('flex flex-col items-center justify-center px-6 text-center', compact ? 'min-h-44' : 'min-h-64')}>
        <SearchX className="mb-4 size-10 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">這天還沒有完成分析</h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          {hasVideos
            ? '節目已掃描，等待逐字稿與共識分析完成。來源狀態頁仍可查看每集處理進度。'
            : '尚未掃描到節目。工作日節目會依序經過掃描、逐字稿、資料補強與共識分析。'}
        </p>
      </CardContent>
    </Card>
  );
}

export function CnMediaDashboard({
  initialDate,
  onDateChange,
  onSelectStock,
  selectedCode,
  view,
  compact = false,
}: {
  initialDate: string;
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
  view?: ViewKey;
  compact?: boolean;
}) {
  const [localDate, setLocalDate] = useState(initialDate);
  const date = compact ? initialDate : localDate;
  const [tab, setTab] = useState<ViewKey>('summary');
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  const [videosData, setVideosData] = useState<VideosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const changeDate = (nextDate: string) => {
    if (compact && onDateChange) onDateChange(nextDate);
    else setLocalDate(nextDate);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [analysisResponse, videosResponse] = await Promise.all([
        fetch(`/api/cn-media/analysis/${date}`, { cache: 'no-store' }),
        fetch(`/api/cn-media/videos?date=${date}`, { cache: 'no-store' }),
      ]);
      if (!analysisResponse.ok || !videosResponse.ok) throw new Error('API 回傳失敗');
      const [nextAnalysis, nextVideos] = await Promise.all([
        analysisResponse.json() as Promise<AnalysisResponse>,
        videosResponse.json() as Promise<VideosResponse>,
      ]);
      setAnalysisData(nextAnalysis);
      setVideosData(nextVideos);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法載入資料');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
    const url = new URL(window.location.href);
    url.searchParams.set('date', date);
    window.history.replaceState(null, '', url);
  }, [date, load]);

  const transcriptByVideo = useMemo(
    () => new Map((videosData?.transcripts ?? []).map(item => [item.video_id, item])),
    [videosData],
  );
  const scanBySource = useMemo(
    () => new Map((videosData?.scan_results ?? []).map(item => [item.source_id, item])),
    [videosData],
  );
  const analysis = analysisData?.analysis ?? null;
  const stocks = analysisData?.stocks ?? [];
  const videos = videosData?.videos ?? [];

  if (compact) {
    return (
      <CnMediaCompactDashboard
        date={date}
        onDateChange={changeDate}
        onSelectStock={onSelectStock}
        selectedCode={selectedCode}
        view={view ?? tab}
        loading={loading}
        error={error}
        analysis={analysis}
        stocks={stocks}
        videosData={videosData}
        videos={videos}
        transcriptByVideo={transcriptByVideo}
        scanBySource={scanBySource}
      />
    );
  }

  return (
    <div className={cn(
      'w-full',
      compact ? 'h-full space-y-3 overflow-auto p-2' : 'mx-auto max-w-[1600px] space-y-4 p-3 sm:p-4 lg:p-6',
    )}>
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
          <span>上海交易日</span>
          <input
            type="date"
            value={date}
            onChange={event => changeDate(event.target.value)}
            aria-label="選擇節目日期"
            className="min-h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="outline" size="lg" onClick={() => changeDate(shiftDate(date, -1))} aria-label="前一天">
            <ArrowLeft aria-hidden="true" />
            <span className="hidden sm:inline">前一天</span>
          </Button>
          <Button variant="outline" size="lg" onClick={() => changeDate(shiftDate(date, 1))} aria-label="後一天">
            <span className="hidden sm:inline">後一天</span>
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button variant="outline" size="lg" onClick={() => void load()} disabled={loading} aria-label="重新整理">
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden="true" />
            <span className="hidden sm:inline">更新</span>
          </Button>
        </div>
      </section>

      {analysis?.source_concentration_note && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden="true" />
          <p><span className="font-semibold">來源集中提醒：</span>{analysis.source_concentration_note}</p>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="size-5" aria-hidden="true" />
          {error}，請稍後重試。
        </div>
      )}

      <div role="tablist" aria-label="陸股節目分析分頁" className="flex overflow-x-auto border-b border-border">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              tab === key
                ? 'border-sky-500 bg-sky-500/5 text-sky-400'
                : 'border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {loading && !analysisData && !videosData ? (
        <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
          <LoaderCircle className="mr-2 size-5 animate-spin" aria-hidden="true" />
          正在整理節目與逐字稿…
        </div>
      ) : (
        <div role="tabpanel">
          {tab === 'summary' && (
            analysis ? (
              <div className="space-y-4">
                <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-4')}>
                  {[
                    { label: '完成分析', value: analysis.stats.videos_analyzed, suffix: '集', icon: CirclePlay, tone: 'text-sky-400' },
                    { label: '提及股票', value: analysis.stats.unique_stocks_total, suffix: '檔', icon: Target, tone: 'text-violet-400' },
                    { label: '高共識', value: analysis.stats.high_consensus_count, suffix: '檔', icon: CheckCircle2, tone: 'text-emerald-400' },
                    { label: '弱訊號', value: analysis.stats.weak_signal_count, suffix: '檔', icon: Activity, tone: 'text-amber-400' },
                  ].map(({ label, value, suffix, icon: Icon, tone }) => (
                    <Card key={label} size="sm">
                      <CardContent className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}<span className="ml-1 text-sm font-normal text-muted-foreground">{suffix}</span></p>
                        </div>
                        <Icon className={cn('size-6', tone)} aria-hidden="true" />
                      </CardContent>
                    </Card>
                  ))}
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>大盤共識</CardTitle>
                    <CardDescription>綜合當日已完成逐字稿的節目，不等同投資建議。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-7 text-foreground/90">{analysis.market_view}</p>
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <ConsensusList title="偏多共識" items={analysis.bullish_consensus} bullish />
                      <ConsensusList title="偏空／風險" items={analysis.bearish_consensus} />
                    </div>
                  </CardContent>
                </Card>

                <div className={cn('grid gap-4', !compact && 'xl:grid-cols-2')}>
                  {analysis.video_summaries.map(video => (
                    <Card key={video.video_id}>
                      <CardHeader>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className={stanceClass(video.market_stance)}>{stanceLabel(video.market_stance)}</Badge>
                          <Badge variant="outline">{video.source_name}</Badge>
                          {video.watch_priority === 'must_watch' && <Badge className="bg-violet-500/15 text-violet-300">必看</Badge>}
                        </div>
                        <CardTitle className="mt-2">
                          <a className="inline-flex items-start gap-1.5 hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={video.url} target="_blank" rel="noreferrer">
                            {video.title}
                            <ExternalLink className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
                          </a>
                        </CardTitle>
                        <CardDescription>{formatDuration(video.duration_sec)} · {video.analysts.join('、') || '講者待辨識'}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-sm leading-6 text-foreground/85">{video.summary}</p>
                        <p className="rounded-md bg-secondary/50 p-3 text-xs leading-5 text-muted-foreground">觀看理由：{video.watch_reason}</p>
                        <div className="flex flex-wrap gap-1.5">
                          {video.key_stocks.map(stock => <Badge key={stock.code} variant="outline">{stock.name} {stock.code}</Badge>)}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ) : <EmptyState hasVideos={videos.length > 0} compact={compact} />
          )}

          {tab === 'stocks' && (
            stocks.length ? (
              <div className={cn('grid gap-3', !compact && 'lg:grid-cols-2')}>
                {stocks.map(stock => <StockCard key={stock.code} stock={stock} />)}
              </div>
            ) : <EmptyState hasVideos={videos.length > 0} compact={compact} />
          )}

          {tab === 'sources' && (
            <div className="space-y-4">
              <div className={cn('grid gap-3', compact ? 'grid-cols-1 min-[480px]:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-4')}>
                {(videosData?.sources ?? []).map(source => {
                  const scan = scanBySource.get(source.source_id);
                  const sourceVideos = videos.filter(video => video.source_id === source.source_id);
                  const completed = sourceVideos.filter(video => transcriptByVideo.get(video.video_id)?.status === 'available').length;
                  return (
                    <Card key={source.source_id} size="sm">
                      <CardHeader>
                        <CardTitle className="flex items-start justify-between gap-2">
                          <a href={source.url} target="_blank" rel="noreferrer" className="hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {source.display_name}
                          </a>
                          <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', scan?.error ? 'bg-rose-400' : scan ? 'bg-emerald-400' : 'bg-muted-foreground')} aria-hidden="true" />
                        </CardTitle>
                        <CardDescription>第一財經官方節目 · 工作日更新</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2 text-xs text-muted-foreground">
                        <div className="flex justify-between"><span>掃描結果</span><span>{scan?.error ? '失敗' : scan ? `${scan.found_count} 集` : '尚未執行'}</span></div>
                        <div className="flex justify-between"><span>逐字稿完成</span><span>{completed} / {sourceVideos.length}</span></div>
                        {scan?.error && <p className="rounded bg-rose-500/10 p-2 text-rose-300">{scan.error}</p>}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>節目處理進度</CardTitle>
                  <CardDescription>逐字稿品質低於門檻時不會進入當日共識分析。</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {videos.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">這天尚未掃描到節目。</p>
                  ) : videos.map(video => {
                    const transcript = transcriptByVideo.get(video.video_id);
                    return (
                      <div key={video.video_id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <a href={video.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm font-medium hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="truncate">{video.title}</span><ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                          </a>
                          <p className="mt-1 text-xs text-muted-foreground">{video.source_id} · {formatDuration(video.duration_sec)}</p>
                        </div>
                        <TranscriptBadge transcript={transcript} />
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <FileText className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        現階段先收錄第一財經四檔官方節目，避免把匿名自媒體與官方媒體視為同等訊號；後續可再加入 Bilibili、雪球與財聯社的分層來源。
      </p>
    </div>
  );
}

function CnMediaCompactDashboard({
  date,
  onDateChange,
  onSelectStock,
  selectedCode,
  view,
  loading,
  error,
  analysis,
  stocks,
  videosData,
  videos,
  transcriptByVideo,
  scanBySource,
}: {
  date: string;
  onDateChange: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
  view: ViewKey;
  loading: boolean;
  error: string | null;
  analysis: CnMediaDailyAnalysis | null;
  stocks: AggregatedStock[];
  videosData: VideosResponse | null;
  videos: CnMediaVideo[];
  transcriptByVideo: Map<string, TranscriptState>;
  scanBySource: Map<string, CnMediaScanResult>;
}) {
  const labels: Record<ViewKey, string> = {
    summary: '陸股節目總結',
    stocks: '陸股節目提及股票',
    sources: '陸股來源狀態',
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border bg-secondary/30 px-2.5 py-2 text-xs">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-semibold tabular-nums text-foreground">{date}</span>
          <span className="text-foreground/80">{fmtDateLabelTw(date)}</span>
          <span>· {labels[view]}</span>
          {loading && <span className="ml-auto animate-pulse text-sky-400">載入中…</span>}
        </div>
        <DatePicker value={date} onChange={onDateChange} size="sm" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-4">
        {error && (
          <div className="mt-2 rounded border border-red-700/40 p-2.5 text-xs text-red-400">
            載入失敗：{error}
          </div>
        )}
        {!error && view === 'summary' && (
          <CnCompactSummary analysis={analysis} videos={videos} loading={loading} onSelectStock={onSelectStock} selectedCode={selectedCode} />
        )}
        {!error && view === 'stocks' && (
          <CnCompactStocks stocks={stocks} videos={videos} loading={loading} onSelectStock={onSelectStock} selectedCode={selectedCode} />
        )}
        {!error && view === 'sources' && (
          <CnCompactSources
            sources={videosData?.sources ?? []}
            videos={videos}
            transcriptByVideo={transcriptByVideo}
            scanBySource={scanBySource}
          />
        )}
      </div>
    </div>
  );
}

function CnCompactSummary({
  analysis,
  videos,
  loading,
  onSelectStock,
  selectedCode,
}: {
  analysis: CnMediaDailyAnalysis | null;
  videos: CnMediaVideo[];
  loading: boolean;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}) {
  const [marketOpen, setMarketOpen] = useState(false);
  const groups = {
    must: analysis?.video_summaries.filter(video => video.watch_priority === 'must_watch') ?? [],
    skim: analysis?.video_summaries.filter(video => video.watch_priority === 'skim') ?? [],
    skip: analysis?.video_summaries.filter(video => video.watch_priority === 'skip') ?? [],
  };
  const headline = sentences(analysis?.market_view ?? '')[0] ?? '';

  if (!loading && !analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileText className="mb-2 size-7 text-muted-foreground" aria-hidden="true" />
        <p className="mb-1 text-sm text-muted-foreground">這一天沒有節目分析</p>
        <p className="text-xs text-muted-foreground/70">
          {videos.length ? '節目已掃描，等待逐字稿與晚間分析完成' : '請用上面的日期切到有節目的工作日'}
        </p>
      </div>
    );
  }
  if (!analysis) return null;

  return (
    <div className="mt-3 space-y-3">
      {analysis.source_concentration_note && (
        <div className="rounded border border-amber-900/40 bg-amber-950/20 px-2.5 py-2 text-[11px] leading-relaxed text-amber-300">
          來源提醒：{analysis.source_concentration_note}
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border bg-card/60 p-3">
        <p className="text-sm font-semibold leading-relaxed text-foreground">{headline || '（本日無大盤觀點）'}</p>
        {(analysis.bullish_consensus.length > 0 || analysis.bearish_consensus.length > 0) && (
          <div className="space-y-1.5">
            {analysis.bullish_consensus.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-muted-foreground">看好</span>
                {analysis.bullish_consensus.slice(0, 4).map((item, index) => (
                  <span key={`${item}-${index}`} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-bull">{item}</span>
                ))}
              </div>
            )}
            {analysis.bearish_consensus.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="shrink-0 text-[11px] text-muted-foreground">風險</span>
                {analysis.bearish_consensus.slice(0, 3).map((item, index) => (
                  <span key={`${item}-${index}`} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-bear">{item}</span>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setMarketOpen(open => !open)}
          className="flex min-h-8 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {marketOpen ? <ChevronDown className="size-3" aria-hidden="true" /> : <ChevronRight className="size-3" aria-hidden="true" />}
          完整大盤觀點
        </button>
        {marketOpen && (
          <div className="space-y-1 border-t border-border/60 pt-2 text-xs leading-relaxed text-foreground/85">
            {sentences(analysis.market_view).map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground/70">
          {analysis.stats.videos_analyzed} 集節目 · {analysis.stats.unique_stocks_total} 檔股票
          {groups.must.length > 0 && <span className="text-red-300"> · 必看 {groups.must.length} 集</span>}
        </p>
      </div>

      {groups.must.length > 0 && (
        <section className="space-y-2">
          <SectionHeading tone="bg-red-400" label={`必看（${groups.must.length} 集）`} />
          {groups.must.map(video => (
            <CnVideoSummaryCard key={video.video_id} video={video} openByDefault onSelectStock={onSelectStock} selectedCode={selectedCode} />
          ))}
        </section>
      )}
      {groups.skim.length > 0 && (
        <section className="space-y-1.5">
          <SectionHeading tone="bg-amber-400" label={`看摘要就好（${groups.skim.length} 集）`} />
          {groups.skim.map(video => (
            <CnVideoSummaryCard key={video.video_id} video={video} onSelectStock={onSelectStock} selectedCode={selectedCode} />
          ))}
        </section>
      )}
      {groups.skip.length > 0 && (
        <section className="space-y-1">
          <SectionHeading tone="bg-muted-foreground" label={`可跳過（${groups.skip.length} 集）`} muted />
          {groups.skip.map(video => (
            <p key={video.video_id} className="pl-1 text-xs leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground/70">{video.source_name}</span>
              <span className="mx-1">—</span>{video.watch_reason}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

function SectionHeading({ tone, label, muted = false }: { tone: string; label: string; muted?: boolean }) {
  return (
    <h3 className={cn('flex items-center gap-1.5 pt-1 text-sm font-bold', muted ? 'text-muted-foreground' : 'text-foreground')}>
      <span className={cn('size-2 rounded-full', tone)} aria-hidden="true" />
      {label}
    </h3>
  );
}

function CnVideoSummaryCard({
  video,
  openByDefault = false,
  onSelectStock,
  selectedCode,
}: {
  video: CnMediaDailyAnalysis['video_summaries'][number];
  openByDefault?: boolean;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}) {
  const [open, setOpen] = useState(openByDefault);
  const firstSentence = sentences(video.summary)[0] ?? video.summary;

  return (
    <div className={cn('rounded-lg border bg-card/50', openByDefault ? 'border-red-900/40 p-3' : 'border-border/60 p-2.5')}>
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-expanded={open}
          className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="mt-0.5 shrink-0 text-muted-foreground">
            {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-bold text-foreground">{video.source_name}</span>
              <span className="text-[10px] text-muted-foreground">{formatDuration(video.duration_sec)}</span>
            </span>
            {!open && <span className="mt-1 block truncate text-xs leading-relaxed text-muted-foreground">{firstSentence}</span>}
          </span>
        </button>
        <a
          href={video.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`開啟 ${video.source_name} 原始影片`}
          className="flex size-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </div>
      {open && (
        <div className="mt-2 space-y-2 pl-5">
          <div className="space-y-1 text-[13px] leading-relaxed text-foreground/90">
            {sentences(video.summary).map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">觀看理由：{video.watch_reason}</p>
          <div className="flex flex-wrap gap-1.5">
            {video.key_stocks.map(stock => {
              const symbol = cnChartSymbol(stock.code);
              return (
                <button
                  key={stock.code}
                  type="button"
                  disabled={!symbol || !onSelectStock}
                  onClick={() => symbol && onSelectStock?.(symbol)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                    symbol && onSelectStock ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
                    selectedCode === stock.code ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {stock.name} {stock.code}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CnCompactStocks({
  stocks,
  videos,
  loading,
  onSelectStock,
  selectedCode,
}: {
  stocks: AggregatedStock[];
  videos: CnMediaVideo[];
  loading: boolean;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}) {
  const [filter, setFilter] = useState<'all' | 'A' | 'B+'>('all');
  const distribution = stocks.reduce((counts, stock) => {
    const rating = stock.scoring?.rating;
    if (rating) counts[rating]++;
    else counts.none++;
    return counts;
  }, { A: 0, B: 0, C: 0, D: 0, none: 0 });
  const filtered = stocks.filter(stock => filter === 'all'
    || (filter === 'A' && stock.scoring?.rating === 'A')
    || (filter === 'B+' && (stock.scoring?.rating === 'A' || stock.scoring?.rating === 'B')));

  return (
    <div className="space-y-2 pt-2">
      <div className="space-y-1.5 border-b border-border/60 bg-card/40 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-bold text-foreground">{stocks.length} 檔</span>
          {(['A', 'B', 'C', 'D'] as const).map(rating => distribution[rating] > 0 && (
            <span key={rating} className={cn('rounded px-1 py-0.5 text-[9px]', ratingClass(rating))}>{rating} {distribution[rating]}</span>
          ))}
          {distribution.none > 0 && <span className="rounded bg-muted/50 px-1 py-0.5 text-[9px] text-muted-foreground">未評 {distribution.none}</span>}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-0.5 text-[9px] text-muted-foreground/70">篩選</span>
          {([
            { key: 'all' as const, label: '全部' },
            { key: 'A' as const, label: '只看 A' },
            { key: 'B+' as const, label: 'B+ 以上' },
          ]).map(item => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={cn('cursor-pointer rounded-full px-1.5 py-0.5 text-[9px] transition-colors', filter === item.key ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground')}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {!loading && stocks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Target className="mb-2 size-7 text-muted-foreground" aria-hidden="true" />
          <p className="mb-1 text-xs text-muted-foreground">此日無陸股節目提及紀錄</p>
          <p className="text-[10px] text-muted-foreground/70">{videos.length ? '逐字稿尚在分析中' : '請切換到有節目的工作日'}</p>
        </div>
      )}
      {filtered.map(stock => {
        const symbol = cnChartSymbol(stock.code);
        return (
          <div key={stock.code} className={cn('rounded-lg border bg-card/50 p-2.5', selectedCode === stock.code ? 'border-sky-500/60' : 'border-border/60')}>
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                disabled={!symbol || !onSelectStock}
                onClick={() => symbol && onSelectStock?.(symbol)}
                className="min-w-0 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <span className="text-sm font-bold text-foreground">{stock.name}</span>
                <span className="ml-1 font-mono text-[11px] text-muted-foreground">{stock.code}</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">{stock.mentions.length} 次提及 · {new Set(stock.mentions.map(item => item.source_id)).size} 個節目</span>
              </button>
              {stock.scoring && <span className={cn('rounded border px-2 py-0.5 text-xs font-bold', ratingClass(stock.scoring.rating))}>{stock.scoring.rating}</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400">偏多 {stock.bullish}</span>
              <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-rose-400">偏空／風險 {stock.bearish}</span>
              {stock.scoring && <span className="ml-auto text-muted-foreground">綜合 {stock.scoring.composite_score}</span>}
            </div>
            {stock.scoring && (
              <details className="mt-2 text-xs">
                <summary className="min-h-8 cursor-pointer py-1 font-medium text-foreground/85">{stock.scoring.action}</summary>
                <div className="space-y-1.5 border-t border-border/60 pt-2 leading-relaxed text-muted-foreground">
                  <p>{stock.scoring.reasoning}</p>
                  {stock.scoring.risk_flags.length > 0 && <p className="text-amber-300">風險：{stock.scoring.risk_flags.join('；')}</p>}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CnCompactSources({
  sources,
  videos,
  transcriptByVideo,
  scanBySource,
}: {
  sources: CnMediaSource[];
  videos: CnMediaVideo[];
  transcriptByVideo: Map<string, TranscriptState>;
  scanBySource: Map<string, CnMediaScanResult>;
}) {
  const completed = videos.filter(video => transcriptByVideo.get(video.video_id)?.status === 'available').length;
  return (
    <div className="space-y-3 pt-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-1 pb-2 text-xs">
        <span className="font-bold text-foreground">{sources.length} 個來源</span>
        <span className="text-muted-foreground">{videos.length} 集節目</span>
        <span className="text-emerald-400">逐字稿 {completed}/{videos.length}</span>
      </div>

      <section className="space-y-1.5">
        <h3 className="text-xs font-bold text-foreground">來源紅綠燈</h3>
        {sources.map(source => {
          const scan = scanBySource.get(source.source_id);
          const sourceVideos = videos.filter(video => video.source_id === source.source_id);
          const sourceCompleted = sourceVideos.filter(video => transcriptByVideo.get(video.video_id)?.status === 'available').length;
          return (
            <a
              key={source.source_id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-2 transition-colors hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={cn('size-2.5 shrink-0 rounded-full', scan?.error ? 'bg-rose-400' : scan ? 'bg-emerald-400' : 'bg-muted-foreground')} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-foreground">{source.display_name}</span>
                <span className="text-[10px] text-muted-foreground">掃描 {scan?.found_count ?? 0} 集 · 逐字稿 {sourceCompleted}/{sourceVideos.length}</span>
              </span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </a>
          );
        })}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-bold text-foreground">節目處理進度</h3>
        {videos.map(video => (
          <div key={video.video_id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 p-2.5">
            <div className="min-w-0 flex-1">
              <a href={video.url} target="_blank" rel="noreferrer" className="block truncate text-xs font-medium text-foreground transition-colors hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{video.title}</a>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{formatDuration(video.duration_sec)}</p>
            </div>
            <TranscriptBadge transcript={transcriptByVideo.get(video.video_id)} />
          </div>
        ))}
      </section>
    </div>
  );
}

function ConsensusList({ title, items, bullish = false }: { title: string; items: string[]; bullish?: boolean }) {
  const Icon = bullish ? ArrowUpRight : ArrowDownRight;
  return (
    <div className={cn('rounded-lg border p-4', bullish ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5')}>
      <h3 className={cn('flex items-center gap-2 text-sm font-semibold', bullish ? 'text-emerald-400' : 'text-rose-400')}>
        <Icon className="size-4" aria-hidden="true" />{title}
      </h3>
      {items.length ? (
        <ul className="mt-3 space-y-2 text-sm text-foreground/85">
          {items.map((item, index) => <li key={`${item}-${index}`} className="flex gap-2"><span aria-hidden="true">•</span><span>{item}</span></li>)}
        </ul>
      ) : <p className="mt-3 text-sm text-muted-foreground">當日沒有形成明確共識。</p>}
    </div>
  );
}

function StockCard({ stock }: { stock: AggregatedStock }) {
  const scoring = stock.scoring;
  const sourceCount = new Set(stock.mentions.map(mention => mention.source_id)).size;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{stock.name} <span className="ml-1 font-mono text-sm text-muted-foreground">{stock.code}</span></CardTitle>
            <CardDescription className="mt-1">{stock.mentions.length} 次提及 · {sourceCount} 個節目來源</CardDescription>
          </div>
          {scoring && <Badge variant="outline" className={cn('h-8 min-w-12 text-base', ratingClass(scoring.rating))}>{scoring.rating}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-400">偏多 {stock.bullish}</Badge>
          <Badge variant="outline" className="border-rose-500/30 text-rose-400">偏空／風險 {stock.bearish}</Badge>
          {scoring && <span className="ml-auto text-muted-foreground">綜合分數 <strong className="text-foreground">{scoring.composite_score}</strong></span>}
        </div>
        {scoring && (
          <>
            <div className="rounded-md bg-secondary/50 p-3">
              <p className="text-xs font-medium text-muted-foreground">建議動作</p>
              <p className="mt-1 text-sm font-semibold">{scoring.action}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{scoring.reasoning}</p>
            </div>
            {scoring.risk_flags.length > 0 && (
              <div className="flex items-start gap-2 text-xs leading-5 text-amber-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {scoring.risk_flags.join('；')}
              </div>
            )}
          </>
        )}
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="min-h-8 cursor-pointer select-none py-1 font-medium">查看節目提及內容</summary>
          <div className="mt-2 space-y-2 border-t border-border pt-2 text-muted-foreground">
            {stock.mentions.map((mention, index) => (
              <p key={`${mention.video_id}-${index}`}><span className="text-foreground">{mention.source_id}：</span>{mention.context || mention.reason}</p>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function TranscriptBadge({ transcript }: { transcript?: TranscriptState }) {
  if (!transcript || transcript.status === 'pending') {
    return <Badge variant="outline" className="min-h-7 border-border text-muted-foreground"><Clock3 aria-hidden="true" />待轉錄</Badge>;
  }
  if (transcript.status === 'available') {
    return <Badge variant="outline" className="min-h-7 border-emerald-500/30 text-emerald-400"><CheckCircle2 aria-hidden="true" />逐字稿 {transcript.quality_score ?? 0} 分</Badge>;
  }
  return <Badge variant="outline" className="min-h-7 border-rose-500/30 text-rose-400"><AlertTriangle aria-hidden="true" />{transcript.status === 'low_quality' ? '品質不足' : '轉錄失敗'}</Badge>;
}
