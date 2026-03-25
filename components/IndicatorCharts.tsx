'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  Time,
  LineSeries,
  HistogramSeries,
  LogicalRange,
} from 'lightweight-charts';
import { CandleWithIndicators } from '@/types';
import { subscribeRangeSync } from './CandleChart';

function toTime(date: string): Time { return date as Time; }

// ── Shared chart factory ─────────────────────────────────────────────────────
function makeChart(
  container: HTMLElement,
  height: number,
  showTimeAxis: boolean
): IChartApi {
  return createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: '#0f172a' },
      textColor: '#94a3b8',
    },
    grid: {
      vertLines: { color: '#1e293b' },
      horzLines: { color: '#1e293b' },
    },
    rightPriceScale: { borderColor: '#334155' },
    timeScale: {
      borderColor: '#334155',
      timeVisible: showTimeAxis,
      visible: true,
    },
    crosshair: { mode: 1 },
    width: container.clientWidth,
    height,
  });
}

// ── MACD ─────────────────────────────────────────────────────────────────────
function MACDChart({ candles }: { candles: CandleWithIndicators[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const difRef       = useRef<ISeriesApi<'Line'> | null>(null);
  const signalRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const histRef      = useRef<ISeriesApi<'Histogram'> | null>(null);
  const isSyncing    = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = makeChart(containerRef.current, 120, false);

    difRef.current    = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    signalRef.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    histRef.current   = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
    chartRef.current  = chart;

    // Sync FROM main chart
    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
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

    return () => { ro.disconnect(); unsub(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!difRef.current || !signalRef.current || !histRef.current || candles.length === 0) return;

    difRef.current.setData(
      candles.filter(c => c.macdDIF != null).map(c => ({ time: toTime(c.date), value: c.macdDIF! }))
    );
    signalRef.current.setData(
      candles.filter(c => c.macdSignal != null).map(c => ({ time: toTime(c.date), value: c.macdSignal! }))
    );
    histRef.current.setData(
      candles.filter(c => c.macdOSC != null).map(c => ({
        time:  toTime(c.date),
        value: c.macdOSC!,
        // 台股慣例：正柱（多方動能）= 紅，負柱（空方動能）= 綠
        color: c.macdOSC! >= 0 ? '#ef444499' : '#22c55e99',
      }))
    );
    chartRef.current?.timeScale().scrollToPosition(8, false);
  }, [candles]);

  const last = candles[candles.length - 1];
  return (
    <div className="relative">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-blue-400">DIF {last?.macdDIF?.toFixed(3) ?? '—'}</span>
        <span className="text-amber-400">MACD {last?.macdSignal?.toFixed(3) ?? '—'}</span>
        <span className={last?.macdOSC != null && last.macdOSC >= 0 ? 'text-red-400' : 'text-green-400'}>
          OSC {last?.macdOSC?.toFixed(3) ?? '—'}
        </span>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 120 }} />
    </div>
  );
}

// ── KD ───────────────────────────────────────────────────────────────────────
function KDChart({ candles }: { candles: CandleWithIndicators[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const kRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const dRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const isSyncing    = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = makeChart(containerRef.current, 100, true);
    chart.priceScale('right').applyOptions({ autoScale: true });

    kRef.current = chart.addSeries(LineSeries, { color: '#22c55e', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'K' });
    dRef.current = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'D' });
    chartRef.current = chart;

    // Sync FROM main chart
    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
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

    return () => { ro.disconnect(); unsub(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!kRef.current || !dRef.current || candles.length === 0) return;

    kRef.current.setData(
      candles.filter(c => c.kdK != null).map(c => ({ time: toTime(c.date), value: c.kdK! }))
    );
    dRef.current.setData(
      candles.filter(c => c.kdD != null).map(c => ({ time: toTime(c.date), value: c.kdD! }))
    );
    chartRef.current?.timeScale().scrollToPosition(8, false);
  }, [candles]);

  const last = candles[candles.length - 1];
  const kVal = last?.kdK?.toFixed(1) ?? '—';
  const dVal = last?.kdD?.toFixed(1) ?? '—';
  const zone = last?.kdK != null
    ? last.kdK >= 80 ? '超買區 ⚠' : last.kdK <= 20 ? '超賣區 ✓' : ''
    : '';
  const zoneColor = last?.kdK != null
    ? last.kdK >= 80 ? 'text-red-400' : last.kdK <= 20 ? 'text-green-400' : ''
    : '';

  return (
    <div className="relative">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none">
        <span className="text-green-400">K:{kVal}</span>
        <span className="text-orange-400">D:{dVal}</span>
        {zone && <span className={zoneColor}>{zone}</span>}
      </div>
      <div ref={containerRef} className="w-full" style={{ height: 100 }} />
    </div>
  );
}

// ── Combined ─────────────────────────────────────────────────────────────────
export default function IndicatorCharts({ candles }: { candles: CandleWithIndicators[] }) {
  if (candles.length === 0) return null;
  return (
    <div className="border border-slate-700 rounded-b-lg overflow-hidden divide-y divide-slate-700">
      <div className="bg-slate-900">
        <div className="px-3 py-1 bg-slate-800/80 text-xs font-semibold text-slate-400">
          MACD (10, 20, 10)
        </div>
        <MACDChart candles={candles} />
      </div>
      <div className="bg-slate-900">
        <div className="px-3 py-1 bg-slate-800/80 text-xs font-semibold text-slate-400">
          KD (9, 3, 3)
        </div>
        <KDChart candles={candles} />
      </div>
    </div>
  );
}
