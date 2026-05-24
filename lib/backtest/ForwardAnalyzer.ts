import { loadLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { dataProvider } from '@/lib/datasource/MultiMarketProvider';
import { rateLimiter } from '@/lib/datasource/UnifiedRateLimiter';
import { StockForwardPerformance, ForwardCandle } from '@/lib/scanner/types';
import type { Candle } from '@/types';

// 增加到 45 曆天，確保春節/國慶長假後仍能覆蓋 20+ 個交易日
const FORWARD_WINDOW_DAYS = 45;
const CONCURRENCY = 10;

/** 判斷股票所屬市場 */
function detectMarket(symbol: string): 'TW' | 'CN' {
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  return 'TW';
}

/** 取得下一個曆日的日期字串（UTC anchored 避免 server timezone shift） */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
}

/** 計算兩個日期字串之間的天數差（UTC anchored 避免 DST 偏 1 小時誤差） */
function daysBetween(a: string, b: string): number {
  const aMs = Date.parse(a + 'T00:00:00Z');
  const bMs = Date.parse(b + 'T00:00:00Z');
  return (bMs - aMs) / 86400_000;
}

/** 取得市場時區的今日日期 */
function getMarketToday(market: 'TW' | 'CN'): string {
  const tz = market === 'CN' ? 'Asia/Shanghai' : 'Asia/Taipei';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * K 棒健全性檢查（鐵律 3：API sanity check）
 * 丟掉明顯壞的 K 棒，避免上游 API bug 污染 forward 績效。
 * 反例：EastMoney klines 盤中對 002580 回 open=17.25（實為 5 天前歷史值），導致 openReturn=-38%。
 *
 * @param candles       要檢查的 K 棒（已排序遞增）
 * @param baselineClose 第一根的 prevClose 基準（通常是 scanPrice）
 * @returns 過濾後的 K 棒
 */
function sanitizeCandles(candles: Candle[], baselineClose: number): Candle[] {
  const out: Candle[] = [];
  let prevClose = baselineClose;
  for (const c of candles) {
    // 1) OHLC > 0
    if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)) continue;
    // 2) OHLC 關係：low ≤ open/close ≤ high
    if (c.low > c.open || c.low > c.close || c.high < c.open || c.high < c.close) continue;
    // 3) open vs prevClose：單日開盤跳空超過 ±15%（漲跌停 10% + 5% 緩衝）視為壞資料
    if (prevClose > 0) {
      const gap = Math.abs(c.open - prevClose) / prevClose;
      if (gap > 0.15) continue;
    }
    out.push(c);
    prevClose = c.close;
  }
  return out;
}

/**
 * 從本地 K 線檔案提取指定日期範圍的 candles
 * 本地檔案存的是完整歷史（2年+），只需要 filter 出 scanDate 之後的部分
 *
 * 注意：回傳的數據可能不完整（如連假後本地尚未更新），
 * 呼叫端應檢查 lastDate 是否涵蓋到 safeEndStr，不足時用 API 補足。
 */
async function loadForwardFromLocal(
  symbol: string,
  startStr: string,
  safeEndStr: string,
): Promise<Candle[]> {
  const market = detectMarket(symbol);
  const localCandles = await loadLocalCandles(symbol, market);
  if (!localCandles || localCandles.length === 0) return [];

  return localCandles
    .filter(c => c.date >= startStr && c.date <= safeEndStr)
    .map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}

/**
 * Analyse forward performance for a single stock after a scan date.
 * Returns null if data unavailable (caller should track for survivorship bias).
 *
 * 資料優先順序：本地 K 線 → Yahoo API（帶限流）
 */
