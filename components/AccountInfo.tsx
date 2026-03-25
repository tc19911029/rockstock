'use client';

import { useReplayStore } from '@/store/replayStore';
import { formatCurrency, formatReturn } from '@/lib/engines/statsEngine';

function MetricRow({
  label,
  value,
  valueClass = 'text-white',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-slate-700 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`text-xs font-mono font-bold ${valueClass}`}>{value}</span>
    </div>
  );
}

export default function AccountInfo() {
  const { metrics, account, stats } = useReplayStore();

  const unrealizedClass =
    metrics.unrealizedPnL > 0 ? 'text-green-400' :
    metrics.unrealizedPnL < 0 ? 'text-red-400' :
    'text-slate-300';

  const realizedClass =
    metrics.realizedPnL > 0 ? 'text-green-400' :
    metrics.realizedPnL < 0 ? 'text-red-400' :
    'text-slate-300';

  const returnClass =
    metrics.returnRate > 0 ? 'text-green-400' :
    metrics.returnRate < 0 ? 'text-red-400' :
    'text-slate-300';

  return (
    <div className="bg-slate-800 rounded-lg p-4 space-y-1">
      <h2 className="text-sm font-semibold text-slate-300 mb-2">帳戶資訊</h2>

      <MetricRow
        label="初始本金"
        value={`$${formatCurrency(account.initialCapital)}`}
      />
      <MetricRow
        label="現金餘額"
        value={`$${formatCurrency(metrics.cash)}`}
      />
      <MetricRow
        label="持倉股數"
        value={`${metrics.shares.toLocaleString()} 股`}
      />
      {metrics.shares > 0 && (
        <MetricRow
          label="持倉均價"
          value={`$${metrics.avgCost.toFixed(2)}`}
        />
      )}
      <MetricRow
        label="持倉市值"
        value={`$${formatCurrency(metrics.holdingValue)}`}
      />
      <MetricRow
        label="未實現盈虧"
        value={`$${formatCurrency(metrics.unrealizedPnL)}`}
        valueClass={unrealizedClass}
      />
      <MetricRow
        label="已實現盈虧"
        value={`$${formatCurrency(metrics.realizedPnL)}`}
        valueClass={realizedClass}
      />

      {/* Divider */}
      <div className="border-t border-slate-600 pt-2 mt-2">
        <MetricRow
          label="總資產"
          value={`$${formatCurrency(metrics.totalAssets)}`}
          valueClass="text-yellow-400 text-sm"
        />
        <MetricRow
          label="總報酬率"
          value={formatReturn(metrics.returnRate)}
          valueClass={`${returnClass} text-sm`}
        />
      </div>

      {/* Performance stats */}
      {stats.totalTrades > 0 && (
        <div className="border-t border-slate-600 pt-2 mt-2 space-y-1">
          <p className="text-xs text-slate-400 mb-1">績效統計</p>
          <MetricRow
            label="交易次數"
            value={`${stats.totalTrades} 筆`}
          />
          <MetricRow
            label="勝率"
            value={`${(stats.winRate * 100).toFixed(1)}%`}
            valueClass={stats.winRate >= 0.5 ? 'text-green-400' : 'text-red-400'}
          />
          <MetricRow
            label="勝/負"
            value={`${stats.winCount} / ${stats.lossCount}`}
          />
        </div>
      )}
    </div>
  );
}
