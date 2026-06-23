'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getBullBearColors } from '@/lib/chart/colors';
import { KD_OVERBOUGHT, KD_OVERSOLD } from '@/lib/analysis/bookThresholds';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  Time,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import { CandleWithIndicators } from '@/types';
import { subscribeRangeSync, getLastRange, LogicalRange, subscribeCrosshairSync } from './CandleChart';
import type { ZhuliSeries, XysTiers, LinePoint, BarPoint, ChartMarker } from '@/lib/cn-sanse/indicators';

/** Convert date string to lightweight-charts Time.
 *  Daily: 'YYYY-MM-DD' → string Time (business day)
 *  Intraday: 'YYYY-MM-DD HH:mm' → UTCTimestamp (seconds)
 *  注意：分鐘K的時間假裝是 UTC，讓 TradingView 直接顯示 CST 時間 */
function toTime(date: string): Time {
  if (date.includes(' ')) {
    const d = new Date(date.replace(' ', 'T') + ':00Z');
    return Math.floor(d.getTime() / 1000) as unknown as Time;
  }
  // 清除 TWSE 除權息日標記（如 "2025-11-17*" → "2025-11-17"）
  return date.replace(/\*$/, '') as Time;
}

function makeChart(container: HTMLElement, showTimeAxis: boolean): IChartApi {
  return createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: '#0f172a' },
      textColor: '#94a3b8',
      attributionLogo: false,
    },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    rightPriceScale: { borderColor: '#334155', minimumWidth: 80, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#334155', timeVisible: showTimeAxis, visible: true },
    crosshair: { mode: 1, vertLine: { labelVisible: false } },
    width: container.clientWidth,
    height: container.clientHeight || 80,
  });
}

/**
 * L1 單位：TW=張（vendor 已 ÷1000 入 L1）；CN=股（vendor 「手」×100 入 L1，0422 修復）
 * UI 顯示：TW 直接顯示張、CN ÷100 顯示手
 */
function formatVolume(vol: number, isTW: boolean, isCN?: boolean): string {
  if (isCN) return Math.round(vol / 100).toLocaleString();
  return vol.toLocaleString();
}

// ── Volume ────────────────────────────────────────────────────────────────────
function VolumeChart({ candles, hoverCandle, isTW, isCN }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null; isTW?: boolean; isCN?: boolean }) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const volRef        = useRef<ISeriesApi<'Histogram'> | null>(null);
  const mv5Ref        = useRef<ISeriesApi<'Line'> | null>(null);
  const mv20Ref       = useRef<ISeriesApi<'Line'> | null>(null);
  const candlesRef    = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    volRef.current  = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    mv5Ref.current  = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    mv20Ref.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    // ── Crosshair sync from main chart ────────────────────────────────────
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !volRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c) chartRef.current.setCrosshairPosition(c.volume, toTime(time), volRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!volRef.current || !mv5Ref.current || !mv20Ref.current || candles.length === 0) return;
    const { bull, bear } = getBullBearColors();
    const volScale = isCN ? 100 : 1; // CN L1 是「股」，副圖 y-axis 顯示「手」要 ÷100
    volRef.current.setData(candles.map(c => ({
      time: toTime(c.date), value: c.volume / volScale,
      color: c.close >= c.open ? `${bull}99` : `${bear}99`,
    })));
    const mv5Data = candles.map((c, i) => {
      if (i < 4) return null;
      const avg = candles.slice(i - 4, i + 1).reduce((s, x) => s + x.volume, 0) / 5;
      return { time: toTime(c.date), value: avg / volScale };
    }).filter(Boolean) as { time: Time; value: number }[];
    const mv20Data = candles.map((c, i) => {
      if (i < 19) return null;
      const avg = candles.slice(i - 19, i + 1).reduce((s, x) => s + x.volume, 0) / 20;
      return { time: toTime(c.date), value: avg / volScale };
    }).filter(Boolean) as { time: Time; value: number }[];
    mv5Ref.current.setData(mv5Data);
    mv20Ref.current.setData(mv20Data);
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles, isCN]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const displayIdx = hoverCandle ? candles.findIndex(c => c.date === hoverCandle.date) : candles.length - 1;
  const prevDisp = candles[displayIdx - 1];
  const volArrow = display && prevDisp ? (display.volume >= prevDisp.volume ? '↑' : '↓') : '';
  const volColor = display && prevDisp ? (display.volume >= prevDisp.volume ? 'text-bull' : 'text-bear') : 'text-muted-foreground';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">成交量{isTW ? '(張)' : isCN ? '(手)' : ''}</span>
        <span className="text-blue-400">MV5 {display?.avgVol5 ? formatVolume(display.avgVol5, !!isTW, !!isCN) : '—'}</span>
        <span className={`font-bold ${volColor}`}>量 {display ? formatVolume(display.volume, !!isTW, !!isCN) : '—'} {volArrow}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── MACD ─────────────────────────────────────────────────────────────────────
function MACDChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const difRef       = useRef<ISeriesApi<'Line'> | null>(null);
  const signalRef    = useRef<ISeriesApi<'Line'> | null>(null);
  const histRef      = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesRef   = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    difRef.current    = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    signalRef.current = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    histRef.current   = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
    chartRef.current  = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    // ── Crosshair sync from main chart ────────────────────────────────────
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !difRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c != null && c.macdDIF != null)
        chartRef.current.setCrosshairPosition(c.macdDIF, toTime(time), difRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!difRef.current || !signalRef.current || !histRef.current || candles.length === 0) return;
    const { bull: macdBull, bear: macdBear } = getBullBearColors();
    // Include all bars (pad warmup with 0) so bar count matches main chart → logical range sync works
    const safe = (v: number | undefined | null) => Number.isFinite(v) ? v! : 0;
    difRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: safe(c.macdDIF) })));
    signalRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: safe(c.macdSignal) })));
    histRef.current.setData(candles.map(c => ({
      time: toTime(c.date), value: safe(c.macdOSC),
      color: safe(c.macdOSC) >= 0 ? `${macdBull}99` : `${macdBear}99`,
    })));
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const displayIdx = hoverCandle ? candles.findIndex(c => c.date === hoverCandle.date) : candles.length - 1;
  const prevDisp = candles[displayIdx - 1];
  const oscArrow = display?.macdOSC != null && prevDisp?.macdOSC != null ? (display.macdOSC >= prevDisp.macdOSC ? '↑' : '↓') : '';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">MACD</span>
        <span className="text-amber-400">MACD10 {display?.macdSignal?.toFixed(2) ?? '—'}</span>
        <span className="text-blue-400">DIF {display?.macdDIF?.toFixed(2) ?? '—'}</span>
        <span className={display?.macdOSC != null && display.macdOSC >= 0 ? 'text-bull' : 'text-bear'}>
          OSC {display?.macdOSC?.toFixed(2) ?? '—'} {oscArrow}
        </span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── KD ────────────────────────────────────────────────────────────────────────
function KDChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const kRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const dRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const kMarkRef     = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candlesRef   = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);

    const kSeries = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const dSeries = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    kRef.current  = kSeries;
    dRef.current  = dSeries;
    kMarkRef.current = createSeriesMarkers(kSeries, []);
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    // ── Crosshair sync from main chart ────────────────────────────────────
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !kRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c != null && c.kdK != null)
        chartRef.current.setCrosshairPosition(c.kdK, toTime(time), kRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!kRef.current || !dRef.current || candles.length === 0) return;
    const { bull: kdBull, bear: kdBear } = getBullBearColors();
    // Pad warmup bars with 50 (neutral KD) so bar count matches main chart
    const safeKD = (v: number | undefined | null) => Number.isFinite(v) ? v! : 50;
    kRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: safeKD(c.kdK) })));
    dRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: safeKD(c.kdD) })));
    if (kMarkRef.current) {
      const dots: SeriesMarker<Time>[] = candles
        .filter(c => c.kdK != null && (c.kdK >= KD_OVERBOUGHT || c.kdK <= KD_OVERSOLD))
        .map(c => ({
          time: toTime(c.date), position: 'inBar' as const, shape: 'circle' as const,
          color: c.kdK! >= KD_OVERBOUGHT ? kdBull : kdBear, size: 0.5,
        }));
      kMarkRef.current.setMarkers(dots);
    }
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const displayIdx = hoverCandle ? candles.findIndex(c => c.date === hoverCandle.date) : candles.length - 1;
  const prevDisp = candles[displayIdx - 1];
  const kArrow = display?.kdK != null && prevDisp?.kdK != null ? (display.kdK >= prevDisp.kdK ? '↑' : '↓') : '';
  const dArrow = display?.kdD != null && prevDisp?.kdD != null ? (display.kdD >= prevDisp.kdD ? '↑' : '↓') : '';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">KD</span>
        <span className="text-blue-400">K5 {display?.kdK?.toFixed(2) ?? '—'} {kArrow}</span>
        <span className="text-orange-400">D5 {display?.kdD?.toFixed(2) ?? '—'} {dArrow}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── RSI ──────────────────────────────────────────────────────────────────────