async function analyzeOne(
  symbol:    string,
  name:      string,
  scanDate:  string,
  scanPrice: number,
): Promise<StockForwardPerformance | null> {
  try {
    const startMs  = Date.parse(scanDate) + 86400_000;
    const endMs    = startMs + FORWARD_WINDOW_DAYS * 86400_000;
    const startStr = new Date(startMs).toISOString().split('T')[0];
    const endStr   = new Date(endMs).toISOString().split('T')[0];

    // 今天的日期（用市場時區，防止取到未來數據）
    const market = detectMarket(symbol);
    const todayStr = getMarketToday(market);
    let safeEndStr = endStr > todayStr ? todayStr : endStr;

    // 若 forward window 起點已超過今天（例如今天掃描，還沒有隔日資料），直接返回空結果
    if (startStr > safeEndStr) {
      return {
        symbol, name, scanDate, scanPrice,
        openReturn: null, d1Return: null, d2Return: null, d3Return: null,
        d4Return: null, d5Return: null, d6Return: null, d7Return: null,
        d8Return: null, d9Return: null, d10Return: null, d20Return: null,
        maxGain: 0, maxLoss: 0, forwardCandles: [],
        nextOpenPrice: null,
        d1ReturnFromOpen: null, d5ReturnFromOpen: null,
        d6ReturnFromOpen: null, d7ReturnFromOpen: null,
        d8ReturnFromOpen: null, d9ReturnFromOpen: null,
        d10ReturnFromOpen: null, d20ReturnFromOpen: null,
      };
    }

    // 優先讀本地 K 線（可能不完整，下方先用 L2 補今日，再判定是否需要打 API）
    let candles = await loadForwardFromLocal(symbol, startStr, safeEndStr);

    // 2026-05-21：L2 inject 提前到 needSupplement 判定之前 ──
    //
    // 為什麼：
    // - 盤中/盤後 L1 候線通常還沒落定今日 K（5/21 dev：L1 lastDate=5/20）
    // - 原本 needSupplement 看 lastLocalDate < safeEndStr → 11 檔股票全打 FinMind API
    //   → 8-token rate limit → 每次 forward POST 卡 10-80 秒
    // - 但 L2 quote snapshot 通常已有今日 quote（cron 5 分鐘抓一次）→ 毫秒級
    // - 先試 L2 inject，多數情境填上今日 K 後 needSupplement = false，跳過 API
    //
    // 原本「L2 inject 在 needSupplement 之後」的設計理由：用 L2 覆蓋 API 回傳的錯誤 open。
    // 我們現在改成 inject 提前 + 標記跳過 API。「覆蓋 API 錯誤 open」的場景仍可 work
    // 因為若 L2 inject 成功，needSupplement = false 就不會去打 API。
    const { isTradingDay, tradingDaysBetween } = await import('@/lib/utils/tradingDay');
    const todayIsTradingDay = isTradingDay(todayStr, market);
    const l1HasToday = candles.some(c => c.date === todayStr);
    let l2InjectedToday = false;
    if (todayIsTradingDay && !l1HasToday && todayStr <= safeEndStr) {
      try {
        const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
        const snap = await readIntradaySnapshot(market, todayStr);
        if (snap && snap.quotes.length > 0) {
          const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const q = snap.quotes.find(sq => sq.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === code);
          if (q && q.close > 0) {
            // OHLC 防護
            const safeHigh = (q.high > 0 && q.high < q.close * 2 && q.high >= q.close)
              ? q.high : Math.max(q.open, q.close);
            const safeLow = (q.low > 0 && q.low <= q.close && q.low > q.close * 0.5)
              ? q.low : Math.min(q.open, q.close);
            candles.push({
              date: todayStr, open: q.open, high: safeHigh, low: safeLow,
              close: q.close, volume: q.volume,
            });
            candles.sort((a, b) => a.date.localeCompare(b.date));
            l2InjectedToday = true;
          }
        }
      } catch {
        // L2 讀取失敗不影響已有數據
      }
    }

    // 2026-05-22 fix：盤中今日 L2 snapshot 還沒寫（cron 沒跑 / 沒抓到該檔）→ 原本
    // needSupplement 會對每檔股票打 FinMind 補今日 K，15 檔 × 8-token rate limit = 60+ 秒
    // （用戶實測 R session 10 檔 04-23 forward 取 42 秒、5/20 取 81 秒）。
    // 對策：唯一缺的就是「今天」時，截到 L1 最後日期跳過 API；今日盤中 K 反正不完整，
    // 收盤後 L1 cron 補齊隔日後，再次 forward 自然會把今日納入。
    // 連假後多日缺口（gap > 1 trading day）保留原 API 補充行為。
    // 2026-05-24 fix（Stage 25）：兩段 cap 解 user 切歷史日卡 61 秒問題
    //
    // 場景：5/24 週六 user 切 5/20 看 forward d1..d20，safeEndStr=6/19（forward window 末）。
    // lastL1Date=5/22，tradingDaysBetween ≥ 20 → 原 c2d15de 條件不滿足 → 11 檔 × FinMind = 61 秒空等
    // （未來資料 API 也沒）。
    //
    // 修：
    // (1) cap safeEndStr ≤ today（未來資料不該打 API）
    // (2) 若 cap 後 lastL1Date 到 safeEndStr 沒任何 trading day → 進一步 cap = lastL1Date
    // 保留連假/週末過後 lastL1Date 仍落後 today 多日（有可補 trading day）→ 仍走 API 補足
    if (candles.length > 0) {
      const lastL1Date = candles[candles.length - 1].date;
      if (lastL1Date < safeEndStr) {
        if (safeEndStr > todayStr) safeEndStr = todayStr;
        if (tradingDaysBetween(lastL1Date, safeEndStr, market) === 0) {
          safeEndStr = lastL1Date;
        }
      }
    }

    // 檢查本地（含 L2 inject 後）數據是否涵蓋到最新交易日
    // 若最後一根 K 棒日期 < safeEndStr 且距今超過 1 天，用 API 補足缺口
    const lastLocalDate = candles.length > 0 ? candles[candles.length - 1].date : '';
    const needSupplement = candles.length === 0
      || (lastLocalDate < safeEndStr && daysBetween(lastLocalDate, safeEndStr) >= 1);

    if (needSupplement) {
      try {
        const fetchStart = candles.length > 0 ? nextDay(lastLocalDate) : startStr;
        // 0514 修：原本只走 Yahoo（TW 對 Yahoo Chart Node fetch 經常 403/429），
        // 改用 dataProvider.getCandlesRange 的多源 fallback chain
        // (TW: FinMind → EODHD → TWSE → Yahoo / CN: EastMoney → Tencent)。
        // 解 root cause：4749.TWO 05-13 L1 缺，Yahoo 也撈不到 → forward 顯示 d3=null。
        const provider = market === 'TW' ? 'finmind' : 'eastmoney';
        const baseline = candles.length > 0 ? candles[candles.length - 1].close : scanPrice;
        await rateLimiter.acquire(provider);
        const extraRaw = await dataProvider.getCandlesRange(symbol, fetchStart, safeEndStr);
        const extra = sanitizeCandles(extraRaw, baseline);
        if (extra.length === 0 && candles.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
          await rateLimiter.acquire(provider);
          const retryRaw = await dataProvider.getCandlesRange(symbol, fetchStart, safeEndStr);
          const retry = sanitizeCandles(retryRaw, baseline);
          if (retry.length > 0) {
            candles = [...candles, ...retry];
            rateLimiter.reportSuccess(provider);
          }
        } else if (extra.length > 0) {
          candles = [...candles, ...extra];
          rateLimiter.reportSuccess(provider);
        }
      } catch {
        // API 補充失敗不影響已有的 L1 數據，繼續用本地 K 線計算
      }
    }

    // P0-4: 若 scanDate 距今不超過 3 個曆天（週五掃描、長假前），
    // 數據可能尚未產生，回傳「待定」空結果而非 null（避免被計為倖存者偏差）
    if (candles.length === 0) {
      const daysSinceScan = (Date.now() - Date.parse(scanDate)) / 86400_000;
      if (daysSinceScan <= 3) {
        // 近期掃描：回傳帶空 forwardCandles 的結構，讓 UI 顯示「等待數據」
        return {
          symbol, name, scanDate, scanPrice,
          openReturn: null, d1Return: null, d2Return: null, d3Return: null,
          d4Return: null, d5Return: null, d6Return: null, d7Return: null,
          d8Return: null, d9Return: null, d10Return: null, d20Return: null,
          maxGain: 0, maxLoss: 0, forwardCandles: [],
          nextOpenPrice: null,
          d1ReturnFromOpen: null, d5ReturnFromOpen: null,
          d6ReturnFromOpen: null, d7ReturnFromOpen: null,
          d8ReturnFromOpen: null, d9ReturnFromOpen: null,
          d10ReturnFromOpen: null, d20ReturnFromOpen: null,
        };
      }
      return null; // 確實無數據（歷史數據源問題）
    }

    // 嚴格過濾：
    // 1. 必須 > scanDate（排除信號日當天被 Yahoo 回傳的情況）
    // 2. 必須 <= todayStr（排除未來數據）
    // 3. 同日去重（防禦：L2 注入 + API fetch 可能雙寫，造成 d1Return=d2Return 的重複污染）
    //    後寫入的優先（假設 L2/最後 push 是更新鮮的資料）
    const dedupMap = new Map<string, Candle>();
    for (const c of candles) {
      if (c.date > scanDate && c.date <= todayStr) dedupMap.set(c.date, c);
    }
    const filteredCandles = [...dedupMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const forwardCandles: ForwardCandle[] = filteredCandles.map((c, i) => {
      // 計算 MA5：取包含自身的最近5根收盤價平均
      let ma5: number | undefined;
      if (i >= 4) {
        const sum5 = filteredCandles.slice(i - 4, i + 1).reduce((s, x) => s + x.close, 0);
        ma5 = +(sum5 / 5).toFixed(2);
      }
      return {
        date: c.date, open: c.open, close: c.close, high: c.high, low: c.low,
        volume: c.volume,
        ma5,
      };
    });

    // 以訊號日收盤價（scanPrice）為基準的報酬率
    function retFromScan(idx: number): number | null {
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - scanPrice) / scanPrice * 100).toFixed(2);
    }

    // 以隔日開盤價為基準的報酬率（與 BacktestEngine 進場價一致）
    // 2026-05-07：對齊 BacktestEngine.ts:284-292 加漲停鎖死偵測
    // 開盤=最高 且 振幅<0.5% → 散戶買不到，nextOpenPrice 設 null 不誤導
    const entryC = forwardCandles[0];
    const lockUp = entryC && entryC.low > 0 &&
      entryC.open === entryC.high && (entryC.high - entryC.low) / entryC.low < 0.005;
    const nextOpenPrice = forwardCandles.length > 0 && !lockUp ? entryC.open : null;
    function retFromOpen(idx: number): number | null {
      if (nextOpenPrice == null || nextOpenPrice <= 0) return null;
      if (idx >= forwardCandles.length) return null;
      return +((forwardCandles[idx].close - nextOpenPrice) / nextOpenPrice * 100).toFixed(2);
    }

    const openReturn: number | null = nextOpenPrice != null
      ? +((nextOpenPrice - scanPrice) / scanPrice * 100).toFixed(2)
      : null;

    let maxGain = 0;
    let maxLoss = 0;
    for (const c of forwardCandles) {
      const highRet = (c.high - scanPrice) / scanPrice * 100;
      const lowRet  = (c.low  - scanPrice) / scanPrice * 100;
      if (highRet > maxGain) maxGain = highRet;
      if (lowRet  < maxLoss) maxLoss = lowRet;
    }

    return {
      symbol,
      name,
      scanDate,
      scanPrice,
      openReturn,
      d1Return:  retFromScan(0),
      d2Return:  retFromScan(1),
      d3Return:  retFromScan(2),
      d4Return:  retFromScan(3),
      d5Return:  retFromScan(4),
      d6Return:  retFromScan(5),
      d7Return:  retFromScan(6),
      d8Return:  retFromScan(7),
      d9Return:  retFromScan(8),
      d10Return: retFromScan(9),
      d20Return: retFromScan(19),
      maxGain:   +maxGain.toFixed(2),
      maxLoss:   +maxLoss.toFixed(2),
      forwardCandles,
      // 以隔日開盤為基準（與 BacktestEngine 進場一致）
      nextOpenPrice,
      d1ReturnFromOpen:  retFromOpen(0),
      d5ReturnFromOpen:  retFromOpen(4),
      d6ReturnFromOpen:  retFromOpen(5),
      d7ReturnFromOpen:  retFromOpen(6),
      d8ReturnFromOpen:  retFromOpen(7),
      d9ReturnFromOpen:  retFromOpen(8),
      d10ReturnFromOpen: retFromOpen(9),
      d20ReturnFromOpen: retFromOpen(19),
    };
  } catch {
    return null;
  }
}

