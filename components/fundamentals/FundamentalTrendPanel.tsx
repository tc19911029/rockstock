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

function ChangePair({ label, value, suffix = '%' }: { label: string; value: number | null; suffix?: '%' | 'pp' }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap">
      <span className="shrink-0 text-muted-foreground/65">{label}</span>
      <span className="min-w-0 truncate"><Change value={value} suffix={suffix} /></span>
    </span>
  );
}

function SnapshotCard({
  label,
  period,
  value,
  primaryChange,
  secondaryChange,
  primaryLabel,
  secondaryLabel,
  margin = false,
}: {
  label: string;
  period: string | null;
  value: number | null;
  primaryChange: number | null;
  secondaryChange: number | null;
  primaryLabel: string;
  secondaryLabel: string;
  margin?: boolean;
}) {
  const displayed = value == null
    ? '—'
    : margin
      ? `${value.toFixed(1)}%`
      : label === '單季 EPS'
        ? value.toFixed(2)
        : formatAmount(value);
  return (
    <article className="min-w-0 rounded-lg border border-border/45 bg-card/45 px-2.5 py-2">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[9px] text-muted-foreground">{label}</span>
        {period && <span className="shrink-0 font-mono text-[8px] text-muted-foreground/65">{period}</span>}
      </div>
      <div className="mt-1 truncate font-mono text-sm font-bold tabular-nums text-foreground" title={value?.toString()}>{displayed}</div>
      <div className="mt-1 grid min-w-0 grid-cols-2 gap-1 text-[8px]">
        <ChangePair label={primaryLabel} value={primaryChange} suffix={margin ? 'pp' : '%'} />
        <ChangePair label={secondaryLabel} value={secondaryChange} suffix={margin ? 'pp' : '%'} />
      </div>
    </article>
  );
}

