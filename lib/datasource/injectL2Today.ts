/**
 * 把今日 L2 quote 注入 L1 candle 陣列尾端
 *
 * 用途:盤中 L1 cron 還沒寫今日封存 K,但 L2 snapshot 已每幾分鐘抓一次。
 * 想算「以今日收盤為基準」的後續漲跌(forward perf / N 日漲跌)時,
 * 從 L2 抓今日 quote 拼成假 K 線塞進 candle list 尾端,讓下游純函式
 * (computeNDayReturns / ForwardAnalyzer.analyzeOne)能找到 baseDate 那根。
 *
 * 為什麼抽出來:
 * - lib/backtest/ForwardAnalyzer.ts:144-172 原本 inline,只服務 /api/backtest/forward
 * - /api/youtube/performance 用 computeNDayReturns,也需要同樣 L2 fallback,
 *   不然盤中今日 forward 全顯示 status='no_data' / null
 *
 * 規則(對齊 ForwardAnalyzer):
 *   - referenceDate 是「想算 forward 的基準日」(forward API 是 scanDate / youtube 是 baseDate)
 *   - 只在 today >= referenceDate(today 在 forward 窗或 == base)且 today 是交易日時 inject
 *   - L1 已有 today 那根 → 不動(L1 wins,因為它是封存值)
 *   - L2 snapshot 沒抓到該檔 / quote.close <= 0 → 不動
 *   - OHLC sanity:high < close 或 high > close*2 → fallback Math.max(open,close)
 */
import type { Candle } from '@/types';

export interface InjectableCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 對 candles 嘗試 inject L2 今日 quote。
 *
 * @param candles 原始 L1 candles(可帶 indicators,只讀 OHLC + date)
 * @param symbol 含後綴 (e.g. "2330.TW", "3491.TWO")
 * @param market 'TW' | 'CN'
 * @param referenceDate YYYY-MM-DD — 基準日;只在 today >= referenceDate 時才 inject
 * @returns 不影響輸入 reference;若 inject 成功回新陣列,否則回原陣列
 */
export async function injectL2TodayIfNeeded<T extends InjectableCandle>(
  candles: T[] | null,
  symbol: string,
  market: 'TW' | 'CN',
  referenceDate: string,
): Promise<T[] | null> {
  if (!candles || candles.length === 0) return candles;

  const tz = market === 'CN' ? 'Asia/Shanghai' : 'Asia/Taipei';
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  // referenceDate 之後或同日才 inject(避免歷史日子被未來 quote 污染)
  if (todayStr < referenceDate) return candles;

  const { isTradingDay } = await import('@/lib/utils/tradingDay');
  if (!isTradingDay(todayStr, market)) return candles;

  if (candles.some(c => c.date === todayStr)) return candles;

  try {
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    const snap = await readIntradaySnapshot(market, todayStr);
    if (!snap || snap.quotes.length === 0) return candles;
    const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const q = snap.quotes.find(sq => sq.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === code);
    if (!q || q.close <= 0) return candles;

    // OHLC sanity
    const safeHigh = (q.high > 0 && q.high < q.close * 2 && q.high >= q.close)
      ? q.high : Math.max(q.open, q.close);
    const safeLow = (q.low > 0 && q.low <= q.close && q.low > q.close * 0.5)
      ? q.low : Math.min(q.open, q.close);

    // 用 last candle 當 template 保留 indicators 欄位(雖然數值對不上,但下游純函式只讀 OHLC)
    const last = candles[candles.length - 1];
    const injected = {
      ...last,
      date: todayStr,
      open: q.open,
      high: safeHigh,
      low: safeLow,
      close: q.close,
      volume: q.volume,
    } as T;
    const out = [...candles, injected];
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch {
    return candles;
  }
}

/**
 * 給 ForwardAnalyzer 用的 plain Candle 版本(不帶 indicators)
 */
export async function injectL2TodayPlain(
  candles: Candle[],
  symbol: string,
  market: 'TW' | 'CN',
  targetDate: string,
): Promise<{ candles: Candle[]; injected: boolean }> {
  const before = candles.length;
  const after = await injectL2TodayIfNeeded(candles, symbol, market, targetDate);
  return { candles: after ?? candles, injected: (after?.length ?? before) > before };
}
