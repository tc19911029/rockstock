'use client';

import { useMemo } from 'react';
import { usePortfolioStore } from '@/store/portfolioStore';

function formatMoney(n: number): string {
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function RealizedSummary() {
  const trades = usePortfolioStore(s => s.realizedTrades);
  const removeRealized = usePortfolioStore(s => s.removeRealized);

  const stats = useMemo(() => {
    if (trades.length === 0) {
      return { count: 0, wins: 0, losses: 0, winRate: 0, totalPL: 0, avgReturn: 0 };
    }
    const wins = trades.filter(t => t.realizedPL > 0).length;
    const losses = trades.filter(t => t.realizedPL < 0).length;
    const totalPL = trades.reduce((sum, t) => sum + t.realizedPL, 0);
    const avgReturn = trades.reduce((sum, t) => sum + t.realizedPLPct, 0) / trades.length;
    return {
      count: trades.length,
      wins, losses,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalPL,
      avgReturn,
    };
  }, [trades]);

  if (trades.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-foreground">📊 已實現損益（{stats.count}）</div>

      {/* 統計總覽 */}
      <div className="grid grid-cols-2 gap-2 border border-border/60 rounded p-2 bg-card/40 text-[11px]">
        <Stat label="累計損益" value={`${stats.totalPL >= 0 ? '+' : ''}${formatMoney(stats.totalPL)}`} tone={stats.totalPL >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <Stat label="平均報酬" value={formatPct(stats.avgReturn)} tone={stats.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <Stat label="勝率" value={`${stats.winRate.toFixed(0)}% (${stats.wins}/${stats.count})`} />
        <Stat label="勝賠" value={`${stats.wins}贏 ${stats.losses}賠`} />
      </div>

      {/* 近 5 筆交易 */}
      <div className="space-y-1">
        {trades.slice(0, 5).map(t => (
          <div key={t.id} className="border border-border/60 rounded p-2 bg-card/40 text-[11px] space-y-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{t.symbol} {t.name}</span>
              <span className={t.realizedPL >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {t.realizedPL >= 0 ? '+' : ''}{formatMoney(t.realizedPL)} ({formatPct(t.realizedPLPct)})
              </span>
            </div>
            <div className="text-muted-foreground text-[10px]">
              {t.buyDate} 買 {t.buyPrice.toFixed(2)} → {t.sellDate} 賣 {t.sellPrice.toFixed(2)} ・ {t.shares.toLocaleString()} 股
            </div>
            {t.reason && <div className="text-muted-foreground text-[10px]">原因：{t.reason}</div>}
            <button
              onClick={() => removeRealized(t.id)}
              className="text-[10px] text-muted-foreground/60 hover:text-red-400"
              title="刪除這筆紀錄（修正用）"
            >🗑️ 刪除紀錄</button>
          </div>
        ))}
        {trades.length > 5 && (
          <div className="text-[10px] text-muted-foreground text-center">
            … 還有 {trades.length - 5} 筆
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'text-foreground' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-[10px]">{label}</div>
      <div className={`font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