export interface ForwardBatchResult {
  results: StockForwardPerformance[];
  /** 無法取得前瞻數據的股票數（存活偏差指標） */
  nullCount: number;
  /** 總請求數 */
  totalRequested: number;
}

/**
 * Batch-analyze forward performance for a list of stocks.
 * Returns results + null count for survivorship bias tracking.
 */
export async function analyzeForwardBatch(
  stocks:   Array<{ symbol: string; name: string; scanPrice: number }>,
  scanDate: string,
): Promise<ForwardBatchResult> {
  const results: StockForwardPerformance[] = [];
  let nullCount = 0;

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ symbol, name, scanPrice }) =>
        analyzeOne(symbol, name, scanDate, scanPrice)
      )
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      } else {
        nullCount++;
      }
    }
  }

  return { results, nullCount, totalRequested: stocks.length };
}

/**
 * Calculate summary statistics over a list of forward performances.
 */
export function calcBacktestSummary(
  perf: StockForwardPerformance[],
  horizon: 'open' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd10' | 'd20',
) {
  const key = (horizon === 'open' ? 'openReturn' : `${horizon}Return`) as keyof StockForwardPerformance;
  const returns = perf
    .map(p => p[key] as number | null)
    .filter((r): r is number => r !== null);

  if (returns.length === 0) return null;

  const wins    = returns.filter(r => r > 0).length;
  const avg     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sorted  = [...returns].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const maxGain = Math.max(...returns);
  const maxLoss = Math.min(...returns);

  return {
    count:    returns.length,
    wins,
    losses:   returns.length - wins,
    winRate:  +(wins / returns.length * 100).toFixed(1),
    avgReturn: +avg.toFixed(2),
    median:   +median.toFixed(2),
    maxGain:  +maxGain.toFixed(2),
    maxLoss:  +maxLoss.toFixed(2),
  };
}
