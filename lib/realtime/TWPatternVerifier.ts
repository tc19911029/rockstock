import type { Candle } from '@/types';
import { aggregateBars, type MinuteBar } from './minuteBarStore';
import {
  dedupeSignals,
  detect,
  type DetectorContext,
  type Signal,
} from './blowoffDetector';
import { REALTIME_RULES } from '@/lib/config';

interface TWPatternVerifierDependencies {
  fetchCandles(code: string): Promise<Candle[]>;
  now(): Date;
}

const defaultDependencies: TWPatternVerifierDependencies = {
  async fetchCandles(code) {
    const { getFugleIntradayCandles } = await import('@/lib/datasource/FugleProvider');
    return getFugleIntradayCandles(code, '1m');
  },
  now: () => new Date(),
};

export type TWPatternVerificationStatus = 'verified' | 'rejected' | 'unavailable' | 'stale';

function parseTaipeiMinute(value: string): number | null {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}:00+08:00`).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function fugleCandlesToMinuteBars(
  symbol: string,
  candles: Candle[],
  now: Date,
): MinuteBar[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
  const bars: MinuteBar[] = [];
  for (const candle of candles) {
    const ts = parseTaipeiMinute(candle.date);
    if (ts == null) continue;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(ts));
    if (date !== today || !(candle.close > 0)) continue;
    bars.push({
      symbol,
      market: 'TW',
      ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      // Fugle intraday candle volume 是股；realtime 模組一律用張。
      volume: Math.round(Math.max(0, candle.volume) / 1000),
      tickCount: 1,
    });
  }
  return bars.sort((a, b) => a.ts - b.ts);
}

/**
 * MIS 只負責快速找候選；真正要進 NTFY 前，以 Fugle 的交易所分鐘 K 重算同一規則。
 * 僅保留「候選 rule + timeframe」也在精準資料成立者，避免驗證請求順帶產生新訊號。
 */
export async function verifyTWPatternCandidates(
  candidates: Signal[],
  ctx: DetectorContext,
  dependencies: TWPatternVerifierDependencies = defaultDependencies,
): Promise<{ signals: Signal[]; status: TWPatternVerificationStatus }> {
  if (candidates.length === 0) return { signals: [], status: 'rejected' };
  const now = dependencies.now();
  const code = ctx.symbol.split('.')[0];
  let candles: Candle[];
  try {
    candles = await dependencies.fetchCandles(code);
  } catch {
    return { signals: [], status: 'unavailable' };
  }
  const bars1m = fugleCandlesToMinuteBars(ctx.symbol, candles, now);
  if (bars1m.length < REALTIME_RULES.MIN_BARS_FOR_DETECT) {
    return { signals: [], status: 'unavailable' };
  }
  const latestTs = bars1m[bars1m.length - 1].ts;
  if (now.getTime() - latestTs > 150_000) {
    return { signals: [], status: 'stale' };
  }

  const wanted = new Set(candidates.map(signal => `${signal.rule}:${signal.tfMin}`));
  const exact: Signal[] = [];
  if ([...wanted].some(key => key.endsWith(':1'))) {
    exact.push(...detect(bars1m, ctx, 1, { dedupe: false }));
  }
  if ([...wanted].some(key => key.endsWith(':5'))) {
    const bars5m = aggregateBars(bars1m, 5);
    if (bars5m.length >= REALTIME_RULES.MIN_BARS_FOR_DETECT) {
      exact.push(...detect(bars5m, ctx, 5, { dedupe: false }));
    }
  }
  const matched = exact.filter(signal => wanted.has(`${signal.rule}:${signal.tfMin}`));
  return {
    signals: dedupeSignals(matched),
    status: matched.length > 0 ? 'verified' : 'rejected',
  };
}