function RSIChart({ candles, hoverCandle }: { candles: CandleWithIndicators[]; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const rsiRef       = useRef<ISeriesApi<'Line'> | null>(null);
  const markRef      = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candlesRef   = useRef<CandleWithIndicators[]>(candles);
  useEffect(() => { candlesRef.current = candles; }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);

    const rsiSeries = chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    rsiRef.current  = rsiSeries;
    markRef.current = createSeriesMarkers(rsiSeries, []);
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !rsiRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (c != null && c.rsi14 != null)
        chartRef.current.setCrosshairPosition(c.rsi14, toTime(time), rsiRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!rsiRef.current || candles.length === 0) return;
    const { bull: rsiBull, bear: rsiBear } = getBullBearColors();
    const safeRSI = (v: number | undefined | null) => Number.isFinite(v) ? v! : 50;
    rsiRef.current.setData(candles.map(c => ({ time: toTime(c.date), value: safeRSI(c.rsi14) })));
    if (markRef.current) {
      const dots: SeriesMarker<Time>[] = candles
        .filter(c => c.rsi14 != null && (c.rsi14 >= 70 || c.rsi14 <= 30))
        .map(c => ({
          time: toTime(c.date), position: 'inBar' as const, shape: 'circle' as const,
          color: c.rsi14! >= 70 ? rsiBull : rsiBear, size: 0.5,
        }));
      markRef.current.setMarkers(dots);
    }
    const chart = chartRef.current;
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chart) chart.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const rsiVal = display?.rsi14;
  const rsiColor = rsiVal != null ? (rsiVal >= 70 ? 'text-bull' : rsiVal <= 30 ? 'text-bear' : 'text-purple-400') : 'text-muted-foreground';
  const rsiZone = rsiVal != null ? (rsiVal >= 70 ? '超買' : rsiVal <= 30 ? '超賣' : '') : '';

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">RSI(14)</span>
        <span className={rsiColor}>{rsiVal?.toFixed(2) ?? '—'} {rsiZone && <span className="text-[10px]">{rsiZone}</span>}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── Chip series（外資/投信/自營/散戶 + 大戶持股 + CN 主力 + 背離訊號） ────
export interface ChipsData {
  inst: Array<{ date: string; foreign: number; trust: number; dealer: number; total: number }>;
  tdcc: Array<{ date: string; holder400Pct: number; holder1000Pct: number; holderCount?: number }>;
  cnFlow?: Array<{ date: string; mainNet: number; superLargeNet: number; largeNet: number; mediumNet: number; smallNet: number }>;
  divergence?: { type: 'bullish' | 'bearish'; priceChangePct: number; volumeChangePct: number; strength: 0 | 1 | 2 | 3; detail: string } | null;
}
type InstSeries = ChipsData; // 別名，保持原型別介面

type ChipSeriesKey = 'foreign' | 'trust' | 'dealer' | 'retail';

const CHIP_LABELS: Record<ChipSeriesKey, string> = {
  foreign: '外資',
  trust: '投信',
  dealer: '自營商',
  retail: '散戶',
};

const CHIP_DESCRIPTIONS: Partial<Record<ChipSeriesKey, string>> = {
  retail: '推算 = −三大法人合計',
};

/** 從 InstSeries 取出指定 series 的數值（以張為單位） */
function extractChipValue(row: InstSeries['inst'][number] | undefined, key: ChipSeriesKey): number {
  if (!row) return 0;
  switch (key) {
    case 'foreign': return row.foreign;
    case 'trust': return row.trust;
    case 'dealer': return row.dealer;
    case 'retail': return -row.total; // 散戶推算
  }
}

function ChipChart({ seriesKey, candles, chips, hoverCandle }: {
  seriesKey: ChipSeriesKey;
  candles: CandleWithIndicators[];
  chips?: InstSeries | null;
  hoverCandle?: CandleWithIndicators | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesRef = useRef<CandleWithIndicators[]>(candles);
  const chipsRef = useRef<InstSeries | null | undefined>(chips);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { chipsRef.current = chips; }, [chips]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    seriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    // ── Crosshair sync from main chart：跟主圖+其他副圖共享垂直對齊線 ──
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !seriesRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const c = candlesRef.current.find(x => x.date === time);
      if (!c) return;
      const row = (chipsRef.current?.inst ?? []).find(r => r.date === time);
      const v = extractChipValue(row, seriesKey);
      chartRef.current.setCrosshairPosition(v, toTime(time), seriesRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, [seriesKey]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const { bull, bear } = getBullBearColors();
    const map = new Map<string, InstSeries['inst'][number]>();
    for (const r of chips?.inst ?? []) map.set(r.date, r);
    seriesRef.current.setData(candles.map(c => {
      const v = extractChipValue(map.get(c.date), seriesKey);
      return { time: toTime(c.date), value: v, color: v >= 0 ? `${bull}cc` : `${bear}cc` };
    }));
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chartRef.current) chartRef.current.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles, chips, seriesKey]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const insts = chips?.inst ?? [];
  // Hover 有資料就用 hover；否則 fallback 到 ≤display.date 的最近一筆（避免今日 K 線缺資料時整個顯示「—」）
  let row = display ? insts.find(r => r.date === display.date) : null;
  let isFallback = false;
  if (!row && display && insts.length > 0) {
    for (let i = insts.length - 1; i >= 0; i--) {
      if (insts[i].date <= display.date) { row = insts[i]; isFallback = true; break; }
    }
  }
  const value = row ? extractChipValue(row, seriesKey) : null;
  const desc = CHIP_DESCRIPTIONS[seriesKey];

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">{CHIP_LABELS[seriesKey]}買賣超(張)</span>
        <span className={(value ?? 0) >= 0 ? 'text-bull' : 'text-bear'}>
          {value != null ? `${value >= 0 ? '+' : ''}${value.toLocaleString()}` : '—'}
        </span>
        {isFallback && row && (
          <span className="text-muted-foreground/50 text-[10px]">@ {row.date}</span>
        )}
        {desc && <span className="text-muted-foreground/50 text-[10px]">{desc}</span>}
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── 大戶持股（TDCC 集保戶股權分散） — 週柱狀副圖 ─────────────────────────────
// FinMind 補上逐週歷史後（2330 可回到 2015），改用柱狀子圖呈現（同玩股網 400/1000 張附圖）：
// 每根 K 棒 forward-fill 當週大戶比例；紅=本週增加、綠=本週減少；base 取略低於區間最小值，
// 讓週與週的變化看得出來（不從 0 畫滿）。走圖 hover 切到「日期 <= hover.date 的最後一筆」週資料。

type HolderKey = 'h400' | 'h1000';
const HOLDER_LABELS: Record<HolderKey, string> = {
  h400: '大戶 400張↑',
  h1000: '大戶 1000張↑',
};
const HOLDER_COLORS: Record<HolderKey, string> = {
  h400: '#a855f7',  // 紫
  h1000: '#ec4899', // 粉
};

function pickHolderValue(row: { holder400Pct: number; holder1000Pct: number }, key: HolderKey): number {
  return key === 'h400' ? row.holder400Pct : row.holder1000Pct;
}

/** 從 tdcc 週序列算出 header 速讀：當週值 + vs 上週變化 + 近 N 週區間 + 基準日 */
function computeHolderReadout(
  chips: ChipsData | null | undefined,
  holderKey: HolderKey,
  hoverCandle: CandleWithIndicators | null | undefined,
  candles: CandleWithIndicators[],
) {
  const tdccData = [...(chips?.tdcc ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  // hover 模式：找 date <= hoverCandle.date 的最後一筆；沒 hover 用最新一筆
  const display = hoverCandle ?? candles[candles.length - 1];
  let displayIdx = tdccData.length - 1;
  if (display) {
    for (let i = tdccData.length - 1; i >= 0; i--) {
      if (tdccData[i].date <= display.date) { displayIdx = i; break; }
    }
  }
  const current = displayIdx >= 0 ? tdccData[displayIdx] : null;
  const prior = displayIdx > 0 ? tdccData[displayIdx - 1] : null;
  const value = current ? pickHolderValue(current, holderKey) : null;
  const priorValue = prior ? pickHolderValue(prior, holderKey) : null;
  const delta = value != null && priorValue != null ? value - priorValue : null;
  const window = tdccData.slice(Math.max(0, displayIdx - 7), displayIdx + 1)
    .map(r => pickHolderValue(r, holderKey));
  const hi = window.length >= 2 ? Math.max(...window) : null;
  const lo = window.length >= 2 ? Math.min(...window) : null;
  return { empty: tdccData.length === 0, current, value, delta, hi, lo, weeks: window.length };
}

function HolderChart({ holderKey, candles, chips, hoverCandle }: {
  holderKey: HolderKey;
  candles: CandleWithIndicators[];
  chips?: ChipsData | null;
  hoverCandle?: CandleWithIndicators | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const valMapRef = useRef<Map<string, number>>(new Map()); // candle.date → forward-fill 後的當週比例
  const dataRef = useRef<Array<{ time: Time; value?: number }>>([]); // 餵給 series 的資料（含空白柱）
  const visRangeRef = useRef<{ min: number; max: number } | null>(null); // 目前可見柱子的高/低

  // 只用「目前畫面看得到的柱子」算 Y 軸高低 → 週與週的小變化才看得出來、最高柱不被切
  const recomputeVisible = useCallback((logical: LogicalRange | null) => {
    const data = dataRef.current;
    if (data.length === 0) { visRangeRef.current = null; return; }
    let from = 0, to = data.length - 1;
    if (logical) {
      from = Math.max(0, Math.floor(logical.from));
      to = Math.min(data.length - 1, Math.ceil(logical.to));
    }
    let min = Infinity, max = -Infinity;
    for (let i = from; i <= to; i++) {
      const v = data[i]?.value;
      if (typeof v !== 'number') continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    visRangeRef.current = min === Infinity ? null : { min, max };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    seriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0, // 柱子從底部實心畫上來（同玩股網附圖）；Y 軸縮放改由 autoscaleInfoProvider 緊貼可見區間
      autoscaleInfoProvider: () => {
        const r = visRangeRef.current;
        if (!r) return null;
        const span = r.max - r.min;
        const pad = Math.max(0.3, span * 0.15);
        return { priceRange: { minValue: Math.max(0, r.min - pad), maxValue: r.max + pad } };
      },
    });
    // 頂端多留白給標題文字（大戶XXX% / vs 上週 / 近N週高低），避免最高柱被標題壓住看不完整
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.28, bottom: 0.05 } });
    chartRef.current = chart;

    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) {
        recomputeVisible(range);
        chart.timeScale().setVisibleLogicalRange(range);
      }
    });
    // ── Crosshair sync from main chart：跟主圖+其他副圖共享垂直對齊線 ──
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !seriesRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const v = valMapRef.current.get(time);
      if (v != null) chartRef.current.setCrosshairPosition(v, toTime(time), seriesRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, [holderKey, recomputeVisible]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const { bull, bear } = getBullBearColors();
    const tdcc = [...(chips?.tdcc ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const valMap = new Map<string, number>();
    // forward-fill：每根 K 棒套用「日期 <= 該棒」的最後一筆週資料（candles 與 tdcc 皆已升冪）
    let wi = -1;
    const data = candles.map((c) => {
      while (wi + 1 < tdcc.length && tdcc[wi + 1].date <= c.date) wi++;
      if (wi < 0) return { time: toTime(c.date) }; // 第一筆週資料之前 → 空白柱（保持與主圖等量對齊）
      const v = pickHolderValue(tdcc[wi], holderKey);
      const priorWeek = wi > 0 ? pickHolderValue(tdcc[wi - 1], holderKey) : null;
      const up = priorWeek == null ? true : v >= priorWeek; // 紅=本週增加、綠=本週減少
      valMap.set(c.date, v);
      return { time: toTime(c.date), value: v, color: up ? `${bull}cc` : `${bear}cc` };
    });
    valMapRef.current = valMap;
    dataRef.current = data;
    recomputeVisible(getLastRange()); // 先依目前可見範圍算好高低，setData 觸發的自動縮放才讀得到
    seriesRef.current.setData(data);
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chartRef.current) {
        recomputeVisible(r);
        chartRef.current.timeScale().setVisibleLogicalRange(r);
      }
    });
  }, [candles, chips, holderKey, recomputeVisible]);

  const { empty, current, value, delta, hi, lo, weeks } = computeHolderReadout(chips, holderKey, hoverCandle, candles);

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 right-2 z-10 flex flex-wrap gap-x-3 text-xs font-mono pointer-events-none leading-tight bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">{HOLDER_LABELS[holderKey]}</span>
        {empty ? (
          <span className="text-muted-foreground/60">無資料（每週四公布）</span>
        ) : (
          <>
            <span className="font-bold tabular-nums" style={{ color: HOLDER_COLORS[holderKey] }}>
              {value != null ? `${value.toFixed(2)}%` : '—'}
            </span>
            {delta != null && (
              <span className={`tabular-nums ${delta >= 0 ? 'text-bull' : 'text-bear'}`}>
                {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(2)} vs 上週
              </span>
            )}
            {hi != null && lo != null && (
              <span className="text-muted-foreground/70 tabular-nums">
                近{weeks}週 高 {hi.toFixed(2)} / 低 {lo.toFixed(2)}
              </span>
            )}
            {current && (
              <span className="text-muted-foreground/50 text-[10px]">基準 {current.date}</span>
            )}
          </>
        )}
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── CN 主力/散戶資金（EastMoney 主力資金，每日 incremental） ─────────────────

