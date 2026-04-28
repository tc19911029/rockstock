'use client';

import type { Candle } from '@/types';
import type { TrendState } from '@/lib/analysis/trendAnalysis';

interface MaToggles { ma5: boolean; ma10: boolean; ma20: boolean; ma60: boolean; ma240: boolean }
interface Indicators {
  macd: boolean; kd: boolean; volume: boolean; rsi: boolean;
  /** 外資買賣超副圖 */
  foreign?: boolean;
  /** 投信買賣超副圖 */
  trust?: boolean;
  /** 自營商買賣超副圖 */
  dealer?: boolean;
  /** 散戶買賣超推算副圖 */
  retail?: boolean;
  /** 大戶持股 400張↑ 副圖 */
  h400?: boolean;
  /** 大戶持股 1000張↑ 副圖 */
  h1000?: boolean;
  /** CN 主力資金（超大單+大單） */
  cnMain?: boolean;
  /** CN 散戶資金（中單+小單） */
  cnRetail?: boolean;
}

interface ChartToolbarProps {
  candle: Candle;
  prevCandle?: Candle | null;
  isHover: boolean;
  stockName?: string;
  trend?: TrendState | null;
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
  showPivots?: boolean;
  onPivotsToggle?: () => void;
  showSupportResistance?: boolean;
  onSupportResistanceToggle?: () => void;
  showAscendingTrendline?: boolean;
  onAscendingTrendlineToggle?: () => void;
  showDescendingTrendline?: boolean;
  onDescendingTrendlineToggle?: () => void;
  avgCost?: number;
  shares?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onReset?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
  onPrevBuyPoint?: () => void;
  onNextBuyPoint?: () => void;
  canPrevBuyPoint?: boolean;
  canNextBuyPoint?: boolean;
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

/** 籌碼面副圖（僅 TW 有資料） */
const CHIP_CONFIGS_TW = [
  { key: 'foreign' as const, label: '外資', title: '外資買賣超（含外資自營商）' },
  { key: 'trust' as const, label: '投信', title: '投信買賣超' },
  { key: 'dealer' as const, label: '自營', title: '自營商買賣超（自行買賣 + 避險）' },
  { key: 'retail' as const, label: '散戶', title: '散戶買賣超（推算 = −三大法人合計）' },
  { key: 'h400' as const, label: '大戶400', title: '大戶持股 400 張↑ 比例（TDCC 集保戶股權分散，每週四公布）' },
  { key: 'h1000' as const, label: '大戶1k', title: '大戶持股 1000 張↑ 比例（TDCC 集保戶股權分散，每週四公布）' },
];

/** CN 籌碼面副圖（EastMoney 主力資金） */
const CHIP_CONFIGS_CN = [
  { key: 'cnMain' as const, label: '主力', title: 'CN 主力資金（超大單+大單，淨流入萬元，每日 16:00 自動抓）' },
  { key: 'cnRetail' as const, label: '散戶', title: 'CN 散戶資金（中單+小單，淨流入萬元）' },
];

export default function ChartToolbar({
  candle, prevCandle, isHover, stockName, trend,
  maToggles, onMaToggle,
  showBollinger, onBollingerToggle,
  indicators, onIndicatorToggle,
  showMarkers, onMarkersToggle,
  signalStrengthMin, onSignalStrengthChange,
  showPivots = false, onPivotsToggle,
  showSupportResistance = false, onSupportResistanceToggle,
  showAscendingTrendline = false, onAscendingTrendlineToggle,
  showDescendingTrendline = false, onDescendingTrendlineToggle,
  avgCost, shares,
  onPrev, onNext, onReset,
  canPrev = true, canNext = true,
  onPrevBuyPoint, onNextBuyPoint,
  canPrevBuyPoint = true, canNextBuyPoint = true,
  ticker,
}: ChartToolbarProps) {
  const chg = prevCandle ? candle.close - prevCandle.close : 0;
  const chgPct = prevCandle ? (chg / prevCandle.close) * 100 : 0;
  const isUp = chg >= 0;
  // TW 判定：有 .TW/.TWO 後綴，或純 4-6 位數字（裸代碼 2330/3661 等）
  // TW: .TW/.TWO 後綴或 4-5 位數字（裸代碼）；CN: .SS/.SZ 或 6 位數字
  const isTW = ticker ? (/\.(TW|TWO)$/i.test(ticker) || /^\d{4,5}$/.test(ticker)) : false;
  const isCN = ticker ? (/\.(SS|SZ)$/i.test(ticker) || /^\d{6}$/.test(ticker)) : false;

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
        {trend && (
          <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
            trend === '多頭' ? 'bg-emerald-900/50 text-emerald-300' :
            trend === '空頭' ? 'bg-red-900/50 text-red-300' :
            'bg-amber-900/30 text-amber-400'
          }`}>
            {trend === '多頭' ? '▲' : trend === '空頭' ? '▼' : '↔'} {trend}
          </span>
        )}
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
        {(isTW || isCN) && (
          <>
            <span className="w-px h-3.5 bg-border/60 mx-0.5" />
            {(isTW ? CHIP_CONFIGS_TW : CHIP_CONFIGS_CN).map(({ key, label, title }) => (
              <button key={key}
                onClick={() => onIndicatorToggle(key)}
                aria-pressed={!!indicators[key]}
                aria-label={`${indicators[key] ? '隱藏' : '顯示'} ${label} 副圖`}
                title={title}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                  indicators[key] ? 'bg-amber-700/60 text-amber-200' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
                }`}
              >{label}</button>
            ))}
          </>
        )}
        <span className="w-px h-3.5 bg-border/60 mx-0.5" />
        {onPivotsToggle && (
          <button
            onClick={onPivotsToggle}
            aria-pressed={showPivots}
            aria-label={`${showPivots ? '隱藏' : '顯示'}頭底標記`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showPivots ? 'bg-pink-600/60 text-pink-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="顯示/隱藏頭底標記（MA5 分段轉折波）"
          >頭底</button>
        )}
        {onSupportResistanceToggle && (
          <button
            onClick={onSupportResistanceToggle}
            aria-pressed={showSupportResistance}
            aria-label={`${showSupportResistance ? '隱藏' : '顯示'}壓力支撐線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showSupportResistance ? 'bg-amber-600/60 text-amber-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="顯示/隱藏前高壓 / 前低撐 / 大量撐壓"
          >壓撐</button>
        )}
        {onAscendingTrendlineToggle && (
          <button
            onClick={onAscendingTrendlineToggle}
            aria-pressed={showAscendingTrendline}
            aria-label={`${showAscendingTrendline ? '隱藏' : '顯示'}上升趨勢線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showAscendingTrendline ? 'bg-red-600/60 text-red-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="顯示/隱藏上升切線（連最近兩個底，兩端各延 20 天）"
          >上升線</button>
        )}
        {onDescendingTrendlineToggle && (
          <button
            onClick={onDescendingTrendlineToggle}
            aria-pressed={showDescendingTrendline}
            aria-label={`${showDescendingTrendline ? '隱藏' : '顯示'}下降趨勢線`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
              showDescendingTrendline ? 'bg-emerald-600/60 text-emerald-100' : 'bg-secondary text-muted-foreground/50 hover:text-muted-foreground'
            }`}
            title="顯示/隱藏下降切線（連最近兩個頭，兩端各延 20 天）"
          >下降線</button>
        )}
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
            {onPrevBuyPoint && (
              <button onClick={onPrevBuyPoint} disabled={!canPrevBuyPoint} title="上一個買點 (Shift+←)"
                className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-emerald-700/60 hover:bg-emerald-600 text-emerald-100 disabled:opacity-30">⏮</button>
            )}
            <button onClick={onPrev} disabled={!canPrev} title="上一根 K 棒 (←)"
              className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">◀</button>
            <button onClick={onNext} disabled={!canNext} title="下一根 K 棒 (→)"
              className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">▶</button>
            {onNextBuyPoint && (
              <button onClick={onNextBuyPoint} disabled={!canNextBuyPoint} title="下一個買點 (Shift+→)"
                className="px-1.5 py-0.5 rounded text-[10px] font-bold transition bg-emerald-700/60 hover:bg-emerald-600 text-emerald-100 disabled:opacity-30">⏭</button>
            )}
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
