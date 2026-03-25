'use client';

import { useReplayStore } from '@/store/replayStore';
import { formatCurrency } from '@/lib/engines/statsEngine';
import { Trade } from '@/types';

function TradeRow({ trade }: { trade: Trade }) {
  const isBuy = trade.action === 'BUY';
  const pnl = trade.realizedPnL;

  return (
    <tr className="border-b border-slate-700 hover:bg-slate-700/30 text-xs">
      <td className="py-1.5 px-2 text-slate-400">{trade.date}</td>
      <td className={`py-1.5 px-2 font-bold ${isBuy ? 'text-green-400' : 'text-red-400'}`}>
        {isBuy ? '買' : '賣'}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">{trade.price.toFixed(2)}</td>
      <td className="py-1.5 px-2 text-right font-mono">{trade.shares.toLocaleString()}</td>
      <td className="py-1.5 px-2 text-right font-mono text-slate-300">
        {formatCurrency(trade.amount)}
      </td>
      <td className={`py-1.5 px-2 text-right font-mono ${
        pnl == null ? 'text-slate-500' :
        pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-slate-400'
      }`}>
        {pnl == null ? '—' : (pnl >= 0 ? '+' : '') + formatCurrency(pnl)}
      </td>
    </tr>
  );
}

export default function TradeHistory() {
  const { account } = useReplayStore();
  const trades = [...account.trades].reverse(); // newest first

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-300">交易紀錄</h2>
        <span className="text-xs text-slate-500">{account.trades.length} 筆</span>
      </div>

      {trades.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-4">尚無交易紀錄</p>
      ) : (
        <div className="overflow-auto max-h-64">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-600">
                <th className="pb-1.5 px-2">日期</th>
                <th className="pb-1.5 px-2">方向</th>
                <th className="pb-1.5 px-2 text-right">價格</th>
                <th className="pb-1.5 px-2 text-right">股數</th>
                <th className="pb-1.5 px-2 text-right">金額</th>
                <th className="pb-1.5 px-2 text-right">盈虧</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <TradeRow key={t.id} trade={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
