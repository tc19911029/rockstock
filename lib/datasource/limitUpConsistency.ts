/**
 * Limit-up / limit-down consistency check
 *
 * 偵測 quote snapshot 中的「假裝沒漲跌」記錄 — 過去 mis.twse close fallback
 * bug 的指紋：close 等於 prevClose（changePercent≈0）但 high 已觸漲停 or
 * low 已觸跌停（OHLC 內部矛盾）。這條檢查的存在是為了在資料源 fallback 重蹈
 * 覆轍時立刻能被偵測到，而不是讓下游粗掃靜默漏選整批漲停股。
 *
 * 詳見：
 *   - lib/datasource/TWSERealtime.ts:resolveMisClose
 *   - memory/project_mis_twse_limit_up_close_bug_0513.md
 */

export interface ConsistencySample {
  symbol: string;
  name?: string;
  open?: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  changePercent: number;
  reason: 'fake-zero-limit-up' | 'fake-zero-limit-down';
}

export interface ConsistencyResult {
  total: number;
  suspicious: number;
  samples: ConsistencySample[];
}

interface QuoteLike {
  symbol: string;
  name?: string;
  open?: number;
  high: number;
  low: number;
  close: number;
  prevClose?: number;
  changePercent?: number;
}

const ZERO_TOLERANCE = 0.01;          // |changePercent| < 1% 視為「沒動」
const LIMIT_DETECT_RATIO = 1.095;     // high > prev*1.095 視為觸漲停
const FLOOR_DETECT_RATIO = 0.905;     // low  < prev*0.905 視為觸跌停
const FAKE_ZERO_MAX_AMPLITUDE = 0.02; // 真正 fake-zero 是「H≈L 一字板」(amplitude < 2%)；
                                       // 大波動 day 收回平盤不算 (例 2026-05-20 7709：開漲停殺到 -3.5% 收平)

export function checkLimitUpConsistency(quotes: QuoteLike[]): ConsistencyResult {
  const samples: ConsistencySample[] = [];

  for (const q of quotes) {
    if (!q.prevClose || q.prevClose <= 0) continue;
    if (!(q.close > 0) || !(q.high > 0) || !(q.low > 0)) continue;

    const reported = q.changePercent ?? ((q.close - q.prevClose) / q.prevClose) * 100;
    if (Math.abs(reported) >= ZERO_TOLERANCE) continue;

    const hitLimitUp = q.high >= q.prevClose * LIMIT_DETECT_RATIO;
    const hitLimitDown = q.low <= q.prevClose * FLOOR_DETECT_RATIO;
    if (!hitLimitUp && !hitLimitDown) continue;

    // 排除「合法波動 day 收回平盤」的 false positive：
    //   mis.twse fake-zero bug 是「一字板 H=L=漲停 + C 被抓成 prevClose」，
    //   特徵是 OHLC 內部矛盾（C < L 或 C > H）或 amplitude 接近 0。
    //   如果 close 落在 [L, H] 區間內且 amplitude 夠大 → 是真有交易、合法 close=prevClose
    const closeInRange = q.close >= q.low && q.close <= q.high;
    const amplitude = (q.high - q.low) / q.prevClose;
    if (closeInRange && amplitude > FAKE_ZERO_MAX_AMPLITUDE) continue;

    samples.push({
      symbol: q.symbol,
      name: q.name,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      prevClose: q.prevClose,
      changePercent: reported,
      reason: hitLimitUp ? 'fake-zero-limit-up' : 'fake-zero-limit-down',
    });
  }

  return {
    total: quotes.length,
    suspicious: samples.length,
    samples,
  };
}
