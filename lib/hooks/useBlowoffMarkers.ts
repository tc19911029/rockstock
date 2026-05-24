/**
 * 走圖分鐘級 K — blowoff/末升段/MA5 跌破 markers
 *
 * 在 1m/5m 時對最近 N 根跑 lib/realtime/blowoffDetector，把警示打成 chart markers。
 * 切回日/週/月 K 時回傳空陣列（書本 detector 是日 K 規則、分鐘是 caveat:'minute-inference'）。
 */
import { useMemo } from 'react';
import type { CandleWithIndicators, ChartSignalMarker } from '@/types';
import { detect, type Signal, type RuleId } from '@/lib/realtime/blowoffDetector';
import type { MinuteBar } from '@/lib/realtime/minuteBarStore';

const HISTORY_WINDOW = 500; // 最近 500 根（5m 約 5 個交易日）

const RULE_TO_TYPE: Record<RuleId, ChartSignalMarker['type']> = {
  'blowoff-bearish': 'SELL',
  'blowoff-bullish': 'BUY',
  'terminal-rally': 'SELL',
  'ma5-breakdown': 'SELL',
};

const RULE_TO_LABEL: Record<RuleId, string> = {
  'blowoff-bearish': '⚠ 爆量長黑',
  'blowoff-bullish': '💥 爆量突破',
  'terminal-rally': '🔥 末升段',
  'ma5-breakdown': '↘ MA5跌破',
};

const MINUTE_INTERVALS = new Set(['1m', '5m', '15m', '30m', '60m']);

/** 把 chart 用的 CandleWithIndicators 轉成 detector 用的 MinuteBar */
function candleToMinuteBar(c: CandleWithIndicators, symbol: string, market: 'TW' | 'CN'): MinuteBar {
  // date 可能是 "2026-05-22 13:30" 或 "2026-05-22"，前者是分鐘級
  const date = c.date.length === 10 ? `${c.date} 00:00:00` : `${c.date}:00`;
  return {
    symbol,
    market,
    ts: new Date(date).getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    tickCount: 0,
  };
}

export function useBlowoffMarkers(
  candles: CandleWithIndicators[],
  ticker: string | undefined,
  interval: string,
  isHolding: boolean,
): ChartSignalMarker[] {
  return useMemo(() => {
    if (!ticker) return [];
    if (!MINUTE_INTERVALS.has(interval)) return [];
    if (candles.length < 20) return [];

    // detector 只支援 1m / 5m；其他 minute timeframe 視為 5m 類比顯示
    const tfMin: 1 | 5 = interval === '1m' ? 1 : 5;
    const market: 'TW' | 'CN' = /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW';
    const ctx = { symbol: ticker, market, isHolding };

    // 全部轉成 MinuteBar 一次（避免 sliding 內重複轉型）
    const bars = candles.map(c => candleToMinuteBar(c, ticker, market));
    const markers: ChartSignalMarker[] = [];
    const startIdx = Math.max(20, bars.length - HISTORY_WINDOW);

    for (let i = startIdx; i < bars.length; i++) {
      // detect 看 last bar = bars[i]，所以丟前 i+1 根
      const signals: Signal[] = detect(bars.slice(0, i + 1), ctx, tfMin);
      for (const sig of signals) {
        markers.push({
          date: candles[i].date,
          type: RULE_TO_TYPE[sig.rule],
          label: RULE_TO_LABEL[sig.rule],
          strength: sig.rule === 'terminal-rally' ? 3 : 2,
        });
      }
    }
    return markers;
    // 依賴用 lastDate + length 當版本指紋（避免每 render 重算）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, interval, isHolding, candles.length, candles[candles.length - 1]?.date]);
}
