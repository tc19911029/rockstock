'use client';

/**
 * AlertTimeline — 最近警示時間軸（右側欄）
 * 從 /api/realtime/bars?symbol=XXX 或 listRecentAlerts 拿
 */

import { cn } from '@/lib/utils';

const RULE_LABEL: Record<string, string> = {
  'blowoff-bearish': '爆量長黑',
  'blowoff-bullish': '爆量長紅',
  'terminal-rally': '末升段',
  'ma5-breakdown': '5m MA5 跌破',
  'stop-loss-breach': '跌破停損',
  'pump-reversal': '拉高回落',
  'rapid-drop': '急殺',
};

const RULE_COLOR: Record<string, string> = {
  'blowoff-bearish': 'text-rose-400 bg-rose-500/10',
  'blowoff-bullish': 'text-emerald-400 bg-emerald-500/10',
  'terminal-rally': 'text-orange-400 bg-orange-500/10',
  'ma5-breakdown': 'text-amber-400 bg-amber-500/10',
  'stop-loss-breach': 'text-rose-400 bg-rose-500/10',
  'pump-reversal': 'text-orange-400 bg-orange-500/10',
  'rapid-drop': 'text-rose-400 bg-rose-500/10',
};

export interface AlertItem {
  firedAt: number;
  rule: string;
  symbol: string;
  market: 'TW' | 'CN';
  barTs: number;
  tfMin: 1 | 5;
  isHolding: boolean;
  /** 形態訊號帶 open/close/volume…；持倉保命訊號（guard）帶 price/stopLoss… — 欄位全 optional */
  meta: {
    close?: number;
    open?: number;
    volume?: number;
    volumeMultiplier?: number;
    pctChange?: number;
    // guard 專屬
    price?: number;
    stopLoss?: number;
    entryPrice?: number;
    positionSide?: 'long' | 'short';
    dayHigh?: number;
    dayGainPct?: number;
    drawdownPct?: number;
    dropPct?: number;
    windowMin?: number;
    refClose?: number;
  };
}

/** 明細列文案 — guard 規則與 alertDispatcher.formatGuardPayload 對齊 */
function detailLine(a: AlertItem): string {
  const m = a.meta;
  if (a.rule === 'stop-loss-breach') {
    return m.positionSide === 'short'
      ? `現價 ${m.price} ≥ 回補停損 ${m.stopLoss}（做空進場 ${m.entryPrice}）`
      : `現價 ${m.price} ≤ 停損 ${m.stopLoss}（進場 ${m.entryPrice}）`;
  }
  if (a.rule === 'pump-reversal') {
    return `高 ${m.dayHigh}（+${m.dayGainPct}%）→ 現價 ${m.price}（自高點 -${m.drawdownPct}%）`;
  }
  if (a.rule === 'rapid-drop') {
    return `近 ${m.windowMin} 分 -${m.dropPct}%（${m.refClose} → ${m.price}）`;
  }
  return `${m.open} → ${m.close} (${(m.pctChange ?? 0) >= 0 ? '+' : ''}${m.pctChange}%) · vol ${m.volume}張 (${m.volumeMultiplier}x) · ${a.tfMin}m`;
}

export interface AlertTimelineProps {
  alerts: AlertItem[];
  onSelectSymbol?: (symbol: string) => void;
  emptyHint?: string;
}

export default function AlertTimeline({ alerts, onSelectSymbol, emptyHint }: AlertTimelineProps) {
  if (alerts.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center">
        {emptyHint ?? '尚無警示'}
      </div>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border/40">
      {alerts.map((a, idx) => {
        const time = new Date(a.firedAt);
        const hh = String(time.getHours()).padStart(2, '0');
        const mm = String(time.getMinutes()).padStart(2, '0');
        return (
          <li key={`${a.firedAt}-${a.symbol}-${a.rule}-${idx}`}>
            <button
              type="button"
              onClick={() => onSelectSymbol?.(a.symbol)}
              className="w-full text-left py-2 px-2 hover:bg-secondary/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className={cn(
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded',
                  RULE_COLOR[a.rule] ?? 'text-foreground bg-secondary',
                )}>
                  {RULE_LABEL[a.rule] ?? a.rule}
                </span>
                <span className="font-mono text-sm">{a.symbol}</span>
                {a.isHolding && (
                  <span className="text-[10px] text-sky-400 bg-sky-500/10 px-1 rounded">持股</span>
                )}
                <span className="text-[10px] text-muted-foreground ml-auto">{hh}:{mm}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                {detailLine(a)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
