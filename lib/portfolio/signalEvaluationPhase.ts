import { isMarketOpen } from '@/lib/datasource/marketHours';
import type { Market } from '@/lib/utils/shareUnits';

export type SignalEvaluationPhase = 'intraday' | 'closed';

function marketDate(market: Market, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
  }).format(now);
}

/**
 * 日 K 只有在「最新一根就是今天，而且市場仍在交易」時屬於盤中暫定狀態。
 *
 * 歷史回放、非日 K、盤前與收盤後一律視為已定稿，避免把歷史訊號誤標成盤中預警。
 * 分鐘 K 有自己的 bar 完成時間，不能套用日 K 的收盤語意，因此本函式刻意只處理 1d。
 */
export function resolveSignalEvaluationPhase({
  interval,
  currentIndex,
  candleCount,
  candleDate,
  market,
  now,
}: {
  interval: string;
  currentIndex: number;
  candleCount: number;
  candleDate?: string | null;
  market: Market;
  now: Date;
}): SignalEvaluationPhase {
  if (interval !== '1d') return 'closed';
  if (candleCount <= 0 || currentIndex !== candleCount - 1) return 'closed';
  if (!candleDate || candleDate.slice(0, 10) !== marketDate(market, now)) return 'closed';
  return isMarketOpen(market, now) ? 'intraday' : 'closed';
}