function MonthlyTable({ rows }: { rows: MonthlyFundamentalTrend[] }) {
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/50">
      <table className="w-full table-fixed text-[10px]" aria-label="月營收歷史">
        <colgroup>
          <col className="w-[23%]" />
          <col className="w-[31%]" />
          <col className="w-[23%]" />
          <col className="w-[23%]" />
        </colgroup>
        <thead className="bg-secondary/45 text-[9px] text-muted-foreground">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-left font-normal">月份</th>
            <th scope="col" className="px-1 py-1.5 text-right font-normal">營收</th>
            <th scope="col" className="px-1 py-1.5 text-right font-normal">月增</th>
            <th scope="col" className="px-2 py-1.5 text-right font-normal">年增</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
        {rows.slice(0, 13).map(row => (
          <tr key={row.period} className="h-8 even:bg-foreground/[0.018]">
            <td className="truncate px-2 font-mono text-muted-foreground">{formatPeriod(row.period, true)}</td>
            <td className="truncate px-1 text-right font-mono tabular-nums text-foreground/90" title={row.revenue?.toLocaleString()}>{formatAmount(row.revenue)}</td>
            <td className="truncate px-1 text-right"><Change value={row.revenueMoM} /></td>
            <td className="truncate px-2 text-right"><Change value={row.revenueYoY} /></td>
          </tr>
        ))}
        </tbody>
      </table>
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
      <div className="mt-0.5 grid min-w-0 grid-cols-2 gap-1 text-[8px]">
        <ChangePair label="季" value={qoq} suffix={margin ? 'pp' : '%'} />
        <ChangePair label="年" value={yoy} suffix={margin ? 'pp' : '%'} />
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
  const latestMonth = history.monthly[0] ?? null;
  const latestQuarter = history.quarterly[0] ?? null;
  const primaryRevenue = history.monthlyDisclosure === 'available' && latestMonth
    ? {
        label: '最新月營收',
        period: formatPeriod(latestMonth.period, true),
        value: latestMonth.revenue,
        first: latestMonth.revenueMoM,
        second: latestMonth.revenueYoY,
        firstLabel: '月',
        secondLabel: '年',
      }
    : {
        label: '最新單季營收',
        period: latestQuarter ? formatPeriod(latestQuarter.period) : null,
        value: latestQuarter?.revenue ?? null,
        first: latestQuarter?.revenueQoQ ?? null,
        second: latestQuarter?.revenueYoY ?? null,
        firstLabel: '季',
        secondLabel: '年',
      };
  return (
    <section className="space-y-2 rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-2.5 text-xs" aria-label="基本面歷史趨勢">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-cyan-200">基本面歷史趨勢</h3>
          <p className="mt-0.5 text-[9px] leading-snug text-muted-foreground">
            金額與 EPS 顯示季增／年增；毛利率、淨利率顯示季／年變動百分點。
          </p>
        </div>
        {latestQuarter && <span className="shrink-0 rounded bg-cyan-500/10 px-1.5 py-1 font-mono text-[9px] text-cyan-200">更新至 {formatPeriod(latestQuarter.period)}</span>}
      </div>

      <div aria-label="最新基本面摘要">
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <h4 className="text-[10px] font-semibold text-foreground/90">最新摘要</h4>
          <span className="text-[8px] text-muted-foreground">先看變化，再展開歷史</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <SnapshotCard
            label={primaryRevenue.label}
            period={primaryRevenue.period}
            value={primaryRevenue.value}
            primaryChange={primaryRevenue.first}
            secondaryChange={primaryRevenue.second}
            primaryLabel={primaryRevenue.firstLabel}
            secondaryLabel={primaryRevenue.secondLabel}
          />
          <SnapshotCard
            label="單季 EPS"
            period={latestQuarter ? formatPeriod(latestQuarter.period) : null}
            value={latestQuarter?.eps ?? null}
            primaryChange={latestQuarter?.epsQoQ ?? null}
            secondaryChange={latestQuarter?.epsYoY ?? null}
            primaryLabel="季"
            secondaryLabel="年"
          />
          <SnapshotCard
            label="毛利率"
            period={latestQuarter ? formatPeriod(latestQuarter.period) : null}
            value={latestQuarter?.grossMargin ?? null}
            primaryChange={latestQuarter?.grossMarginQoQ ?? null}
            secondaryChange={latestQuarter?.grossMarginYoY ?? null}
            primaryLabel="季"
            secondaryLabel="年"
            margin
          />
          <SnapshotCard
            label="淨利率"
            period={latestQuarter ? formatPeriod(latestQuarter.period) : null}
            value={latestQuarter?.netMargin ?? null}
            primaryChange={latestQuarter?.netMarginQoQ ?? null}
            secondaryChange={latestQuarter?.netMarginYoY ?? null}
            primaryLabel="季"
            secondaryLabel="年"
            margin
          />
        </div>
      </div>

      {history.monthlyDisclosure === 'available' ? (
        <details className="group rounded-lg border border-border/40 bg-background/20">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded px-2.5 py-2 text-[11px] font-semibold text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
            <span className="min-w-0 truncate">月營收歷史 <span className="text-[9px] font-normal text-muted-foreground">台股正式月公告</span></span>
            <span className="shrink-0 text-[9px] font-normal text-cyan-200">{Math.min(13, history.monthly.length)}/{history.monthly.length} · 展開</span>
          </summary>
          <div className="px-2 pb-2">
            {history.monthly.length > 0
              ? <MonthlyTable rows={history.monthly} />
              : <div className="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-2 text-[10px] text-amber-200">目前資料源未回傳月營收歷史，不以季度資料猜測月數字。</div>}
          </div>
        </details>
      ) : (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-100">
          A 股公司通常不公告月營收；Rockstar 改用正式季報呈現，不拆分或虛構每月營收。
        </div>
      )}

      <details className="group rounded-lg border border-border/40 bg-background/20">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded px-2.5 py-2 text-[11px] font-semibold text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
          <span className="min-w-0 truncate">季度獲利歷史 <span className="text-[9px] font-normal text-muted-foreground">營收／毛利率／淨利率／EPS</span></span>
          <span className="shrink-0 text-[9px] font-normal text-cyan-200">{Math.min(8, history.quarterly.length)}/{history.quarterly.length} · 展開</span>
        </summary>
        <div className="px-2 pb-2">
          {history.quarterBasis === 'derived-from-cumulative' && (
            <div className="mb-2 rounded border border-sky-500/25 bg-sky-500/10 px-2 py-1.5 text-[9px] leading-snug text-sky-100">
              A 股 Q2、Q3、年報原始值為年初至今累計；以下已先相減還原單季。若期間發生股本變動，單季 EPS 差額僅供趨勢參考。
            </div>
          )}
          <div className="space-y-2">
            {history.quarterly.slice(0, 8).map(row => <QuarterCard key={row.period} row={row} />)}
            {history.quarterly.length === 0 && <div className="text-[10px] text-muted-foreground">目前沒有可用的季度歷史。</div>}
          </div>
        </div>
      </details>

      <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/35 pt-2 text-[8px] text-muted-foreground/75">
        <span className="min-w-0">缺值顯示「—」，不以 0 或推估值補寫</span>
        {history.sourceUrl ? (
          <a href={history.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-6 min-w-0 items-center gap-1 text-right text-sky-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
            {history.sourceLabel}<ExternalLink aria-hidden="true" className="size-2.5" />
          </a>
        ) : <span className="shrink-0">{history.sourceLabel}</span>}
      </div>
    </section>
  );
}
