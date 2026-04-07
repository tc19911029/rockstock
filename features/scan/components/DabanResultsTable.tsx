'use client';

import { useState, useEffect } from 'react';
import type { DabanScanResult, DabanScanSession } from '@/lib/scanner/types';

function formatTurnover(value: number): string {
  if (value >= 1e8) return (value / 1e8).toFixed(1) + '億';
  if (value >= 1e4) return (value / 1e4).toFixed(0) + '萬';
  return value.toFixed(0);
}

function boardBadge(type: string): string {
  switch (type) {
    case '首板': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case '二板': return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case '三板': return 'bg-red-500/20 text-red-400 border-red-500/30';
    default: return 'bg-red-700/20 text-red-300 border-red-700/30';
  }
}

interface DabanResultsTableProps {
  date: string;
}

export function DabanResultsTable({ date }: DabanResultsTableProps) {
  const [session, setSession] = useState<DabanScanSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date) return;
    setLoading(true);
    setError(null);
    fetch(`/api/scanner/daban?date=${date}`)
      .then(r => r.json())
      .then(data => {
        setSession(data.session ?? null);
        if (!data.session) setError('該日期無打板掃描資料');
      })
      .catch(() => setError('載入失敗'))
      .finally(() => setLoading(false));
  }, [date]);

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">載入打板掃描結果...</div>;
  }

  if (error) {
    return <div className="text-center py-8 text-muted-foreground">{error}</div>;
  }

  if (!session || session.results.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">該日無漲停股</div>;
  }

  const buyable = session.results.filter(r => !r.isYiZiBan);
  const locked = session.results.filter(r => r.isYiZiBan);

  return (
    <div className="space-y-4">
      {/* Strategy rules banner */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-amber-400 font-bold text-sm">打板戰法</span>
          <span className="text-xs text-muted-foreground">
            漲停股 {session.results.length} 檔 | 可買入 {buyable.length} 檔
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          操作：明天 09:25 找高開 ≥ 買入門檻的排名第一檔買入 →
          止盈 +5% / 止損 -3% / 收黑隔日走 / 最多持 2 天
        </div>
      </div>

      {/* Results table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border">
              <th className="text-left py-2 px-2 w-8">#</th>
              <th className="text-left py-2 px-2">代碼</th>
              <th className="text-left py-2 px-2">名稱</th>
              <th className="text-right py-2 px-2">收盤</th>
              <th className="text-right py-2 px-2">漲幅</th>
              <th className="text-center py-2 px-2">類型</th>
              <th className="text-right py-2 px-2">成交額</th>
              <th className="text-right py-2 px-2">量比</th>
              <th className="text-right py-2 px-2">買入門檻</th>
              <th className="text-right py-2 px-2">分數</th>
            </tr>
          </thead>
          <tbody>
            {buyable.map((r, i) => (
              <tr key={r.symbol}
                className={`border-b border-border/50 hover:bg-muted/50 ${i === 0 ? 'bg-amber-500/5' : ''}`}>
                <td className="py-2 px-2 text-muted-foreground">{i + 1}</td>
                <td className="py-2 px-2 font-mono text-xs">{r.symbol}</td>
                <td className="py-2 px-2">{r.name.slice(0, 8)}</td>
                <td className="py-2 px-2 text-right font-mono">{r.closePrice.toFixed(2)}</td>
                <td className="py-2 px-2 text-right text-red-400">+{r.limitUpPct.toFixed(1)}%</td>
                <td className="py-2 px-2 text-center">
                  <span className={`text-xs px-1.5 py-0.5 rounded border ${boardBadge(r.limitUpType)}`}>
                    {r.limitUpType}
                  </span>
                </td>
                <td className="py-2 px-2 text-right font-mono text-xs">{formatTurnover(r.turnover)}</td>
                <td className="py-2 px-2 text-right font-mono text-xs">{r.volumeRatio.toFixed(1)}</td>
                <td className="py-2 px-2 text-right font-mono text-amber-400 font-bold">
                  {r.buyThresholdPrice.toFixed(2)}
                </td>
                <td className="py-2 px-2 text-right font-mono">{r.rankScore.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Locked boards */}
      {locked.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            一字板 {locked.length} 檔（買不到）
          </summary>
          <div className="mt-1 pl-4 space-y-0.5">
            {locked.map(r => (
              <div key={r.symbol}>
                {r.symbol} {r.name.slice(0, 6)} {r.closePrice.toFixed(2)} +{r.limitUpPct.toFixed(1)}%
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