type CnFlowKey = 'cnMain' | 'cnRetail';
const CN_FLOW_LABELS: Record<CnFlowKey, string> = {
  cnMain: '主力資金',
  cnRetail: '散戶資金',
};

function CnFlowChart({ flowKey, candles, chips, hoverCandle }: {
  flowKey: CnFlowKey;
  candles: CandleWithIndicators[];
  chips?: ChipsData | null;
  hoverCandle?: CandleWithIndicators | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candlesRef = useRef<CandleWithIndicators[]>(candles);
  const chipsRef = useRef<ChipsData | null | undefined>(chips);
  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { chipsRef.current = chips; }, [chips]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    seriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chartRef.current = chart;
    const unsub = subscribeRangeSync((range: LogicalRange | null) => {
      if (range) chart.timeScale().setVisibleLogicalRange(range);
    });
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !seriesRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      const row = (chipsRef.current?.cnFlow ?? []).find(r => r.date === time);
      if (!row) return;
      const v = flowKey === 'cnMain' ? row.mainNet : (row.mediumNet + row.smallNet);
      chartRef.current.setCrosshairPosition(v, toTime(time), seriesRef.current);
    });
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 80,
      });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); };
  }, [flowKey]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const { bull, bear } = getBullBearColors();
    const map = new Map<string, { mainNet: number; mediumNet: number; smallNet: number }>();
    for (const r of chips?.cnFlow ?? []) map.set(r.date, r);
    seriesRef.current.setData(candles.map(c => {
      const row = map.get(c.date);
      const v = row
        ? (flowKey === 'cnMain' ? row.mainNet : (row.mediumNet + row.smallNet))
        : 0;
      return { time: toTime(c.date), value: v, color: v >= 0 ? `${bull}cc` : `${bear}cc` };
    }));
    requestAnimationFrame(() => {
      const r = getLastRange();
      if (r && chartRef.current) chartRef.current.timeScale().setVisibleLogicalRange(r);
    });
  }, [candles, chips, flowKey]);

  const last = candles[candles.length - 1];
  const display = hoverCandle ?? last;
  const row = display ? (chips?.cnFlow ?? []).find(r => r.date === display.date) : null;
  const value = row
    ? (flowKey === 'cnMain' ? row.mainNet : (row.mediumNet + row.smallNet))
    : null;
  const flowCount = chips?.cnFlow?.length ?? 0;

  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">{CN_FLOW_LABELS[flowKey]}(萬元)</span>
        <span className={(value ?? 0) >= 0 ? 'text-bull' : 'text-bear'}>
          {value != null ? `${value >= 0 ? '+' : ''}${value.toLocaleString()}` : '—'}
        </span>
        {flowCount < 5 && (
          <span className="text-muted-foreground/50 text-[10px]">資料累積中（每日 16:00 自動抓）</span>
        )}
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── 三色資金副圖（主力狀態F / 捕撈季節）— 資料來自 /api/cn-sanse/chart ─────────
// 對齊主圖：以 candle 日期為基準 map（缺值補 0），確保 bar 數與主圖一致 → logical range 同步可用

