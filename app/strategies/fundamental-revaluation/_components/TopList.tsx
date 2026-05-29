'use client';

import Link from 'next/link';
import type {
  FundamentalRevaluationResult,
} from '@/lib/strategy/fundamentalRevaluation/types';
import { gradeLabel } from '@/lib/strategy/fundamentalRevaluation/recommendationGrade';

interface Props {
  rows: FundamentalRevaluationResult[];
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
  market: 'TW' | 'CN';
}

export function TopList({ rows, selectedSymbol, onSelect, market }: Props) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        無候選股 — 跑 <code>?market={market}&force=1</code> cron 後再查看
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left py-1.5 px-1">#</th>
            <th className="text-left py-1.5 px-1">代號</th>
            <th className="text-left py-1.5 px-1">名稱</th>
            <th className="text-right py-1.5 px-1">總分</th>
            <th className="text-left py-1.5 px-1">等級</th>
            <th className="text-right py-1.5 px-1">現價</th>
            <th className="text-right py-1.5 px-1">中性合理價</th>
            <th className="text-right py-1.5 px-1">低估空間</th>
            <th className="text-right py-1.5 px-1">TTM PE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const upside = r.baseUpside;
            const isSelected = selectedSymbol === r.symbol;
            return (
              <tr
                key={r.symbol}
                onClick={() => onSelect(r.symbol)}
                className={
                  'cursor-pointer border-b border-border/50 hover:bg-secondary/40 ' +
                  (isSelected ? 'bg-secondary/60' : '')
                }
              >
                <td className="py-1 px-1 font-mono tabular-nums text-muted-foreground">{r.rank}</td>
                <td className="py-1 px-1 font-mono">
                  <Link
                    href={`/agents/${r.symbol}`}
                    className="text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.symbol}
                  </Link>
                </td>
                <td className="py-1 px-1">{r.name}</td>
                <td className="py-1 px-1 text-right font-mono tabular-nums font-medium">
                  {r.breakdown.total}
                </td>
                <td className="py-1 px-1">{gradeLabel(r.breakdown.grade)}</td>
                <td className="py-1 px-1 text-right font-mono tabular-nums">
                  {r.todayPrice.toFixed(2)}
                </td>
                <td className="py-1 px-1 text-right font-mono tabular-nums">
                  {r.baseFairPrice != null ? r.baseFairPrice.toFixed(2) : '—'}
                </td>
                <td
                  className={
                    upside == null
                      ? 'py-1 px-1 text-right font-mono tabular-nums text-muted-foreground'
                      : upside > 0
                      ? 'py-1 px-1 text-right font-mono tabular-nums text-emerald-500'
                      : 'py-1 px-1 text-right font-mono tabular-nums text-rose-500'
                  }
                >
                  {upside != null ? `${(upside * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="py-1 px-1 text-right font-mono tabular-nums">
                  {r.ttmPe != null ? r.ttmPe.toFixed(1) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
