'use client';

import type {
  FundamentalRevaluationResult,
  DimensionScore,
} from '@/lib/strategy/fundamentalRevaluation/types';
import { flagLabel, gradeLabel } from '@/lib/strategy/fundamentalRevaluation/recommendationGrade';

interface Props {
  result: FundamentalRevaluationResult;
}

function DimRow({ dim }: { dim: DimensionScore }) {
  return (
    <div className="border border-border rounded-lg p-3 bg-card/50">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm font-medium">{dim.label}</h4>
        <span className="text-base font-bold tabular-nums">
          {dim.score} <span className="text-xs text-muted-foreground">/ {dim.cap}</span>
        </span>
      </div>
      <ul className="space-y-1 text-xs">
        {dim.items.map((it, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span
              className={
                it.delta > 0
                  ? 'text-emerald-500 font-mono w-10 text-right'
                  : it.delta < 0
                  ? 'text-rose-500 font-mono w-10 text-right'
                  : 'text-muted-foreground font-mono w-10 text-right'
              }
            >
              {it.delta > 0 ? '+' : ''}
              {it.delta}
            </span>
            <span className="text-muted-foreground">{it.reason}</span>
          </li>
        ))}
        {dim.items.length === 0 && (
          <li className="text-muted-foreground italic">無加減分項</li>
        )}
      </ul>
    </div>
  );
}

export function ScoreBreakdownPanel({ result }: Props) {
  const { breakdown, scenarios } = result;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <div className="text-3xl font-bold tabular-nums">{breakdown.total}</div>
        <div className="text-sm text-muted-foreground">/ 100</div>
        <div className="ml-auto inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-primary/10 text-primary text-sm font-medium">
          {gradeLabel(breakdown.grade)}
        </div>
      </div>

      {breakdown.flags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {breakdown.flags.map((f) => (
            <span
              key={f}
              className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-secondary text-secondary-foreground"
            >
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <DimRow dim={breakdown.growth} />
        <DimRow dim={breakdown.profitability} />
        <DimRow dim={breakdown.valuation} />
        <DimRow dim={breakdown.risk} />
      </div>

      <div className="border border-border rounded-lg p-3 bg-card/50">
        <h4 className="text-sm font-medium mb-2">三情境合理價</h4>
        <div className="grid grid-cols-3 gap-2 text-xs">
          {(['pessimistic', 'base', 'optimistic'] as const).map((k) => {
            const s = scenarios[k];
            const label = k === 'pessimistic' ? '保守' : k === 'base' ? '中性' : '樂觀';
            return (
              <div key={k} className="border border-border/50 rounded p-2">
                <div className="text-muted-foreground">{label}</div>
                <div className="font-mono tabular-nums">
                  {s.fairPrice > 0 ? s.fairPrice.toFixed(2) : '—'}
                </div>
                <div
                  className={
                    s.upside > 0
                      ? 'text-emerald-500 font-mono tabular-nums'
                      : 'text-rose-500 font-mono tabular-nums'
                  }
                >
                  {s.fairPrice > 0 ? `${(s.upside * 100).toFixed(1)}%` : '—'}
                </div>
                <div className="text-muted-foreground text-[10px]">
                  合理 PE {s.fairPe} / Forward PE{' '}
                  {s.forwardPe === Infinity ? '—' : s.forwardPe.toFixed(1)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {result.bullPoints.length > 0 && (
        <div className="border border-border rounded-lg p-3 bg-card/50">
          <h4 className="text-sm font-medium text-emerald-600 dark:text-emerald-400 mb-1.5">主要看多</h4>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {result.bullPoints.map((p, i) => (
              <li key={i}>· {p}</li>
            ))}
          </ul>
        </div>
      )}
      {result.riskPoints.length > 0 && (
        <div className="border border-border rounded-lg p-3 bg-card/50">
          <h4 className="text-sm font-medium text-rose-600 dark:text-rose-400 mb-1.5">主要風險</h4>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {result.riskPoints.map((p, i) => (
              <li key={i}>· {p}</li>
            ))}
          </ul>
        </div>
      )}
      {result.validationConditions.length > 0 && (
        <div className="border border-border rounded-lg p-3 bg-card/50">
          <h4 className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-1.5">後續驗證條件</h4>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {result.validationConditions.map((p, i) => (
              <li key={i}>· {p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
