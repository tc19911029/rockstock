'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { RuleSignal } from '@/types';

const TYPE_CONFIG: Record<RuleSignal['type'], { bg: string; border: string; dot: string; badge: string }> = {
  BUY:    { bg: 'bg-red-900/30',     border: 'border-red-600',    dot: 'bg-red-400',    badge: 'bg-red-600 text-white' },
  ADD:    { bg: 'bg-orange-900/30',  border: 'border-orange-500', dot: 'bg-orange-400', badge: 'bg-orange-500 text-white' },
  WATCH:  { bg: 'bg-yellow-900/30',  border: 'border-yellow-600', dot: 'bg-yellow-400', badge: 'bg-yellow-600 text-black' },
  REDUCE: { bg: 'bg-teal-900/30',    border: 'border-teal-500',   dot: 'bg-teal-400',   badge: 'bg-teal-500 text-white' },
  SELL:   { bg: 'bg-green-900/30',   border: 'border-green-600',  dot: 'bg-green-400',  badge: 'bg-green-700 text-white' },
};

function SignalCard({ sig }: { sig: RuleSignal }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = TYPE_CONFIG[sig.type];

  return (
    <div className={`${cfg.bg} border ${cfg.border} rounded overflow-hidden`}>
      {/* Header row */}
      <div
        className="flex items-center gap-2 p-2 cursor-pointer select-none hover:brightness-110"
        onClick={() => setExpanded(e => !e)}
      >
        <span className={`w-2 h-2 rounded-full ${cfg.dot} shrink-0`} />
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${cfg.badge}`}>{sig.label}</span>
        <span className="text-xs text-slate-300 flex-1 leading-tight">{sig.description}</span>
        <span className="text-slate-500 text-xs shrink-0">{expanded ? '▲' : '▼ 分析'}</span>
      </div>

      {/* Expandable reason panel */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-700/50">
          <p className="text-xs font-semibold text-slate-400 mb-1.5">操作建議分析</p>
          <div className="space-y-1.5">
            {sig.reason.split('\n').filter(Boolean).map((line, i) => {
              const isBold = line.startsWith('【');
              const parts  = isBold ? line.split('】') : null;
              return (
                <p key={i} className="text-xs text-slate-300 leading-relaxed">
                  {isBold && parts ? (
                    <>
                      <span className="text-yellow-400 font-semibold">【{parts[0].slice(1)}】</span>
                      {parts.slice(1).join('】')}
                    </>
                  ) : line}
                </p>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RuleAlerts() {
  const { currentSignals, allCandles, currentIndex } = useReplayStore();
  const currentDate = allCandles[currentIndex]?.date;

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-slate-300">規則提示與操作建議</h2>
        {currentDate && (
          <span className="text-xs text-slate-500">{currentDate}</span>
        )}
      </div>

      {currentSignals.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-4">本根K線無觸發規則</p>
      ) : (
        <div className="space-y-2">
          {currentSignals.map((sig, i) => (
            <SignalCard key={`${sig.ruleId}-${i}`} sig={sig} />
          ))}
          <p className="text-xs text-slate-600 text-center pt-1">點選卡片展開詳細分析</p>
        </div>
      )}

      <p className="text-xs text-slate-600 mt-3 text-center">
        提示僅供練習參考，實際交易需自行判斷
      </p>
    </div>
  );
}
