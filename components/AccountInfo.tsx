'use client';

import { useReplayStore } from '@/store/replayStore';
import { formatCurrency, formatReturn } from '@/lib/engines/statsEngine';

function Row({ label, value, valueClass = 'text-white' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-slate-700/60 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`text-xs font-mono font-bold ${valueClass}`}>{value}</span>
    </div>
  );
}

export default function AccountInfo() {
  const { metrics, account, stats } = useReplayStore();

  const pnlClass = (v: number) => v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-300';

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4 space-y-0.5">
      <h2 className="text-sm font-bold text-slate-200 mb-2">帳戶資訊</h2>

      <Row label="初始本金" value={`$${formatCurrency(account.initialCapital)}`} />
      <Row label="現金餘額" value={`$${formatCurrency(metrics.cash)}`} />
      <Row label="持倉股數" value={`${metrics.shares.toLocaleString()} 股`} />
      {metrics.shares > 0 && (
        <Row label="持倉均價" value={`$${metrics.avgCost.toFixed(2)}`} valueClass="text-yellow-400" />
      )}
      <Row label="持倉市值" value={`$${formatCurrency(metrics.holdingValue)}`} />
      <Row label="未實現盈虧" value={`$${formatCurrency(metrics.unrealizedPnL)}`} valueClass={pnlClass(metrics.unrealizedPnL)} />
      <Row label="已實現盈虧" value={`$${formatCurrency(metrics.realizedPnL)}`} valueClass={pnlClass(metrics.realizedPnL)} />

      <div className="border-t border-slate-600 pt-2 mt-1">
        <Row label="總資產" value={`$${formatCurrency(metrics.totalAssets)}`} valueClass="text-yellow-400 text-sm" />
        <Row label="總報酬率" value={formatReturn(metrics.returnRate)} valueClass={`${pnlClass(metrics.returnRate)} text-sm`} />
      </div>

      {stats.totalTrades > 0 && (
        <div className="border-t border-slate-600 pt-2 mt-1">
          <p className="text-xs text-slate-500 mb-1">績效統計</p>
          <Row label="交易次數" value={`${stats.totalTrades} 筆`} />
          <Row label="勝率" value={`${(stats.winRate * 100).toFixed(1)}%`} valueClass={stats.winRate >= 0.5 ? 'text-red-400' : 'text-green-400'} />
          <Row label="勝 / 負" value={`${stats.winCount} / ${stats.lossCount}`} />
        </div>
      )}
    </div>
  );
}
