'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  Time,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LogicalRange,
  createSeriesMarkers,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import { CandleWithIndicators, RuleSignal, ChartSignalMarker } from '@/types';

// 台股慣例：漲 = 紅色，跌 = 綠色（與美股相反）
const TW_RED   = '#ef4444';  // 漲（收 > 開）
const TW_GREEN = '#22c55e';  // 跌（收 < 開）

const MA_COLORS = {
  ma5:  '#f59e0b',
  ma10: '#a78bfa',
  ma20: '#3b82f6',
  ma60: '#f97316',
};

function toTime(date: string): Time { return date as Time; }

// Shared logical range sync — export so IndicatorCharts can subscribe
export type RangeSyncCallback = (range: LogicalRange | null) => void;
const syncListeners: Set<RangeSyncCallback> = new Set();
export function subscribeRangeSync(cb: RangeSyncCallback) {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}
function broadcastRange(range: LogicalRange | null, source: IChartApi) {
  syncListeners.forEach((cb) => cb(range));
}

interface CandleChartProps {
  candles: CandleWithIndicators[];
  signals: RuleSignal[];
  chartMarkers?: ChartSignalMarker[];
  height?: number;
}

// ── Signal marker config ─────────────────────────────────────────────────────
const MARKER_CONFIG: Record<ChartSignalMarker['type'], {
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
}> = {
  BUY:    { position: 'belowBar', shape: 'arrowUp',   color: '#ef4444' },
  ADD:    { position: 'belowBar', shape: 'arrowUp',   color: '#f97316' },
  REDUCE: { position: 'aboveBar', shape: 'arrowDown', color: '#14b8a6' },
  SELL:   { position: 'aboveBar', shape: 'arrowDown', color: '#22c55e' },
  WATCH:  { position: 'aboveBar', shape: 'arrowDown', color: '#eab308' },
};

export default function CandleChart({ candles, signals, chartMarkers = [], height = 420 }: CandleChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const candleRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef      = useRef<ISeriesApi<'Histogram'> | null>(null);
  const maRefs         = useRef<Record<string, ISeriesApi<'Line'>>>({});
  const isSyncing      = useRef(false);
  const markersPlugRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: true },
      width: containerRef.current.clientWidth,
      height,
    });

    // 台股紅漲綠跌
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:         TW_RED,
      downColor:       TW_GREEN,
      borderUpColor:   TW_RED,
      borderDownColor: TW_GREEN,
      wickUpColor:     TW_RED,
      wickDownColor:   TW_GREEN,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60'] as const;
    const newMARef: Record<string, ISeriesApi<'Line'>> = {};
    for (const key of maKeys) {
      newMARef[key] = chart.addSeries(LineSeries, {
        color: MA_COLORS[key],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    }

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    maRefs.current = newMARef;
    markersPlugRef.current = createSeriesMarkers(candleSeries, []);

    // ── Broadcast range changes to indicator charts ──────────
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncing.current) return;
      isSyncing.current = true;
      broadcastRange(range, chart);
      isSyncing.current = false;
    });

    // ── Listen for range changes from indicators ─────────────
    const unsub = subscribeRangeSync((range) => {
      if (isSyncing.current) return;
      isSyncing.current = true;
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      isSyncing.current = false;
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      unsub();
      chart.remove();
      chartRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!candleRef.current || !volumeRef.current || candles.length === 0) return;

    candleRef.current.setData(candles.map((c) => ({
      time: toTime(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
    })));

    volumeRef.current.setData(candles.map((c) => ({
      time:  toTime(c.date),
      value: c.volume,
      // 台股：漲=紅量、跌=綠量
      color: c.close >= c.open ? `${TW_RED}88` : `${TW_GREEN}88`,
    })));

    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60'] as const;
    for (const key of maKeys) {
      maRefs.current[key]?.setData(
        candles.filter((c) => c[key] != null).map((c) => ({ time: toTime(c.date), value: c[key]! }))
      );
    }

    chartRef.current?.timeScale().scrollToPosition(8, false);
  }, [candles]);

  // ── Update chart markers when signal markers change ───────────────────────
  useEffect(() => {
    if (!markersPlugRef.current) return;
    const converted: SeriesMarker<Time>[] = chartMarkers.map(m => {
      const cfg = MARKER_CONFIG[m.type];
      return {
        time: m.date as Time,
        position: cfg.position,
        shape: cfg.shape,
        color: cfg.color,
        text: m.label,
        size: 1,
      };
    });
    markersPlugRef.current.setMarkers(converted);
  }, [chartMarkers]);

  return (
    <div className="relative w-full">
      {/* MA Legend */}
      <div className="absolute top-2 left-3 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        {(Object.entries(MA_COLORS) as [string, string][]).map(([key, color]) => (
          <span key={key} style={{ color }}>{key.toUpperCase()}</span>
        ))}
      </div>

      {/* Signal badges */}
      {signals.length > 0 && (
        <div className="absolute top-2 right-3 z-10 flex flex-col items-end gap-1 pointer-events-none">
          {signals.map((sig, i) => (
            <span key={i} className={`px-2 py-0.5 rounded text-xs font-bold shadow ${
              sig.type === 'BUY'    ? 'bg-red-600 text-white'     :
              sig.type === 'ADD'    ? 'bg-orange-500 text-white'  :
              sig.type === 'SELL'   ? 'bg-green-700 text-white'   :
              sig.type === 'REDUCE' ? 'bg-teal-500 text-white'    :
                                      'bg-yellow-500 text-black'
            }`}>
              {sig.label}
            </span>
          ))}
        </div>
      )}

      <div ref={containerRef} className="w-full" style={{ height }} />
    </div>
  );
}
