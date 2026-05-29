/**
 * 籌碼趨勢偵測 — 把「連 N 賣 / N 增轉減 / 5 週累計 +X%」這類籌碼 K 線常見標記程式化
 *
 * 設計原則：
 *   - 純函式，吃時間序列 array，回標準 TrendInfo
 *   - 「連續 N」= 至少連續 N 個交易日同向（買或賣），允許 0 不打斷（書本「靜默日」算延續）
 *   - 「N 增轉減」/ 「N 減轉增」= 最新一筆方向反轉，且反轉前已連續 N 天同向
 */

export interface TrendInfo {
  /** 'up' | 'down' | 'flat' — 最新一筆方向 */
  direction: 'up' | 'down' | 'flat';
  /** 連續同向天數（含最新一筆）。flat 時為 0 */
  consecutiveCount: number;
  /** true = 前一波連續同向被打破（增轉減 / 減轉增）*/
  reversal: boolean;
  /** 反轉前的連續天數（reversal=true 時才有意義）*/
  prevStreak: number;
  /** 中文標籤（連 5 賣、連 3 增轉減 等）*/
  label: string;
}

/**
 * 從一個 daily values 陣列（升冪日期）算趨勢。
 *
 * @param values  升冪排序的當日淨值（>0 = 增 / 買，<0 = 減 / 賣，0 = 中性）
 * @param noun    label 用字：「買」「賣」「增」「減」對的名詞（如「外資」「融資」「主力」）
 *                預設用「買/賣」(法人面)；融資/借券可傳 'inc' = 「增/減」
 */
export function detectTrend(
  values: number[],
  mode: 'buy_sell' | 'inc_dec' = 'buy_sell',
): TrendInfo {
  if (values.length === 0) {
    return { direction: 'flat', consecutiveCount: 0, reversal: false, prevStreak: 0, label: '無資料' };
  }
  const upLabel = mode === 'buy_sell' ? '買' : '增';
  const downLabel = mode === 'buy_sell' ? '賣' : '減';

  const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const latest = values[values.length - 1];
  const latestSign = sign(latest);

  if (latestSign === 0) {
    return { direction: 'flat', consecutiveCount: 0, reversal: false, prevStreak: 0, label: '持平' };
  }

  // 從最新一筆往回數，計算連續同向天數（含本筆）
  // 籌碼 K 線慣例：0 (持平日) 中斷連續 — 不視為延續
  let consecutive = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const s = sign(values[i]);
    if (s === latestSign) consecutive++;
    else break;  // 0 或反向都中斷
  }

  // 檢查反轉：往回從第 consecutive+1 筆開始數反向 streak
  // 跳過 silent (0) days 直到找到第一個非 0 反向值，然後從那邊數
  let prevStreak = 0;
  let skipIdx = values.length - 1 - consecutive;
  // 先跳過 silent days
  while (skipIdx >= 0 && sign(values[skipIdx]) === 0) skipIdx--;
  if (skipIdx >= 0) {
    const reversalSign = sign(values[skipIdx]);
    if (reversalSign !== latestSign) {
      for (let i = skipIdx; i >= 0; i--) {
        const s = sign(values[i]);
        if (s === reversalSign) prevStreak++;
        else break;  // 0 或反向中斷
      }
    }
  }

  // 籌碼 K 線標籤慣例：
  //   - 「剛反轉」(consec=1, prevStreak >= 2)：顯示「連 N 反向轉現方向」(外資 5/27 連 4 賣轉買)
  //   - 「持續同向」(consec >= 2)：顯示「連 N 現方向」(投信 連 3 賣)
  //   - 單日方向（consec=1, prevStreak < 2）：顯示「{方向}」 (no 連)
  const reversal = consecutive === 1 && prevStreak >= 2;
  const dirLabel = latestSign > 0 ? upLabel : downLabel;
  const oppositeDirLabel = latestSign > 0 ? downLabel : upLabel;

  let label: string;
  if (reversal) {
    label = `連${prevStreak}${oppositeDirLabel}轉${dirLabel}`;
  } else if (consecutive >= 2) {
    label = `連${consecutive}${dirLabel}`;
  } else {
    label = dirLabel;
  }

  return {
    direction: latestSign > 0 ? 'up' : 'down',
    consecutiveCount: consecutive,
    reversal,
    prevStreak,
    label,
  };
}

/**
 * 5 週 / 5 月累計變化。
 *
 * @param series  升冪日期序列 [{date, value}]
 * @param windowDays  例 35 (5 週) / 150 (5 月)
 * @returns 變化值（最新 − 窗口起點），及變化方向
 */
export function rollingChange(
  series: Array<{ date: string; value: number }>,
  windowDays: number,
): { delta: number; pct: number | null; direction: 'up' | 'down' | 'flat' } {
  if (series.length === 0) return { delta: 0, pct: null, direction: 'flat' };
  const latest = series[series.length - 1];
  const latestDate = new Date(latest.date + 'T00:00:00Z');
  const cutoff = new Date(latestDate.getTime() - windowDays * 86400_000);
  // 找窗口起點最接近的那筆
  let base = series[0];
  for (const r of series) {
    if (new Date(r.date + 'T00:00:00Z') >= cutoff) {
      base = r;
      break;
    }
  }
  const delta = latest.value - base.value;
  const pct = base.value !== 0 ? delta / Math.abs(base.value) : null;
  return {
    delta,
    pct,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
  };
}
