'use client';

import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { PageShell, PageHeader, DataTable, EmptyState } from '@/components/shared';
import { bullBearClass } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LeaderboardRow, Horizon, Market } from '@/lib/backtest/leaderboardTypes';
import { SamplePicksPanel } from './_components/SamplePicksPanel';

type EngineFilter = 'all' | 'buymethod' | 'sanse';

interface ApiResponse {
  ok: boolean;
  market: Market;
  exists: boolean;
  generatedAt: string | null;
  window?: { start: string; end: string; tradingDays: number; label: string; forwardTd: number };
  meta?: { minPicks: number };
  rows: LeaderboardRow[];
}

const HORIZONS: Horizon[] = ['d1', 'd3', 'd5'];
const fmtPct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const cstTime = (iso: string): string =>
  new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

export default function StrategyLeaderboardPage() {
  // useSearchParams 必須包在 Suspense 內，否則 prod prerender 失敗（同 fundamental-revaluation 頁）
  return (
    <Suspense fallback={null}>
      <LeaderboardInner />
    </Suspense>
  );
}

function LeaderboardInner() {
  const params = useSearchParams();
  const [market, setMarket] = useState<Market>('TW');
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('all');
  const [horizon, setHorizon] = useState<Horizon>('d1');
  const [minDays, setMinDays] = useState<number>(20);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [resp, setResp] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // 從 URL 同步初始市場
  useEffect(() => {
    const qs = params.get('market')?.toUpperCase();
    if (qs === 'TW' || qs === 'CN') setMarket(qs);
  }, [params]);

  // 防止「寫 URL」effect 在掛載當下用預設值蓋掉進來的 ?market=（deep-link race）
  const didMountRef = useRef(false);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setExpandedId(null);
    fetch(`/api/backtest/leaderboard?market=${market}`)
      .then((r) => r.json() as Promise<ApiResponse>)
      .then((json) => { if (!aborted) setResp(json); })
      .catch(() => { if (!aborted) setResp(null); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [market]);

  // URL 同步（不重整）— 跳過首次掛載，避免蓋掉進來的 ?market= deep-link
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    const url = new URL(window.location.href);
    url.searchParams.set('market', market);
    window.history.replaceState(null, '', url.toString());
  }, [market]);

  const rows = useMemo<LeaderboardRow[]>(() => {
    const all = resp?.rows ?? [];
    return all
      .filter((r) => (engineFilter === 'all' ? true : r.engine === engineFilter))
      .filter((r) => r.days >= minDays)
      .sort((a, b) => b.byHorizon[horizon].top1.avgPct - a.byHorizon[horizon].top1.avgPct);
  }, [resp, engineFilter, minDays, horizon]);

  const expandedRow = useMemo(
    () => rows.find((r) => r.id === expandedId) ?? null,
    [rows, expandedId],
  );

  const columns = useMemo<ColumnDef<LeaderboardRow, unknown>[]>(() => {
    const numCell = (getValue: () => unknown) => {
      const v = getValue() as number;
      return <span className={cn('font-mono tabular-nums', bullBearClass(v))}>{fmtPct(v)}</span>;
    };
    const horizonCols: ColumnDef<LeaderboardRow, unknown>[] = HORIZONS.map((h) => ({
      id: `top1_${h}`,
      accessorFn: (r) => r.byHorizon[h].top1.avgPct,
      header: () => (
        <span className={cn(h === horizon && 'text-foreground font-semibold')}>{h} top1平均</span>
      ),
      cell: ({ getValue }) => (
        <span className={cn(h === horizon && 'rounded bg-primary/5 px-1')}>{numCell(getValue)}</span>
      ),
      sortingFn: 'basic',
    }));
    return [
      {
        id: 'strategy',
        accessorFn: (r) => `${r.strategyLabel} ${r.sortLabel}`,
        header: '策略',
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex items-center gap-1.5 min-w-[10rem]">
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                  r.engine === 'buymethod'
                    ? 'bg-blue-500/15 text-blue-500'
                    : 'bg-purple-500/15 text-purple-500',
                )}
              >
                {r.engine === 'buymethod' ? '買法' : '三色'}
              </span>
              <span className="font-medium">{r.strategyLabel}</span>
            </div>
          );
        },
        enableSorting: false,
      },
      {
        id: 'sort',
        accessorFn: (r) => r.sortLabel,
        header: '排序',
        cell: ({ getValue }) => <span className="text-muted-foreground">{getValue() as string}</span>,
        enableSorting: false,
      },
      {
        id: 'days',
        accessorFn: (r) => r.days,
        header: '天數',
        cell: ({ getValue }) => <span className="font-mono tabular-nums text-muted-foreground">{getValue() as number}</span>,
        sortingFn: 'basic',
      },
      ...horizonCols,
      {
        id: 'win',
        accessorFn: (r) => r.byHorizon[horizon].top1.winRatePct,
        header: () => <span>{horizon} 勝率</span>,
        cell: ({ getValue }) => <span className="font-mono tabular-nums">{(getValue() as number).toFixed(0)}%</span>,
        sortingFn: 'basic',
      },
      {
        id: 'top5',
        accessorFn: (r) => r.byHorizon[horizon].top5.avgPct,
        header: () => <span>{horizon} top5平均</span>,
        cell: ({ getValue }) => numCell(getValue),
        sortingFn: 'basic',
      },
      {
        id: 'cohort',
        accessorFn: (r) => r.byHorizon[horizon].cohort.avgPct,
        header: () => <span>{horizon} 全體</span>,
        cell: ({ getValue }) => numCell(getValue),
        sortingFn: 'basic',
      },
      {
        id: 'alpha',
        accessorFn: (r) => r.byHorizon[horizon].sortAlphaPct,
        header: () => <span>排序alpha</span>,
        cell: ({ getValue }) => numCell(getValue),
        sortingFn: 'basic',
      },
    ];
  }, [horizon]);

  const hasData = resp?.exists && (resp.rows?.length ?? 0) > 0;

  return (
    <PageShell
      headerSlot={
        <PageHeader
          title="📊 策略排行榜"
          subtitle={
            resp?.exists && resp.window ? (
              <span>
                {market === 'TW' ? '台股' : '陸股'} · {resp.window.start}~{resp.window.end} ·{' '}
                {resp.window.tradingDays} 交易日 · 隔日開盤進場
                {resp.generatedAt && <> · 產於 {cstTime(resp.generatedAt)}</>}
              </span>
            ) : (
              <span>{market === 'TW' ? '台股' : '陸股'} · 各策略×排序的 d1/d3/d5 漲幅</span>
            )
          }
          backButton
        />
      }
    >
      <div className="space-y-4 p-4">
        {/* 控制列 */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {(['TW', 'CN'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium transition-colors',
                  market === m ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary',
                )}
              >
                {m === 'TW' ? '台股' : '陸股'}
              </button>
            ))}
          </div>

          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {([
              { k: 'all', label: '全部' },
              { k: 'buymethod', label: '買法' },
              { k: 'sanse', label: '三色' },
            ] as { k: EngineFilter; label: string }[]).map((e) => (
              <button
                key={e.k}
                onClick={() => setEngineFilter(e.k)}
                className={cn(
                  'px-3 py-1.5 text-sm transition-colors',
                  engineFilter === e.k ? 'bg-primary/15 text-primary font-medium' : 'bg-card hover:bg-secondary',
                )}
              >
                {e.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground text-xs">看</span>
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded transition-colors',
                  horizon === h ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-secondary text-muted-foreground',
                )}
              >
                {h}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground text-xs">樣本≥</span>
            {[1, 20, 100, 300].map((n) => (
              <button
                key={n}
                onClick={() => setMinDays(n)}
                className={cn(
                  'px-2 py-1 text-xs rounded transition-colors',
                  minDays === n ? 'bg-primary/15 text-primary font-medium' : 'hover:bg-secondary text-muted-foreground',
                )}
              >
                {n === 300 ? '300天(常出現)' : `${n}天`}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          把每個「策略 × 排序」當選股器：每天依排序取名次、隔日開盤進場，量 d1/d3/d5 收盤報酬。
          <span className="text-bull">紅</span>=漲、<span className="text-bear">綠</span>=跌。
          <b>排序alpha</b> = top1平均 − 全體平均（&gt;0 代表排序真的把贏家排前面）。點一列看實際選到的股票。
        </p>

        {/* 表格 / 空狀態 */}
        {!loading && !hasData ? (
          <EmptyState
            icon="📊"
            title="策略排行榜尚未產生"
            description="2 年回測 harness 需要時間；產生後此頁會自動顯示。執行 scripts/backtest-unified-leaderboard.ts。"
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={rows}
              loading={loading}
              searchKey="strategy"
              searchPlaceholder="搜尋策略 / 排序…"
              emptyMessage="此條件下無足量樣本"
              onRowClick={(r) => setExpandedId((cur) => (cur === r.id ? null : r.id))}
            />
            {expandedRow && <SamplePicksPanel row={expandedRow} />}
          </>
        )}
      </div>
    </PageShell>
  );
}
