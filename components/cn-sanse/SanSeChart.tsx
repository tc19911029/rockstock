'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart, CandlestickSeries, LineSeries, HistogramSeries,
  createSeriesMarkers, type Time, type IChartApi,
} from 'lightweight-charts';
import type {
  CandlePoint, LinePoint, BarPoint, ChartMarker, ZhuliSeries, XysTiers,
} from '@/lib/cn-sanse/indicators';

export interface SanSeChartPayload {
  candles: CandlePoint[];
  zhineng: LinePoint[];
  zb4: LinePoint[];
  zb5: LinePoint[];
  duokong: LinePoint[];
  mainMarkers: ChartMarker[];
  xys0: BarPoint[];
  xys1: LinePoint[];
  xys2: LinePoint[];
  subMarkers: ChartMarker[];
  zhuli?: ZhuliSeries;
  xysTiers?: XysTiers;
}

const RED = '#FF433D';
const GREEN = '#16C784';
const CYAN = '#22D3EE';   // 陰線 / 智能交易線（與 App 一致）
const YELLOW = '#FFD000';
const PURPLE = '#E879F9';
const BLUE = '#3B82F6';

// ── legend 數值（隨 crosshair 更新；預設最後一根）──────────────────────────
interface LegendVals {
  zhineng: number; zb4: number; zb5: number; duokong: number;          // 主圖
  shortAttack: number; midStrength: number; midControl: number; shortOversold: number; // 主力狀態F
  xys0: number; xys1: number; xys2: number;                            // 捕撈季節
}

const num = (v: number | undefined): string => (v != null && Number.isFinite(v) ? v.toFixed(2) : '—');
const lastVal = (a: { value: number }[]): number => (a.length ? a[a.length - 1].value : NaN);

function valAt(map: Map<string, number>, time: string | null, fallback: number): number {
  if (time && map.has(time)) return map.get(time)!;
  return fallback;
}

export type SanSePane = 'main' | 'zhuli' | 'xys';

