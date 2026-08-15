import type {
  KLinePatternDirection,
  KLineSignalAnalysis,
} from '@/lib/rules/klineSignalAnalysis';

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
}: {
  analyses: KLineSignalAnalysis[];
  showHeader?: boolean;
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
          {analyses.map(item => {
            const style = DIRECTION_STYLE[item.direction];
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
                    item.state === 'forming'
                      ? 'bg-amber-500/15 text-amber-200'
                      : 'bg-foreground/10 text-foreground/75'
                  }`}>
                    {item.stateLabel}
                  </span>
                </div>

                <h3 className={`mt-2 text-sm font-bold ${style.title}`}>{item.signal.label}</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-foreground/80">
                  {item.signal.description}
                </p>

                <dl className="mt-2 space-y-1.5 border-t border-border/30 pt-2 text-[11px] leading-relaxed">
                  <div>
                    <dt className="inline font-semibold text-foreground/85">判讀：</dt>
                    <dd className="inline text-foreground/70">{item.interpretation}</dd>
                  </div>
                  {item.confirmation && (
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
                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/60">
                    {item.bookRef}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