export interface SanSeXysData {
  xys0: BarPoint[];
  xys1: LinePoint[];
  xys2: LinePoint[];
  subMarkers: ChartMarker[];
  xysTiers: XysTiers | null;
}

/** 把 {date→value} 系列對齊到 candle 序列（缺值補 0）*/
function alignToCandles(candles: CandleWithIndicators[], pts: { time: string; value: number }[] | undefined): { time: Time; value: number }[] {
  const m = new Map((pts ?? []).map(p => [p.time, p.value]));
  return candles.map(c => ({ time: toTime(c.date), value: m.get(c.date) ?? 0 }));
}

function setLastRange(chart: IChartApi | null) {
  requestAnimationFrame(() => { const r = getLastRange(); if (r && chart) chart.timeScale().setVisibleLogicalRange(r); });
}

// ── 主力狀態F：中線主力(紅)/控盤(黃)/短線游資(紫)/短線超跌(藍)/中線超跌(綠) 五色柱 ──
function MainForceChart({ candles, zhuli, hoverCandle }: { candles: CandleWithIndicators[]; zhuli: ZhuliSeries; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram' | 'Line'>[]>([]);
  // crosshair 同步用：主序列 + date→value map（跟主圖共享垂直虛線）
  const primaryRef = useRef<ISeriesApi<'Line'> | null>(null);
  const valMapRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    chartRef.current = chart;
    const unsub = subscribeRangeSync((range: LogicalRange | null) => { if (range) chart.timeScale().setVisibleLogicalRange(range); });
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !primaryRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      chartRef.current.setCrosshairPosition(valMapRef.current.get(time) ?? 0, toTime(time), primaryRef.current);
    });
    const ro = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight || 80 }); });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); chartRef.current = null; seriesRef.current = []; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    // 清掉上一輪 series（避免換股/replay 時疊加）
    for (const s of seriesRef.current) { try { chart.removeSeries(s); } catch { /* noop */ } }
    seriesRef.current = [];
    const bars: [LinePoint[], string][] = [
      [zhuli.midStrength, '#FF433D'], [zhuli.midControl, '#FFD000'],
      [zhuli.shortAttack, '#8000FF'], [zhuli.shortOversold, '#3B82F6'], [zhuli.midOversold, '#16C784'],
    ];
    for (const [pts, color] of bars) {
      const s = chart.addSeries(HistogramSeries, { color, base: 0, priceLineVisible: false, lastValueVisible: false });
      s.setData(alignToCandles(candles, pts).map(p => ({ ...p, value: p.value > 0 ? p.value : 0 })));
      seriesRef.current.push(s);
    }
    let lastLine: ISeriesApi<'Line'> | null = null;
    for (const [pts, color] of [[zhuli.midStrength, '#FF433D'], [zhuli.midControl, '#FFD000']] as [LinePoint[], string][]) {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(alignToCandles(candles, pts));
      seriesRef.current.push(s);
      lastLine = s;
    }
    primaryRef.current = lastLine;
    // key 用 candle 原始日期字串（crosshair 同步傳的是 candle.date，非轉換後的 Time）
    valMapRef.current = new Map(zhuli.midControl.map((p) => [p.time, p.value]));
    setLastRange(chart);
  }, [candles, zhuli]);

  const valAt = (pts: LinePoint[], date?: string) => { const v = pts.find(p => p.time === date)?.value; return v != null ? v.toFixed(2) : '—'; };
  const d = (hoverCandle ?? candles[candles.length - 1])?.date;
  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 z-10 flex gap-3 text-xs font-mono pointer-events-none bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">主力狀態F</span>
        <span className="text-fuchsia-400">短攻 {valAt(zhuli.shortAttack, d)}</span>
        <span style={{ color: '#FF433D' }}>中強 {valAt(zhuli.midStrength, d)}</span>
        <span className="text-amber-300">中控 {valAt(zhuli.midControl, d)}</span>
        <span className="text-blue-400">短超跌 {valAt(zhuli.shortOversold, d)}</span>
        <span style={{ color: '#16C784' }}>中超跌 {valAt(zhuli.midOversold, d)}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── 捕撈季節：XYS 動能柱（紫/綠）+ 4 級量能彩柱 + 快慢線 + 金叉死叉 ──
