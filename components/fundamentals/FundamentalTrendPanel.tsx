'use client';

import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  FundamentalTrendHistory,
  MonthlyFundamentalTrend,
  QuarterlyFundamentalTrend,
} from '@/lib/fundamentals/trends';

function formatAmount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(1)}億`;
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}萬`;
  return value.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

function formatPeriod(period: string, monthly = false): string {
  const match = period.match(/^(\d{4})-(\d{2})/);
  if (!match) return period;
  if (monthly) return `${match[1]}/${Number(match[2])}`;
  return `${match[1].slice(-2)}Q${Math.ceil(Number(match[2]) / 3)}`;
}

function Change({ value, suffix = '%' }: { value: number | null; suffix?: '%' | 'pp' }) {
  if (value == null || !Number.isFinite(value)) return <span className="text-muted-foreground/55">—</span>;
  return (
    <span className={cn('font-mono tabular-nums', value > 0 ? 'text-bull' : value < 0 ? 'text-bear' : 'text-muted-foreground')}>
      {value > 0 ? '+' : ''}{value.toFixed(1)}{suffix}
    </span>
  );
}

function MonthlyTable({ rows }: { rows: MonthlyFundamentalTrend[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/50">
      <div className="grid grid-cols-[4.5rem_minmax(5.5rem,1fr)_4.25rem_4.25rem] gap-1 bg-secondary/45 px-2 py-1.5 text-[9px] text-muted-foreground">
        <span>月份</span><span className="text-right">營收</span><span className="text-right">月增</span><span className="text-right">年增</span>
      </div>
      <div className="divide-y divide-border/30">
        {rows.slice(0, 13).map(row => (
          <div key={row.period} className="grid min-h-8 grid-cols-[4.5rem_minmax(5.5rem,1fr)_4.25rem_4.25rem] items-center gap-1 px-2 text-[10px] even:bg-foreground/[0.018]">
            <span className="font-mono text-muted-foreground">{formatPeriod(row.period, true)}</span>
            <span className="truncate text-right font-mono tabular-nums text-foreground/90" title={row.revenue?.toLocaleString()}>{formatAmount(row.revenue)}</span>
            <span className="text-right"><Change value={row.revenueMoM} /></span>
            <span className="text-right"><Change value={row.revenueYoY} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  qoq,
  yoy,
  margin = false,
}: {
  label: string;
  value: number | null;
  qoq: number | null;
  yoy: number | null;
  margin?: boolean;
}) {
  const displayed = value == null
    ? '—'
    : margin
      ? `${value.toFixed(1)}%`
      : label === 'EPS'
        ? value.toFixed(2)
        : formatAmount(value);
  return (
    <div className="min-w-0 rounded-md bg-background/35 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[9px] text-muted-foreground">{label}</span>
        <span className="truncate font-mono text-[11px] font-semibold tabular-nums text-foreground" title={value?.toString()}>{displayed}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[8px]">
        <span className="text-muted-foreground/65">季</span><Change value={qoq} suffix={margin ? 'pp' : '%'} />
        <span className="text-muted-foreground/65">年</span><Change value={yoy} suffix={margin ? 'pp' : '%'} />
      </div>
    </div>
  );
}

function QuarterCard({ row }: { row: QuarterlyFundamentalTrend }) {
  return (
    <article className="rounded-lg border border-border/45 bg-card/35 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="font-mono text-[11px] font-semibold text-cyan-200">{formatPeriod(row.period)}</h4>
        <span className="text-[8px] text-muted-foreground">單季</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <MetricCell label="營收" value={row.revenue} qoq={row.revenueQoQ} yoy={row.revenueYoY} />
        <MetricCell label="EPS" value={row.eps} qoq={row.epsQoQ} yoy={row.epsYoY} />
        <MetricCell label="毛利率" value={row.grossMargin} qoq={row.grossMarginQoQ} yoy={row.grossMarginYoY} margin />
        <MetricCell label="淨利率" value={row.netMargin} qoq={row.netMarginQoQ} yoy={row.netMarginYoY} margin />
      </div>
    </article>
  );
}

export function FundamentalTrendPanel({ history }: { history: FundamentalTrendHistory }) {
  const latestQuarter = history.quarterly[0]?.period;
  return (
    <section className="space-y-2 rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-2.5 text-xs" aria-label="基本面歷史趨勢">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-cyan-200">基本面歷史趨勢</h3>
          <p className="mt-0.5 text-[9px] leading-snug text-muted-foreground">
            金額與 EPS 顯示季增／年增；毛利率、淨利率顯示季／年變動百分點。
          </p>
        </div>
        {latestQuarter && <span className="shrink-0 rounded bg-cyan-500/10 px-1.5 py-1 font-mono text-[9px] text-cyan-200">更新至 {formatPeriod(latestQuarter)}</span>}
      </div>

      {history.monthlyDisclosure === 'available' ? (
        <details open className="group">
          <summary className="min-h-9 cursor-pointer list-none rounded px-1 py-2 text-[11px] font-semibold text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
            月營收（台股正式月公告） <span className="text-[9px] font-normal text-muted-foreground">近 {Math.min(13, history.monthly.length)}／共 {history.monthly.length} 期</span>
          </summary>
          {history.monthly.length > 0
            ? <MonthlyTable rows={history.monthly} />
            : <div className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-2 text-[10px] text-amber-200">目前資料源未回傳月營收歷史，不以季度資料猜測月數字。</div>}
        </details>
      ) : (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-100">
          A 股公司通常不公告月營收；Rockstar 改用正式季報呈現，不拆分或虛構每月營收。
        </div>
      )}

      <details open className="group">
        <summary className="min-h-9 cursor-pointer list-none rounded px-1 py-2 text-[11px] font-semibold text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
          季度獲利（營收／毛利率／淨利率／EPS） <span className="text-[9px] font-normal text-muted-foreground">近 {Math.min(8, history.quarterly.length)}／共 {history.quarterly.length} 期</span>
        </summary>
        {history.quarterBasis === 'derived-from-cumulative' && (
          <div className="mb-2 rounded border border-sky-500/25 bg-sky-500/10 px-2 py-1.5 text-[9px] leading-snug text-sky-100">
            A 股 Q2、Q3、年報原始值為年初至今累計；以下已先相減還原單季。若期間發生股本變動，單季 EPS 差額僅供趨勢參考。
          </div>
        )}
        <div className="space-y-2">
          {history.quarterly.slice(0, 8).map(row => <QuarterCard key={row.period} row={row} />)}
          {history.quarterly.length === 0 && <div className="text-[10px] text-muted-foreground">目前沒有可用的季度歷史。</div>}
        </div>
      </details>

      <div className="flex items-center justify-between gap-2 border-t border-border/35 pt-2 text-[8px] text-muted-foreground/75">
        <span>缺值顯示「—」，不以 0 或推估值補寫</span>
        {history.sourceUrl ? (
          <a href={history.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-6 shrink-0 items-center gap-1 text-sky-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
            {history.sourceLabel}<ExternalLink aria-hidden="true" className="size-2.5" />
          </a>
        ) : <span className="shrink-0">{history.sourceLabel}</span>}
      </div>
    </section>
  );
}
