'use client';

import { useReplayStore } from '@/store/replayStore';
import { RuleSignal } from '@/types';

function getFirstReasonLines(reason: string, maxLines = 2): string[] {
  return reason
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('【'))
    .slice(0, maxLines);
}

type Direction = { label: string; icon: string; color: string; detail: string };

function getDirection(signals: RuleSignal[]): Direction {
  const buyCount  = signals.filter(s => s.type === 'BUY'  || s.type === 'ADD').length;
  const sellCount = signals.filter(s => s.type === 'SELL' || s.type === 'REDUCE').length;

  if (buyCount === 0 && sellCount === 0) {
    return { label: '無明確方向', icon: '◇', color: 'text-muted-foreground', detail: '暫無觸發訊號' };
  }
  if (buyCount > 0 && sellCount === 0) {
    return { label: '偏多', icon: '▲', color: 'text-red-400', detail: `${buyCount} 個看多訊號` };
  }
  if (sellCount > 0 && buyCount === 0) {
    return { label: '偏空', icon: '▼', color: 'text-green-400', detail: `${sellCount} 個看空訊號` };
  }
  if (buyCount >= sellCount * 2) {
    return { label: '偏多', icon: '▲', color: 'text-red-400', detail: `${buyCount} 個看多 / ${sellCount} 個看空` };
  }
  if (sellCount >= buyCount * 2) {
    return { label: '偏空', icon: '▼', color: 'text-green-400', detail: `${buyCount} 個看多 / ${sellCount} 個看空` };
  }
  return { label: '多空分歧', icon: '◆', color: 'text-yellow-400', detail: `${buyCount} 個看多 / ${sellCount} 個看空，方向矛盾` };
}

function SignalRow({ sig }: { sig: RuleSignal }) {
  const isBuy = sig.type === 'BUY' || sig.type === 'ADD';
  const lines = getFirstReasonLines(sig.reason);

  return (
    <div className={`rounded px-2.5 py-2 ${isBuy ? 'bg-red-900/20' : 'bg-green-900/20'}`}>
      <div className="flex items-start gap-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${
          isBuy ? 'bg-red-700 text-white' : 'bg-green-800 text-white'
        }`}>{sig.label}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground/90 leading-tight">{sig.description}</p>
          {lines.map((line, i) => (
            <p key={i} className="text-xs text-muted-foreground leading-relaxed mt-0.5">{line}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RuleAlerts() {
  const { currentSignals, allCandles, currentIndex } = useReplayStore();
  const currentDate = allCandles[currentIndex]?.date;

  const buySignals  = currentSignals.filter(s => s.type === 'BUY'  || s.type === 'ADD').slice(0, 3);
  const exitSignals = currentSignals.filter(s => s.type === 'SELL' || s.type === 'REDUCE').slice(0, 3);
  const direction   = getDirection(currentSignals);
  const hasActionSignals = buySignals.length > 0 || exitSignals.length > 0;

  return (
    <div className="bg-secondary rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground/80">今日操作建議</h2>
        {currentDate && (
          <span className="text-xs text-muted-foreground">{currentDate}</span>
        )}
      </div>

      {/* 整體偏向 */}
      <div className="bg-card rounded px-3 py-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground shrink-0">整體偏向</span>
          <span className={`text-sm font-bold ${direction.color}`}>{direction.icon} {direction.label}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{direction.detail}</p>
      </div>

      {!hasActionSignals ? (
        <p className="text-xs text-muted-foreground text-center py-3">本根K線無觸發規則</p>
      ) : (
        <div className="space-y-3">
          {buySignals.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400/80 mb-1.5">📈 做多理由</p>
              <div className="space-y-1.5">
                {buySignals.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}

          {exitSignals.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-400/80 mb-1.5">⚠️ 注意事項</p>
              <div className="space-y-1.5">
                {exitSignals.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground/50 mt-3 text-center">
        僅供練習參考，實際交易需自行判斷
      </p>
    </div>
  );
}
