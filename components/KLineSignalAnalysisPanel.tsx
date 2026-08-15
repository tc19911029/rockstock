import type {
  KLinePatternDirection,
  KLineSignalAnalysis,
} from '@/lib/rules/klineSignalAnalysis';
import { presentKLineAnalysis, type KLinePresentationContext } from '@/lib/rules/klinePresentation';

const DIRECTION_STYLE: Record<KLinePatternDirection, {
  border: string;
  badge: string;
  title: string;
}> = {
  bullish: {
    border: 'border-rose-500/30',
    badge: 'bg-rose-500/15 text-rose-200 ring-rose-500/25',
    title: 'text-rose-200',
  },
  bearish: {
    border: 'border-emerald-500/30',
    badge: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/25',
    title: 'text-emerald-200',
  },
  neutral: {
    border: 'border-sky-500/30',
    badge: 'bg-sky-500/15 text-sky-200 ring-sky-500/25',
    title: 'text-sky-200',
  },
};

export default function KLineSignalAnalysisPanel({
  analyses,
  showHeader = true,
  context,
}: {
  analyses: KLineSignalAnalysis[];
  showHeader?: boolean;
  context?: KLinePresentationContext;
}) {
  const bullishCount = analyses.filter(item => item.direction === 'bullish').length;
  const bearishCount = analyses.filter(item => item.direction === 'bearish').length;
  const formingCount = analyses.filter(item => item.state === 'forming').length;

  return (
    <section
      aria-label={showHeader ? undefined : 'K 線型態分析明細'}
      aria-labelledby={showHeader ? 'kline-analysis-title' : undefined}
      className={showHeader ? 'border-t border-border/40 pt-2 space-y-2' : 'space-y-2'}
    >
      {showHeader && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 id="kline-analysis-title" className="text-xs font-semibold text-foreground/90">
              K 線型態分析
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/70">
              依趨勢、位置與確認條件解讀，不只看 K 棒外形。
            </p>
          </div>
          {analyses.length > 0 && (
            <div className="flex flex-wrap gap-1 text-[10px]" aria-label="K 線型態統計">
              {bullishCount > 0 && (
                <span className="rounded-full bg-rose-500/15 px-2 py-1 font-semibold text-rose-200">
                  多方 {bullishCount}
                </span>
              )}
              {bearishCount > 0 && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-1 font-semibold text-emerald-200">
                  空方 {bearishCount}
                </span>
              )}
              {formingCount > 0 && (
                <span className="rounded-full bg-amber-500/15 px-2 py-1 font-semibold text-amber-200">
                  待確認 {formingCount}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {analyses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-secondary/15 px-3 py-2.5">
          <p className="text-xs font-medium text-foreground/75">今日沒有完整 K 線組合成立</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
            代表目前沒有命中課程型態，不等於股價一定不漲或不跌；仍以趨勢、量價與支撐壓力為主。
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {analyses.slice(0, 3).map(item => {
            const style = DIRECTION_STYLE[item.direction];
            const presentation = presentKLineAnalysis(item, context);
            return (
              <article
                key={item.signal.ruleId}
                className={`rounded-lg border ${style.border} bg-secondary/20 px-3 py-2.5`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${style.badge}`}>
                    {item.family}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    presentation.conflicting
                      ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/25'
                      : item.state === 'forming'
                      ? 'bg-amber-500/15 text-amber-200'
                      : 'bg-foreground/10 text-foreground/75'
                  }`}>
                    {presentation.stateLabel}
                  </span>
                </div>

                <h3 className={`mt-2 text-sm font-bold ${presentation.conflicting ? 'text-amber-200' : style.title}`}>
                  {presentation.label}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-foreground/80">
                  {item.signal.description}
                </p>

                {presentation.conflictNote && (
                  <p className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-100/90">
                    {presentation.conflictNote}
                  </p>
                )}

                <dl className="mt-2 space-y-1.5 border-t border-border/30 pt-2 text-xs leading-relaxed">
                  <div>
                    <dt className="inline font-semibold text-foreground/85">判讀：</dt>
                    <dd className="inline text-foreground/70">
                      {presentation.conflicting
                        ? '外形符合該方向的 K 線條件，但目前趨勢與主決策不支持採用；等待風險解除後重新判讀。'
                        : item.interpretation}
                    </dd>
                  </div>
                  {item.confirmation && presentation.showConfirmation && (
                    <div>
                      <dt className="inline font-semibold text-sky-200">確認：</dt>
                      <dd className="inline text-foreground/70">{item.confirmation}</dd>
                    </div>
                  )}
                  {item.invalidation && (
                    <div>
                      <dt className="inline font-semibold text-amber-200">失效：</dt>
                      <dd className="inline text-foreground/70">{item.invalidation}</dd>
                    </div>
                  )}
                </dl>

                {item.bookRef && (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/75">
                    {item.bookRef}
                  </p>
                )}
              </article>
            );
          })}
          {analyses.length > 3 && (
            <details className="group rounded-lg border border-border/45 bg-secondary/10">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-xs font-semibold text-foreground/80 outline-none transition-colors hover:bg-secondary/30 focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
                <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
                其餘 {analyses.length - 3} 個同日型態
                <span className="ml-auto text-[11px] font-normal text-muted-foreground/75">預設收合</span>
              </summary>
              <ul className="space-y-2 border-t border-border/35 px-3 py-2.5">
                {analyses.slice(3).map(item => {
                  const presentation = presentKLineAnalysis(item, context);
                  return (
                    <li key={item.signal.ruleId} className="text-xs leading-relaxed">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-foreground/85">{presentation.label}</span>
                        <span className={presentation.conflicting ? 'text-amber-200' : 'text-muted-foreground/75'}>
                          {presentation.stateLabel}
                        </span>
                      </div>
                      <p className="mt-0.5 text-muted-foreground/80">{item.signal.description}</p>
                      {presentation.conflictNote && (
                        <p className="mt-1 text-amber-200/85">只記錄型態，本次不採納為操作依據。</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
