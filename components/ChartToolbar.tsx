'use client';

import type { Candle } from '@/types';

interface MaToggles { ma5: boolean; ma10: boolean; ma20: boolean; ma60: boolean; ma240: boolean }
interface Indicators { macd: boolean; kd: boolean; volume: boolean; rsi: boolean }

interface ChartToolbarProps {
  candle: Candle;
  prevCandle?: Candle | null;
  isHover: boolean;
  stockName?: string;
  maToggles: MaToggles;
  onMaToggle: (key: keyof MaToggles) => void;
  showBollinger: boolean;
  onBollingerToggle: () => void;
  indicators: Indicators;
  onIndicatorToggle: (key: keyof Indicators) => void;
  showMarkers: boolean;
  onMarkersToggle: () => void;
  signalStrengthMin: number;
  onSignalStrengthChange: (v: number) => void;
  avgCost?: number;
  shares?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onReset?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  /** 股票代碼，用於判斷市場（.TW/.TWO=台股，量顯示為張） */
  ticker?: string;
}

const MA_CONFIGS = [
  { key: 'ma5' as const, label: 'MA5' },
  { key: 'ma10' as const, label: 'MA10' },
  { key: 'ma20' as const, label: 'MA20' },
  { key: 'ma60' as const, label: 'MA60' },
  { key: 'ma240' as const, label: 'MA240' },
];

const INDICATOR_CONFIGS = [
  { key: 'volume' as const, label: '量' },
  { key: 'kd' as const, label: 'KD' },
  { key: 'rsi' as const, label: 'RSI' },
  { key: 'macd' as const, label: 'MACD' },
];

export default function ChartToolbar({
  candle, prevCandle, isHover, stockName,
  maToggles, onMaToggle,
  showBollinger, onBollingerToggle,
  indicators, onIndicatorToggle,
  showMarkers, onMarkersToggle,
  signalStrengthMin, onSignalStrengthChange,
  avgCost, shares,
  onPrev, onNext, onReset,
  canPrev = true, canNext = true,
  ticker,
}: ChartToolbarProps) {
  const chg = prevCandle ? candle.close - prevCandle.close : 0;
  const chgPct = prevCandle ? (chg / prevCandle.close) * 100 : 0;
  const isUp = chg >= 0;
  const isTW = ticker ? /\.(TW|TWO)$/i.test(ticker) : false;

  const unrealizedPct = shares && shares > 0 && avgCost && avgCost > 0
    ? ((candle.close - avgCost) / avgCost) * 100
    : null;

  return (
    <div className="shrink-0 border-b border-border">
      {/* Row 1: Stock info — name, date, price, change, OHLCV */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 font-mono">
        {stockName && (
          <span className="text-sm text-foreground font-bold font-sans shrink-0">{stockName}</span>
        )}
        <span className={`text-xs shrink-0 ${isHover ? 'text-blue-400' : 'text-muted-foreground'}`}>{candle.date}</span>
        <span className={`text-lg font-bold tabular-nums shrink-0 ${isUp ? 'text-bull' : 'text-bear'}`}>
          {candle.close.toFixed(2)}
        </span>
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${isUp ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear'}`}>
          {isUp ? '▲' : '▼'}{Math.abs(chg).toFixed(2)} ({Math.abs(chgPct).toFixed(2)}%)
        </span>
        <div className="flex items-center gap-x-2 text-[11px] shrink-0">
          <span className="text-muted-foreground/70">開<span className="text-foreground/90 ml-0.5 tabular-nums">{candle.open.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">高<span className="text-bull ml-0.5 tabular-nums">{candle.high.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">低<span className="text-bear ml-0.5 tabular-nums">{candle.low.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">量{isTW ? '(張)' : ''}<span className="text-foreground/70 ml-0.5 tabular-nums">{candle.volume.toLocaleString()}</span></span>
        </div>
        {unrealizedPct !== null && (
          <span className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              均價<span className="text-yellow-400 font-bold ml-0.5 tabular-nums">{avgCost!.toFixed(2)}</span>
            </span>
            <span className={`font-bold ${unrealizedPct >= 0 ? 'text-bull' : 'text-bear'}`}>
              {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%
            </span>
          </span>
        )}
      </div>

      {/* Row 2: Controls — MA toggles, BB, indicators, signals, nav */}
      <div className="flex flex-wrap items-center gap-1 px-3 py-1 bg-secondary/30">
        {MA_CONFIGS.map(({ key, label }) => (
          <button key={key}
            onClick={() => onMaToggle(key)}
            aria-pressed={maToggles[key]}
            aria-label={`${maToggles[key] ? '隱藏' : '顯示'} ${label}`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              maToggles[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title={`顯示/隱藏 ${label}`}
          >{label}</button>
        ))}
        <span className="w-px h-3.5 bg-border/60 mx-0.5" />
        <button
          onClick={onBollingerToggle}
          aria-pressed={showBollinger}
          aria-label={`${showBollinger ? '隱藏' : '顯示'}布林通道`}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
            showBollinger ? 'bg-emerald-700/60 text-emerald-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
          }`}
          title="布林通道 (20, 2)"
        >BB</button>
        {INDICATOR_CONFIGS.map(({ key, label }) => (
          <button key={key}
            onClick={() => onIndicatorToggle(key)}
            aria-pressed={indicators[key]}
            aria-label={`${indicators[key] ? '隱藏' : '顯示'} ${label} 指標`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              indicators[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
          >{label}</button>
        ))}
        <span className="w-px h-3.5 bg-border/60 mx-0.5" />
        <button
          onClick={onMarkersToggle}
          aria-pressed={showMarkers}
          aria-label={`${showMarkers ? '隱藏' : '顯示'}買賣訊號標記`}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
            showMarkers ? 'bg-blue-600/60 text-blue-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
          }`}
          title="顯示/隱藏買賣訊號標記"
        >訊號</button>
        {showMarkers && (
          <select
            value={signalStrengthMin}
            onChange={e => onSignalStrengthChange(Number(e.target.value))}
            aria-label="信號共振強度過濾"
            className="px-1 py-0.5 rounded text-[10px] font-medium bg-secondary text-foreground/80 border border-border outline-none"
            title="信號共振強度過濾"
          >
            <option value={1}>全部</option>
            <option value={2}>共振≥2</option>
            <option value={3}>強≥3</option>
          </select>
        )}
        {onPrev && onNext && (
          <>
            <span className="w-px h-3.5 bg-border/60 mx-0.5" />
            <button onClick={onPrev} disabled={!canPrev} title="上一根 K 棒 (←)"
              className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">◀</button>
            <button onClick={onNext} disabled={!canNext} title="下一根 K 棒 (→)"
              className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">▶</button>
            {onReset && (
              <button onClick={onReset} title="重置走圖（回到第一根）"
                className="px-1.5 py-0.5 rounded text-[10px] font-medium transition bg-muted hover:bg-red-900/60 text-muted-foreground hover:text-red-300">↺</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