function SeasonChart({ candles, xys, hoverCandle }: { candles: CandleWithIndicators[]; xys: SanSeXysData; hoverCandle?: CandleWithIndicators | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram' | 'Line'>[]>([]);
  const primaryRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const valMapRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = makeChart(containerRef.current, false);
    chartRef.current = chart;
    const unsub = subscribeRangeSync((range: LogicalRange | null) => { if (range) chart.timeScale().setVisibleLogicalRange(range); });
    const unsubCrosshair = subscribeCrosshairSync((time) => {
      if (!chartRef.current || !primaryRef.current) return;
      if (!time) { chartRef.current.clearCrosshairPosition(); return; }
      chartRef.current.setCrosshairPosition(valMapRef.current.get(time) ?? 0, toTime(time), primaryRef.current);
    });
    const ro = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight || 80 }); });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); unsub(); unsubCrosshair(); chart.remove(); chartRef.current = null; seriesRef.current = []; };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    for (const s of seriesRef.current) { try { chart.removeSeries(s); } catch { /* noop */ } }
    seriesRef.current = [];
    // 動能柱（紫>0 / 綠<0）；對齊 candle，缺值補 0
    const xys0Map = new Map(xys.xys0.map(b => [b.time, b]));
    const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, base: 0 });
    hist.setData(candles.map(c => {
      const b = xys0Map.get(c.date);
      return { time: toTime(c.date), value: b?.value ?? 0, color: b?.color ?? '#475569' };
    }));
    seriesRef.current.push(hist);
    primaryRef.current = hist;
    valMapRef.current = new Map(xys.xys0.map((b) => [b.time, b.value]));
    // 4 級量能彩柱（稀疏，只在符合的日期出現）
    const tierBar = (pts: LinePoint[] | undefined, color: string) => {
      if (!pts?.length) return;
      const s = chart.addSeries(HistogramSeries, { color, base: 0, priceLineVisible: false, lastValueVisible: false });
      s.setData(pts.map(p => ({ time: toTime(p.time), value: p.value })));
      seriesRef.current.push(s);
    };
    if (xys.xysTiers) {
      tierBar(xys.xysTiers.green, '#16C784'); tierBar(xys.xysTiers.yellow, '#FFD000');
      tierBar(xys.xysTiers.cyan, '#22D3EE'); tierBar(xys.xysTiers.blue, '#1D4ED8');
    }
    const fast = chart.addSeries(LineSeries, { color: '#3B82F6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    fast.setData(alignToCandles(candles, xys.xys1));
    seriesRef.current.push(fast);
    const slow = chart.addSeries(LineSeries, { color: '#F59E0B', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    slow.setData(alignToCandles(candles, xys.xys2));
    seriesRef.current.push(slow);
    createSeriesMarkers(slow, xys.subMarkers.map(m => ({ time: toTime(m.time), position: m.position, shape: m.shape, color: m.color, text: m.text, size: m.size })));
    setLastRange(chart);
  }, [candles, xys]);

  const d = (hoverCandle ?? candles[candles.length - 1])?.date;
  const at = (a: { time: string; value: number }[]) => { const v = a.find(p => p.time === d)?.value; return v != null ? v.toFixed(2) : '—'; };
  const xys0v = xys.xys0.find(b => b.time === d)?.value;
  return (
    <div className="relative h-full">
      <div className="absolute top-1 left-2 right-2 z-10 flex flex-wrap gap-x-3 text-xs font-mono pointer-events-none leading-tight bg-[#0f172a]/90 rounded px-1.5 py-px">
        <span className="text-muted-foreground">捕撈季節</span>
        <span className={(xys0v ?? 0) >= 0 ? 'text-fuchsia-400' : 'text-emerald-400'}>XYS0 {at(xys.xys0)}</span>
        <span className="text-muted-foreground/60">ZZX 0.00</span>
        <span style={{ color: '#3B82F6' }}>XYS1 {at(xys.xys1)}</span>
        <span style={{ color: '#F59E0B' }}>XYS2 {at(xys.xys2)}</span>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── Combined ──────────────────────────────────────────────────────────────────
export interface IndicatorToggles {
  macd: boolean;
  kd: boolean;
  volume: boolean;
  rsi?: boolean;
  /** 外資買賣超 — 僅 TW */
  foreign?: boolean;
  /** 投信買賣超 — 僅 TW */
  trust?: boolean;
  /** 自營商買賣超 — 僅 TW */
  dealer?: boolean;
  /** 散戶買賣超推算 — 僅 TW */
  retail?: boolean;
  /** 大戶持股 400張↑ — 僅 TW */
  h400?: boolean;
  /** 大戶持股 1000張↑ — 僅 TW */
  h1000?: boolean;
  /** CN 主力資金（超大單+大單合計）— 僅 CN */
  cnMain?: boolean;
  /** CN 散戶資金（中單+小單合計）— 僅 CN */
  cnRetail?: boolean;
  /** 三色資金「主力狀態F」副圖 — 僅 CN */
  mainForce?: boolean;
  /** 三色資金「捕撈季節」副圖 — 僅 CN */
  season?: boolean;
}

export default function IndicatorCharts({ candles, hoverCandle, indicators, ticker, chips, chipsLoading, sanseZhuli, sanseXys }: {
  candles: CandleWithIndicators[];
  hoverCandle?: CandleWithIndicators | null;
  indicators?: IndicatorToggles;
  /** 股票代碼，用於判斷市場（.TW/.TWO=台股，量顯示為張） */
  ticker?: string;
  /** 籌碼面資料（法人/大戶/CN 主力），由父元件 fetch 後傳入 */
  chips?: ChipsData | null;
  /** 籌碼 fetch 進行中（顯示載入提示） */
  chipsLoading?: boolean;
  /** 三色資金「主力狀態F」副圖資料（僅 CN，開關開才傳） */
  sanseZhuli?: ZhuliSeries | null;
  /** 三色資金「捕撈季節」副圖資料（僅 CN，開關開才傳） */
  sanseXys?: SanSeXysData | null;
}) {
  if (candles.length === 0) return null;
  const isTW = ticker ? (/\.(TW|TWO)$/i.test(ticker) || /^\d{4,5}$/.test(ticker)) : false;
  const isCN = ticker ? (/\.(SS|SZ)$/i.test(ticker) || /^\d{6}$/.test(ticker)) : false;
  // 台股指數（^TWII 加權 / ^TWOII 櫃買）：三色副圖（主力狀態/捕撈季節）比照台股放行；
  // 不併進 isTW，避免動到量(張)標籤與籌碼副圖的判斷。CN 指數 000001.SS 已由 isCN(.SS) 涵蓋。
  const isTwIndex = ticker ? /^\^TW/i.test(ticker) : false;
  const show = indicators ?? { macd: true, kd: true, volume: true, rsi: false };
  const panels = [
    show.volume && <div key="vol" className="flex-1 min-h-0 bg-card"><VolumeChart candles={candles} hoverCandle={hoverCandle} isTW={isTW} isCN={isCN} /></div>,
    show.kd && <div key="kd" className="flex-1 min-h-0 bg-card"><KDChart candles={candles} hoverCandle={hoverCandle} /></div>,
    show.rsi && <div key="rsi" className="flex-1 min-h-0 bg-card"><RSIChart candles={candles} hoverCandle={hoverCandle} /></div>,
    show.macd && <div key="macd" className="flex-1 min-h-0 bg-card"><MACDChart candles={candles} hoverCandle={hoverCandle} /></div>,
    show.foreign && isTW && <div key="foreign" className="flex-1 min-h-0 bg-card"><ChipChart seriesKey="foreign" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.trust && isTW && <div key="trust" className="flex-1 min-h-0 bg-card"><ChipChart seriesKey="trust" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.dealer && isTW && <div key="dealer" className="flex-1 min-h-0 bg-card"><ChipChart seriesKey="dealer" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.retail && isTW && <div key="retail" className="flex-1 min-h-0 bg-card"><ChipChart seriesKey="retail" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.cnMain && isCN && <div key="cnMain" className="flex-1 min-h-0 bg-card"><CnFlowChart flowKey="cnMain" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.cnRetail && isCN && <div key="cnRetail" className="flex-1 min-h-0 bg-card"><CnFlowChart flowKey="cnRetail" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.mainForce && (isCN || isTW || isTwIndex) && sanseZhuli && <div key="mainForce" className="flex-1 min-h-0 bg-card"><MainForceChart candles={candles} zhuli={sanseZhuli} hoverCandle={hoverCandle} /></div>,
    show.season && (isCN || isTW || isTwIndex) && sanseXys && <div key="season" className="flex-[1.7] min-h-0 bg-card"><SeasonChart candles={candles} xys={sanseXys} hoverCandle={hoverCandle} /></div>,
    // 大戶持股（400張/1000張）一律排最後 → 不論技術/三色/籌碼模式都固定在副圖最下面（週資料，位置統一）
    show.h400 && isTW && <div key="h400" className="flex-1 min-h-0 bg-card"><HolderChart holderKey="h400" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
    show.h1000 && isTW && <div key="h1000" className="flex-1 min-h-0 bg-card"><HolderChart holderKey="h1000" candles={candles} chips={chips} hoverCandle={hoverCandle} /></div>,
  ].filter(Boolean);

  if (panels.length === 0) return <div className="h-full bg-card flex items-center justify-center text-xs text-muted-foreground/60">請開啟至少一個指標面板</div>;

  // 籌碼背離 banner（任一籌碼 toggle 開啟才顯示，避免分散注意力）
  const anyChipToggle = !!(show.foreign || show.trust || show.dealer || show.retail || show.cnMain || show.cnRetail);
  const div = anyChipToggle ? chips?.divergence : null;
  const divBg = div?.type === 'bullish' ? 'bg-emerald-900/40 border-emerald-700/50 text-emerald-300'
    : div?.type === 'bearish' ? 'bg-rose-900/40 border-rose-700/50 text-rose-300' : '';

  return (
    <div className="h-full flex flex-col divide-y divide-border overflow-hidden">
      {div && (
        <div className={`shrink-0 px-2 py-0.5 border-b text-[11px] font-mono flex items-center gap-2 ${divBg}`}>
          <span className="font-bold">{div.type === 'bullish' ? '▲ 多頭背離' : '▼ 空頭背離'}</span>
          <span className="text-foreground/70">{'★'.repeat(div.strength)}</span>
          <span className="text-foreground/60 truncate">{div.detail}</span>
        </div>
      )}
      {anyChipToggle && chipsLoading && !chips && (
        <div className="shrink-0 px-2 py-0.5 text-[10px] text-muted-foreground/60 animate-pulse">
          籌碼資料載入中...
        </div>
      )}
      {panels}
    </div>
  );
}
