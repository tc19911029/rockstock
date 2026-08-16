import type { ChartNarrative } from '@/lib/narrative/types';
import type { SignalPanelActionPlan } from '@/lib/portfolio/signalPanelPlan';

const TONE_STYLE: Record<ChartNarrative['tone'], {
  border: string;
  badge: string;
  headline: string;
}> = {
  bullish: {
    border: 'border-rose-500/35',
    badge: 'bg-rose-500/15 text-rose-200 ring-rose-500/25',
    headline: 'text-rose-200',
  },
  bearish: {
    border: 'border-emerald-500/35',
    badge: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/25',
    headline: 'text-emerald-200',
  },
  warning: {
    border: 'border-amber-500/35',
    badge: 'bg-amber-500/15 text-amber-200 ring-amber-500/25',
    headline: 'text-amber-200',
  },
  neutral: {
    border: 'border-sky-500/30',
    badge: 'bg-sky-500/15 text-sky-200 ring-sky-500/25',
    headline: 'text-foreground/85',
  },
};

const ACTION_PLAN_STYLE: Record<SignalPanelActionPlan['tone'], string> = {
  danger: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-100',
  warning: 'border-amber-500/35 bg-amber-500/10 text-amber-100',
  positive: 'border-rose-500/35 bg-rose-500/10 text-rose-100',
  neutral: 'border-sky-500/30 bg-sky-500/10 text-sky-100',
};

const DISPOSITION_LABEL: Record<ChartNarrative['evidenceGroups'][number]['disposition'], string> = {
  adopted: '採納',
  conflicting: '衝突未採納',
  background: '背景',
};

const DISPOSITION_STYLE: Record<ChartNarrative['evidenceGroups'][number]['disposition'], string> = {
  adopted: 'text-sky-200',
  conflicting: 'text-amber-200',
  background: 'text-muted-foreground/75',
};

export default function ChartNarrativePanel({
  narrative,
  actionPlan,
}: {
  narrative: ChartNarrative;
  actionPlan: SignalPanelActionPlan;
}) {
  const style = TONE_STYLE[narrative.tone];
  const adoptedCount = narrative.evidenceGroups.filter(group => group.disposition === 'adopted').length;
  const conflictingCount = narrative.evidenceGroups.filter(group => group.disposition === 'conflicting').length;
  const backgroundCount = narrative.evidenceGroups.filter(group => group.disposition === 'background').length;
  const trendlineEvents = narrative.events.filter(event => event.sourceRuleIds.some(ruleId => (
    ruleId === 'trendline-breakout-bullish' || ruleId === 'trendline-breakout-bearish'
  )));

  return (
    <section
      aria-label="走圖解說"
      className={`rounded-xl border ${style.border} bg-secondary/20 p-3`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-foreground/90">走圖解說</span>
        <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-medium text-foreground/75">
          大結構：{narrative.phase}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${style.badge}`}>
          {narrative.actionLabel}
        </span>
      </div>

      <h2 className={`mt-2 text-base font-bold leading-snug ${style.headline}`}>
        {narrative.headline}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-foreground/80">
        {narrative.summary}
      </p>

      {trendlineEvents.length > 0 && (
        <aside aria-label="切線結構進展" className="mt-2 rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold text-sky-200">結構進展</span>
            {trendlineEvents.map(event => (
              <span key={event.id} className="rounded-full bg-sky-400/10 px-2 py-0.5 font-medium text-sky-100 ring-1 ring-sky-400/25">
                {event.label}
              </span>
            ))}
          </div>
          {trendlineEvents.map(event => (
            <p key={`${event.id}:detail`} className="mt-1 text-[11px] leading-relaxed text-foreground/75">
              {event.description}
            </p>
          ))}
        </aside>
      )}

      <div className={`mt-2 rounded-lg border px-3 py-2.5 ${ACTION_PLAN_STYLE[actionPlan.tone]}`}>
        <p className="text-sm font-bold">{actionPlan.label}</p>
        <p className="mt-1 text-xs leading-relaxed text-foreground/85">{actionPlan.detail}</p>
      </div>

      <dl className="mt-2 text-xs leading-relaxed">
        <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-2 rounded-lg bg-background/25 px-2.5 py-2">
          <dt className="font-semibold text-amber-200">重新判讀</dt>
          <dd className="text-foreground/80">{narrative.invalidation}</dd>
        </div>
      </dl>

      <details className="group mt-2 border-t border-border/35 pt-1.5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-xs font-semibold text-foreground/75 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
          判讀依據
          <span className="font-normal text-muted-foreground/75">
            採納 {adoptedCount} 組
            {conflictingCount > 0 ? ` · 衝突 ${conflictingCount} 組` : ''}
            {backgroundCount > 0 ? ` · 背景 ${backgroundCount} 組` : ''}
          </span>
        </summary>
        <ul className="space-y-2 pb-1 pl-4 text-xs leading-relaxed text-foreground/75">
          {narrative.evidenceGroups.map(group => (
            <li key={group.key}>
              <span className={`font-semibold ${DISPOSITION_STYLE[group.disposition]}`}>
                {DISPOSITION_LABEL[group.disposition]}
              </span>
              <span className="text-foreground/85"> · {group.label}</span>
              {group.eventCount > 1 && (
                <span className="text-muted-foreground/75"> · {group.eventCount} 個同源命中</span>
              )}
              {(group.eventCount > 1 || group.eventLabels[0] !== group.label) && (
                <p className="mt-0.5 text-[11px] text-muted-foreground/75">
                  {group.eventLabels.slice(0, 3).join('、')}
                  {group.eventCount > 3 ? `，另 ${group.eventCount - 3} 個` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
