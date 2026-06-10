'use client';

import Link from 'next/link';
import { bullBearClass } from '@/lib/format';
import type { LeaderboardRow } from '@/lib/backtest/leaderboardTypes';

const fmt = (v: number | null): string => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

/** 展開列：列出該策略×排序「最近的排序第 1 名 pick」+ 實際 d1/d3/d5（隔日開盤進場）。 */
export function SamplePicksPanel({ row }: { row: LeaderboardRow }) {
  return (
    <div className="border border-border rounded-lg bg-card/30 p-3">
      <div className="text-sm font-medium mb-2 flex flex-wrap items-baseline gap-2">
        <span>{row.strategyLabel} × {row.sortLabel}</span>
        <span className="text-xs text-muted-foreground">
          最近 {row.samplePicks.length} 筆「排序第 1 名」pick（隔日開盤進場、點代號看走圖）
        </span>
      </div>
      {row.samplePicks.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">無 pick</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="py-1 pr-3">日期</th>
                <th className="pr-3">代號</th>
                <th className="pr-3">名稱</th>
                <th className="text-right pr-3">進場開</th>
                <th className="text-right pr-3">d1</th>
                <th className="text-right pr-3">d3</th>
                <th className="text-right">d5</th>
              </tr>
            </thead>
            <tbody>
              {row.samplePicks.map((p, i) => (
                <tr key={`${p.date}-${p.symbol}-${i}`} className="border-t border-border/40">
                  <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{p.date}</td>
                  <td className="pr-3">
                    <Link
                      href={`/?load=${encodeURIComponent(p.symbol)}&date=${p.date}`}
                      className="font-mono text-primary hover:underline"
                    >
                      {p.symbol}
                    </Link>
                  </td>
                  <td className="pr-3 whitespace-nowrap">{p.name}</td>
                  <td className="text-right pr-3 font-mono">{p.entryOpen}</td>
                  <td className={`text-right pr-3 font-mono ${bullBearClass(p.d1)}`}>{fmt(p.d1)}</td>
                  <td className={`text-right pr-3 font-mono ${bullBearClass(p.d3)}`}>{fmt(p.d3)}</td>
                  <td className={`text-right font-mono ${bullBearClass(p.d5)}`}>{fmt(p.d5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
