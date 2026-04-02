'use client';

import { useReplayStore } from '@/store/replayStore';
import { formatCurrency } from '@/lib/engines/statsEngine';
import { Trade } from '@/types';

function EquityCurveChart({ curve }: { curve: Array<{ date: string; totalAssets: number }> }) {
  if (curve.length < 2) return null;
  const H = 80;
  const W = 400;
  const PAD = 6;
  const min = Math.min(...curve.map(p => p.totalAssets));
  const max = Math.max(...curve.map(p => p.totalAssets));
  const range = max - min || 1;
  const initial = curve[0].totalAssets;

  const toY = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2);

  const pts = curve.map((p, i) => {
    const x = (i / (curve.length - 1)) * W;
    return `${x},${toY(p.totalAssets)}`;
  }).join(' ');

  const isPositive = curve[curve.length - 1].totalAssets >= initial;
  const color = isPositive ? '#f87171' : '#4ade80';
  const baselineY = toY(initial);

  const lastX = W;
  const lastY = toY(curve[curve.length - 1].totalAssets);
  const finalPct = ((curve[curve.length - 1].totalAssets - initial) / initial * 100).toFixed(1);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted-foreground">資金曲線</span>
        <span className={`text-[10px] font-mono font-bold ${isPositive ? 'text-bull' : 'text-bear'}`}>
          {isPositive ? '+' : ''}{finalPct}%
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20 rounded bg-card/50" preserveAspectRatio="none">
        {/* Initial capital baseline */}
        <line x1="0" y1={baselineY} x2={W} y2={baselineY} stroke="#334155" strokeWidth="1" strokeDasharray="4,4" />
        {/* Fill area under curve */}
        <polygon
          points={`0,${baselineY} ${pts} ${W},${baselineY}`}
          fill={color}
          fillOpacity="0.1"
        />
        {/* Curve line */}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
        {/* End dot */}
        <circle cx={lastX} cy={lastY} r="3" fill={color} />
      </svg>
    </div>
  );
}

function TradeRow({ trade }: { trade: Trade }) {
  const isBuy = trade.action === 'BUY';
  const pnl = trade.realizedPnL;

  return (
    <tr className="border-b border-border hover:bg-muted/30 text-xs">
      <td className="py-1.5 px-2 text-muted-foreground">{trade.date}</td>
      <td className={`py-1.5 px-2 font-bold ${isBuy ? 'text-bull' : 'text-bear'}`}>
        {isBuy ? '買' : '賣'}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">{trade.price.toFixed(2)}</td>
      <td className="py-1.5 px-2 text-right font-mono">{trade.shares.toLocaleString()}</td>
      <td className="py-1.5 px-2 text-right font-mono text-foreground/80">
        {formatCurrency(trade.amount)}
      </td>
      <td className={`py-1.5 px-2 text-right font-mono ${
        pnl == null ? 'text-muted-foreground' :
        pnl > 0 ? 'text-bull' : pnl < 0 ? 'text-bear' : 'text-muted-foreground'
      }`}>
        {pnl == null ? '—' : (pnl >= 0 ? '+' : '') + formatCurrency(pnl)}
      </td>
    </tr>
  );
}

export default function TradeHistory() {
  const { account, stats } = useReplayStore();
  const trades = [...account.trades].reverse(); // newest first

  return (
    <div className="bg-secondary rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-foreground/80">交易紀錄</h2>
        <span className="text-xs text-muted-foreground">{account.trades.length} 筆</span>
      </div>

      <EquityCurveChart curve={stats.equityCurve} />

      {trades.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">尚無交易紀錄</p>
      ) : (
        <div className="overflow-auto max-h-64">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border">
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
