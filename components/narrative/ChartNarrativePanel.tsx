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

export default function ChartNarrativePanel({ narrative }: { narrative: ChartNarrative }) {
  const style = TONE_STYLE[narrative.tone];

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
        <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 rounded-lg bg-background/25 px-2.5 py-2">
          <dt className="font-semibold text-sky-200">確認</dt>
          <dd className="text-foreground/75">{narrative.confirmation}</dd>
        </div>
        <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 rounded-lg bg-background/25 px-2.5 py-2">
          <dt className="font-semibold text-amber-200">失效</dt>
          <dd className="text-foreground/75">{narrative.invalidation}</dd>
        </div>
      </dl>

      <details className="group mt-2 border-t border-border/35 pt-1.5">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-[11px] font-semibold text-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
          判讀依據
          <span className="font-normal text-muted-foreground/70">
            {EVIDENCE_LABEL[narrative.evidenceLevel]} · {narrative.events.length} 項訊號
          </span>
        </summary>
        <ul className="space-y-1.5 pb-1 pl-4 text-[11px] leading-relaxed text-foreground/70">
          {narrative.events.slice(0, 4).map(event => (
            <li key={event.id}>
              <span className="font-semibold text-foreground/80">{event.label}</span>
              <span className="text-muted-foreground/65"> · {event.sourceFamily}</span>
            </li>
          ))}
          {narrative.blockers.slice(1, 3).map(blocker => (
            <li key={blocker} className="text-amber-200/80">{blocker}</li>
          ))}
          {narrative.events.length > 4 && (
            <li className="text-muted-foreground/60">
              另有 {narrative.events.length - 4} 項較低優先訊號
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