export function SanSeChart({
  data, bars, panes = ['main', 'zhuli', 'xys'],
}: { data: SanSeChartPayload; bars?: number; panes?: SanSePane[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [legend, setLegend] = useState<LegendVals | null>(null);

  // 動態 pane index：主圖永遠 pane 0；zhuli / xys 依 panes 出現順序取得 pane 號（−1 = 不畫）
  const zhuliPane = panes.indexOf('zhuli');
  const xysPane = panes.indexOf('xys');

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const chart: IChartApi = createChart(node, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#9ca3af', attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.1)', rightOffset: 4 },
      crosshair: { mode: 0 },
    });

    const t = (s: string) => s as unknown as Time;

    // ── 主圖 (pane 0)：K 線（App 配色：陽線紅、陰線青） ──
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: RED, downColor: CYAN, borderUpColor: RED, borderDownColor: CYAN,
      wickUpColor: RED, wickDownColor: CYAN,
    });
    candle.setData(data.candles.map((c) => ({ ...c, time: t(c.time) })));

    const line = (pts: LinePoint[], color: string, width: 1 | 2, pane: number, dotted = false) => {
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: width, priceLineVisible: false, lastValueVisible: false,
        lineStyle: dotted ? 2 : 0,
      }, pane);
      s.setData(pts.map((p) => ({ time: t(p.time), value: p.value })));
      return s;
    };

    line(data.zhineng, CYAN, 2, 0);               // 智能交易線（青粗）
    line(data.zb4, YELLOW, 1, 0);                 // ZB4 黃線
    line(data.zb5, RED, 1, 0);                    // ZB5 紅線
    line(data.duokong, YELLOW, 1, 0, true);       // 多空線 MA60（黃點線）

    createSeriesMarkers(candle, data.mainMarkers.map((m) => ({
      time: t(m.time), position: m.position, shape: m.shape, color: m.color, text: m.text,
    })));

    // ── 副圖：主力狀態F 五色柱（與 App 同序，緊接主圖之下）──
    const hbar = (pts: LinePoint[], color: string, pane: number) => {
      const s = chart.addSeries(HistogramSeries, {
        color, base: 0, priceLineVisible: false, lastValueVisible: false,
      }, pane);
      s.setData(pts.map((p) => ({ time: t(p.time), value: p.value > 0 ? p.value : 0 })));
    };
    if (zhuliPane >= 0 && data.zhuli) {
      hbar(data.zhuli.midStrength, RED, zhuliPane);          // 紅 中線主力
      hbar(data.zhuli.midControl, YELLOW, zhuliPane);        // 黃 控盤
      hbar(data.zhuli.shortAttack, PURPLE, zhuliPane);       // 紫 短線游資
      hbar(data.zhuli.shortOversold, BLUE, zhuliPane);       // 藍 短線超跌
      hbar(data.zhuli.midOversold, GREEN, zhuliPane);        // 綠 中線超跌
      line(data.zhuli.midStrength, RED, 2, zhuliPane);
      line(data.zhuli.midControl, YELLOW, 2, zhuliPane);
    }

    // ── 副圖：捕撈季節（XYS 動能柱 + 快慢線 + 金叉死叉）──
    if (xysPane >= 0) {
      const hist = chart.addSeries(HistogramSeries, {
        priceLineVisible: false, lastValueVisible: false, base: 0,
      }, xysPane);
      hist.setData(data.xys0.map((b) => ({ time: t(b.time), value: b.value, color: b.color })));

      const tierBar = (pts: LinePoint[] | undefined, color: string) => {
        if (!pts?.length) return;
        const s = chart.addSeries(HistogramSeries, { color, base: 0, priceLineVisible: false, lastValueVisible: false }, xysPane);
        s.setData(pts.map((p) => ({ time: t(p.time), value: p.value })));
      };
      if (data.xysTiers) {
        tierBar(data.xysTiers.green, '#16C784');
        tierBar(data.xysTiers.yellow, '#FFD000');
        tierBar(data.xysTiers.cyan, '#22D3EE');
        tierBar(data.xysTiers.blue, '#1D4ED8');
      }

      line(data.xys1, BLUE, 2, xysPane);
      const slow = line(data.xys2, '#4080FF', 2, xysPane);
      createSeriesMarkers(slow, data.subMarkers.map((m) => ({
        time: t(m.time), position: m.position, shape: m.shape, color: m.color, text: m.text, size: m.size,
      })));
    }

    // 主圖加高、副圖較矮（依實際 pane 數動態套用）
    chart.panes().forEach((p, idx) => p.setStretchFactor(idx === 0 ? 4 : 1.4));

    // ── legend 值：time→value map（缺 zhuli 時對應欄位留空 map）──
    const toMap = (pts?: { time: string; value: number }[]): Map<string, number> =>
      new Map((pts ?? []).map((p) => [p.time, p.value]));
    const maps = {
      zhineng: toMap(data.zhineng), zb4: toMap(data.zb4), zb5: toMap(data.zb5), duokong: toMap(data.duokong),
      shortAttack: toMap(data.zhuli?.shortAttack), midStrength: toMap(data.zhuli?.midStrength),
      midControl: toMap(data.zhuli?.midControl), shortOversold: toMap(data.zhuli?.shortOversold),
      xys0: toMap(data.xys0), xys1: toMap(data.xys1), xys2: toMap(data.xys2),
    };
    const fallback: LegendVals = {
      zhineng: lastVal(data.zhineng), zb4: lastVal(data.zb4), zb5: lastVal(data.zb5), duokong: lastVal(data.duokong),
      shortAttack: lastVal(data.zhuli?.shortAttack ?? []), midStrength: lastVal(data.zhuli?.midStrength ?? []),
      midControl: lastVal(data.zhuli?.midControl ?? []), shortOversold: lastVal(data.zhuli?.shortOversold ?? []),
      xys0: lastVal(data.xys0), xys1: lastVal(data.xys1), xys2: lastVal(data.xys2),
    };
    setLegend(fallback);

    const buildAt = (time: string | null): LegendVals => ({
      zhineng: valAt(maps.zhineng, time, fallback.zhineng), zb4: valAt(maps.zb4, time, fallback.zb4),
      zb5: valAt(maps.zb5, time, fallback.zb5), duokong: valAt(maps.duokong, time, fallback.duokong),
      shortAttack: valAt(maps.shortAttack, time, fallback.shortAttack), midStrength: valAt(maps.midStrength, time, fallback.midStrength),
      midControl: valAt(maps.midControl, time, fallback.midControl), shortOversold: valAt(maps.shortOversold, time, fallback.shortOversold),
      xys0: valAt(maps.xys0, time, fallback.xys0), xys1: valAt(maps.xys1, time, fallback.xys1), xys2: valAt(maps.xys2, time, fallback.xys2),
    });

    chart.subscribeCrosshairMove((param) => {
      const time = param.time ? String(param.time) : null;
      setLegend(buildAt(time));
    });

    // 顯示根數可調：用實際日期定位最近 N 根（logical range 在多序列時會定位錯邊）
    const len = data.candles.length;
    if (bars && bars > 0 && len > bars) {
      chart.timeScale().setVisibleRange({
        from: t(data.candles[len - bars].time),
        to: t(data.candles[len - 1].time),
      });
    } else {
      chart.timeScale().fitContent();
    }

    return () => chart.remove();
  }, [data, bars, zhuliPane, xysPane]);

  return (
    <div className="relative w-full h-full">
      <div ref={ref} className="w-full h-full" />
      {/* 三個 pane 左上角數值標籤（按 stretch 4/1.4/1.4 比例對齊 pane 頂部）*/}
      <div className="pointer-events-none absolute inset-0 flex flex-col pb-7 pl-2 text-[11px] tabular-nums">
        <Legend grow={4} title="雙B戰法主圖" items={[
          ['智能交易線', num(legend?.zhineng), CYAN],
          ['ZB4', num(legend?.zb4), YELLOW],
          ['ZB5', num(legend?.zb5), RED],
          ['ZB8', num(legend?.duokong), '#FFD000'],
        ]} />
        {zhuliPane >= 0 && (
          <Legend grow={1.4} title="主力狀態F" items={[
            ['短線上攻', num(legend?.shortAttack), PURPLE],
            ['中線強勢', num(legend?.midStrength), RED],
            ['中線控盤', num(legend?.midControl), YELLOW],
            ['短線超跌', num(legend?.shortOversold), BLUE],
          ]} />
        )}
        {xysPane >= 0 && (
          <Legend grow={1.4} title="捕撈季節" items={[
            ['XYS0', num(legend?.xys0), CYAN],
            ['ZZX', '0.00', '#9ca3af'],
            ['XYS1', num(legend?.xys1), BLUE],
            ['XYS2', num(legend?.xys2), '#4080FF'],
          ]} />
        )}
      </div>
    </div>
  );
}

function Legend({ grow, title, items }: { grow: number; title: string; items: [string, string, string][] }) {
  return (
    <div style={{ flexGrow: grow, flexBasis: 0 }} className="flex items-start pt-0.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0 leading-tight">
        <span className="text-muted-foreground font-medium">{title}</span>
        {items.map(([label, value, color]) => (
          <span key={label}>
            <span className="text-muted-foreground/70">{label}:</span>
            <span style={{ color }}>{value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
