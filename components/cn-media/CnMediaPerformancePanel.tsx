'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowRight, RefreshCw, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  CnMediaHorizonSummary,
  CnMediaProgramPerformance,
  CnMediaRecommendationPerformance,
} from '@/lib/cn-media/performance';

interface PerformanceResponse {
  ok: boolean;
  from: string;
  to: string;
  methodology: string;
  analysis_dates: string[];
  missing_analysis_dates: string[];
  episode_count: number;
  recommendation_count: number;
  programs: CnMediaProgramPerformance[];
  events: CnMediaRecommendationPerformance[];
  error?: string;
}

function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function pct(value: number | null): string {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function Metric({ label, value }: { label: string; value: CnMediaHorizonSummary }) {
  return (
    <div className="min-w-0 rounded border border-border/60 bg-secondary/25 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{label}</span><span>n={value.samples}</span>
      </div>
      {value.samples ? (
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <span className="text-xs font-bold tabular-nums text-foreground">命中 {value.hit_rate?.toFixed(0)}%</span>
          <span className={cn('text-[10px] tabular-nums', (value.avg_return ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
            均 {pct(value.avg_return)}
          </span>
        </div>
      ) : <p className="mt-1 text-[10px] text-muted-foreground/70">尚未成熟</p>}
    </div>
  );
}

export function CnMediaPerformancePanel() {
  const [from, setFrom] = useState('2026-08-10');
  const [to, setTo] = useState(todayShanghai);
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/cn-media/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cache: 'no-store' });
      const body = await response.json() as PerformanceResponse;
      if (!response.ok || !body.ok) throw new Error(body.error || '績效 API 回傳失敗');
      setData(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法載入績效');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const changeFrom = (next: string) => {
    setFrom(next);
    if (next > to) setTo(next);
  };

  const changeTo = (next: string) => {
    setTo(next);
    if (next < from) setFrom(next);
  };

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="cn-media-performance-title">
      <div className="shrink-0 space-y-2 border-b border-border bg-secondary/30 px-2.5 py-2">
        <div className="flex items-center gap-2 text-xs">
          <TrendingUp className="size-3.5 text-sky-400" aria-hidden="true" />
          <h2 id="cn-media-performance-title" className="font-bold text-foreground">陸股節目績效</h2>
          {loading && <span className="ml-auto animate-pulse text-[10px] text-sky-400">計算中…</span>}
          <button type="button" onClick={() => void load()} disabled={loading} className="ml-auto flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50" aria-label="重新計算績效">
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden="true" />
          </button>
        </div>
        <fieldset className="flex flex-wrap items-end gap-2" aria-label="績效統計區間">
          <legend className="sr-only">績效統計區間</legend>
          <label className="min-w-36 flex-1 space-y-1 text-[10px] font-medium text-muted-foreground">
            <span>起日</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => changeFrom(event.target.value)}
              className="min-h-11 w-full cursor-pointer rounded border border-border bg-card px-2 font-mono text-xs tabular-nums text-foreground outline-none transition-colors [color-scheme:dark] hover:border-sky-500/50 focus-visible:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400/30"
            />
          </label>
          <ArrowRight className="mb-3 hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
          <label className="min-w-36 flex-1 space-y-1 text-[10px] font-medium text-muted-foreground">
            <span>迄日</span>
            <input
              type="date"
              value={to}
              min={from}
              max={todayShanghai()}
              onChange={(event) => changeTo(event.target.value)}
              className="min-h-11 w-full cursor-pointer rounded border border-border bg-card px-2 font-mono text-xs tabular-nums text-foreground outline-none transition-colors [color-scheme:dark] hover:border-sky-500/50 focus-visible:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400/30"
            />
          </label>
        </fieldset>
      </div>

      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto px-2.5 pb-4 pt-2">
        {error && <div className="rounded border border-red-700/40 p-2.5 text-xs text-red-400">載入失敗：{error}</div>}
        {data && (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                ['已抓節目', `${data.episode_count} 集`],
                ['完成分析', `${data.analysis_dates.length} 日`],
                ['明確多空', `${data.recommendation_count} 筆`],
              ].map(([label, value]) => (
                <div key={label} className="rounded border border-border/60 bg-card/60 px-2 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">{label}</p>
                  <p className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{value}</p>
                </div>
              ))}
            </div>

            {data.missing_analysis_dates.length > 0 && (
              <div className="flex items-start gap-2 rounded border border-amber-800/40 bg-amber-950/20 p-2.5 text-[11px] leading-relaxed text-amber-300">
                <Activity className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>仍在補分析：{data.missing_analysis_dates.join('、')}。目前排行是暫時值，完成後會自動納入。</span>
              </div>
            )}

            <p className="text-[10px] leading-relaxed text-muted-foreground">{data.methodology} D1／D3 未到期的推薦不計入分母。</p>

            <section className="space-y-2">
              {data.programs.map((program, index) => (
                <div key={program.source_id} className="rounded-lg border border-border/60 bg-card/50 p-2.5">
                  <div className="flex items-start gap-2">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded bg-secondary text-[10px] font-bold text-muted-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-xs font-bold text-foreground">{program.display_name}</h3>
                        <span className={cn('rounded px-1 py-0.5 text-[9px]', program.source_tier === 'official_media' ? 'bg-sky-500/10 text-sky-400' : 'bg-violet-500/10 text-violet-400')}>
                          {program.source_tier === 'official_media' ? '官方' : '創作者'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {program.episode_count} 集 · {program.recommendation_count} 筆明確多空 · {program.unique_stock_count} 檔股票
                        {program.pending_d1_count > 0 && ` · ${program.pending_d1_count} 筆待 D1`}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <Metric label="隔日 D1" value={program.horizons.d1Return} />
                    <Metric label="三日 D3" value={program.horizons.d3Return} />
                  </div>
                </div>
              ))}
            </section>

            {data.events.length > 0 && (
              <details className="rounded-lg border border-border/60 bg-card/40 p-2.5 text-xs">
                <summary className="min-h-8 cursor-pointer font-semibold text-foreground">推薦明細（{data.events.length}）</summary>
                <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                  {data.events.slice(0, 30).map(event => (
                    <div key={`${event.date}-${event.source_id}-${event.stock_code}`} className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-foreground">{event.stock_name} {event.stock_code}</p>
                        <p className="truncate text-[10px] text-muted-foreground">{event.date} · {event.display_name} · {event.direction === 'bullish' ? '看多' : '看空'}</p>
                      </div>
                      <span className={cn('shrink-0 text-[10px] tabular-nums', ((event.direction === 'bullish' ? 1 : -1) * (event.raw_performance.d1Return ?? 0)) >= 0 ? 'text-bull' : 'text-bear')}>
                        D1 {pct(event.raw_performance.d1Return == null ? null : (event.direction === 'bullish' ? event.raw_performance.d1Return : -event.raw_performance.d1Return))}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
