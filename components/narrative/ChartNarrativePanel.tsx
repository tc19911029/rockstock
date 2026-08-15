import type { ChartNarrative } from '@/lib/narrative/types';

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

const EVIDENCE_LABEL: Record<ChartNarrative['evidenceLevel'], string> = {
  high: '多面向',
  medium: '雙面向',
  low: '單一面向',
};

const CONFIRMATION_LABEL: Record<ChartNarrative['action'], string> = {
  exit: '現在處理',
  reduce: '持續追蹤',
  'evaluate-entry': '進場前確認',
  hold: '續抱條件',
  wait: '等待確認',
  'avoid-entry': '目前處理',
};

const CATEGORY_LABEL: Record<ChartNarrative['events'][number]['category'], string> = {
  risk: '風險',
  exit: '出場',
  entry: '進場',
  kline: 'K線',
  trend: '趨勢',
  watch: '觀察',
};

export default function ChartNarrativePanel({ narrative }: { narrative: ChartNarrative }) {
  const style = TONE_STYLE[narrative.tone];
  const visibleEvents = [narrative.primaryEvent, ...narrative.secondaryEvents];
  const categoryCounts = narrative.events.reduce<Partial<Record<keyof typeof CATEGORY_LABEL, number>>>((counts, event) => {
    counts[event.category] = (counts[event.category] ?? 0) + 1;
    return counts;
  }, {});
  const categorySummary = (Object.keys(CATEGORY_LABEL) as Array<keyof typeof CATEGORY_LABEL>)
    .filter(category => (categoryCounts[category] ?? 0) > 0)
    .map(category => `${CATEGORY_LABEL[category]} ${categoryCounts[category]}`)
    .join(' · ');

  return (
    <section
      aria-label="走圖解說"
      className={`rounded-xl border ${style.border} bg-secondary/20 p-3`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-foreground/90">走圖解說</span>
        <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-medium text-foreground/70">
          {narrative.phase}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${style.badge}`}>
          {narrative.actionLabel}
        </span>
      </div>

      <h2 className={`mt-2 text-sm font-bold leading-snug ${style.headline}`}>
        {narrative.headline}
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-foreground/75">
        {narrative.summary}
      </p>

      <dl className="mt-2 grid gap-1.5 text-[11px] leading-relaxed">
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded-lg bg-background/25 px-2.5 py-2">
          <dt className="font-semibold text-sky-200">{CONFIRMATION_LABEL[narrative.action]}</dt>
          <dd className="text-foreground/75">{narrative.confirmation}</dd>
        </div>
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded-lg bg-background/25 px-2.5 py-2">
          <dt className="font-semibold text-amber-200">重判條件</dt>
          <dd className="text-foreground/75">{narrative.invalidation}</dd>
        </div>
      </dl>

      <details className="group mt-2 border-t border-border/35 pt-1.5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-[11px] font-semibold text-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
          判讀依據
          <span className="font-normal text-muted-foreground/70">
            {EVIDENCE_LABEL[narrative.evidenceLevel]} · {narrative.events.length} 項依據
          </span>
        </summary>
        <ul className="space-y-1.5 pb-1 pl-4 text-[11px] leading-relaxed text-foreground/70">
          <li className="text-muted-foreground/60">{categorySummary}</li>
          {visibleEvents.map(event => (
            <li key={event.id}>
              <span className="font-semibold text-foreground/80">{event.label}</span>
              <span className="text-muted-foreground/65"> · {event.sourceFamily}</span>
            </li>
          ))}
          {narrative.blockers.slice(1, 3).map(blocker => (
            <li key={blocker} className="text-amber-200/80">{blocker}</li>
          ))}
          {narrative.events.length > visibleEvents.length && (
            <li className="text-muted-foreground/60">
              另有 {narrative.events.length - visibleEvents.length} 項較低優先依據
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
