/**
 * YouTube 提及股票績效追蹤 — 純函式計算 N 日 close-to-close 漲跌。
 *
 * 用法：先 `loadLocalCandles(symbol, 'TW')` 拿全段 K 線，再傳進 `computeNDayReturns`
 * 找基準日後 N 日的累計漲跌。
 *
 * 設計慣例（對齊主頁 ScanResultsCompact 的 COMPACT_FWD）：
 *   - 12 欄返回率：隔日開、1~10 日、20 日（與主頁掃描歷史完全一致）
 *   - close-to-close（baseClose vs candles[baseIdx + N].close）
 *   - openReturn = 隔日開盤 vs baseClose（仿 StockForwardPerformance）
 *   - maxGain/maxLoss = 20 日內最大累計漲跌（拿 close 對 base）
 *   - K 線檔案不含停牌日，array index +N 直接等於「第 N 個交易日」
 *   - 邊界用 status 欄位呈現：fresh=20 日全到位、stale=部份 N 越界、no_data=找不到基準日
 */

import type { CandleWithIndicators } from '@/types';

export type PerformanceStatus = 'fresh' | 'stale' | 'no_data';

export interface NDayReturns {
  status: PerformanceStatus;
  baseClose: number | null;
  openReturn: number | null;
  d1Return: number | null;
  d2Return: number | null;
  d3Return: number | null;
  d4Return: number | null;
  d5Return: number | null;
  d6Return: number | null;
  d7Return: number | null;
  d8Return: number | null;
  d9Return: number | null;
  d10Return: number | null;
  d20Return: number | null;
  maxGain: number | null;
  maxLoss: number | null;
}

const EMPTY: NDayReturns = {
  status: 'no_data',
  baseClose: null,
  openReturn: null,
  d1Return: null,
  d2Return: null,
  d3Return: null,
  d4Return: null,
  d5Return: null,
  d6Return: null,
  d7Return: null,
  d8Return: null,
  d9Return: null,
  d10Return: null,
  d20Return: null,
  maxGain: null,
  maxLoss: null,
};

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/**
 * 從基準日算 N 日後的累計漲跌（close-to-close）+ 隔日開盤跳空 + 20 日內最大/最小漲跌。
 *
 * @param candles 依日期升序的 K 線陣列；停牌日已自然不存在
 * @param baseDate 基準日 YYYY-MM-DD（通常 = analysis date）
 * @returns NDayReturns；找不到基準日回 status='no_data'，N 越界回 status='stale' 該欄 null
 */
export function computeNDayReturns(
  candles: CandleWithIndicators[],
  baseDate: string,
): NDayReturns {
  if (!candles || candles.length === 0) return EMPTY;

  const baseIdx = candles.findIndex(c => c.date === baseDate);
  if (baseIdx < 0) {
    // 找不到當天 K 線 → 可能是假日 / 停牌 / 資料未更新；嘗試找 <=baseDate 的最近一筆當基準
    const fallbackIdx = (() => {
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].date <= baseDate) return i;
      }
      return -1;
    })();
    if (fallbackIdx < 0) return EMPTY;
    return buildReturns(candles, fallbackIdx);
  }

  return buildReturns(candles, baseIdx);
}

function buildReturns(candles: CandleWithIndicators[], baseIdx: number): NDayReturns {
  const baseClose = candles[baseIdx].close;
  const nextOpen = candles[baseIdx + 1]?.open ?? null;

  const closeAt = (offset: number): number | null => {
    const c = candles[baseIdx + offset];
    return c ? c.close : null;
  };
  const retAt = (offset: number): number | null => {
    const c = closeAt(offset);
    return c != null ? pct(baseClose, c) : null;
  };

  const d1 = retAt(1);
  const d2 = retAt(2);
  const d3 = retAt(3);
  const d4 = retAt(4);
  const d5 = retAt(5);
  const d6 = retAt(6);
  const d7 = retAt(7);
  const d8 = retAt(8);
  const d9 = retAt(9);
  const d10 = retAt(10);
  const d20 = retAt(20);

  // maxGain/maxLoss：基準日後 1~20 日內，close vs baseClose 的最大/最小累計漲跌
  let maxGain: number | null = null;
  let maxLoss: number | null = null;
  for (let i = 1; i <= 20; i++) {
    const c = candles[baseIdx + i];
    if (!c) break;
    const r = pct(baseClose, c.close);
    if (maxGain === null || r > maxGain) maxGain = r;
    if (maxLoss === null || r < maxLoss) maxLoss = r;
  }

  const allFresh = d1 != null && d2 != null && d3 != null && d4 != null && d5 != null
    && d6 != null && d7 != null && d8 != null && d9 != null && d10 != null && d20 != null;

  return {
    status: allFresh ? 'fresh' : 'stale',
    baseClose,
    openReturn: nextOpen != null ? pct(baseClose, nextOpen) : null,
    d1Return: d1,
    d2Return: d2,
    d3Return: d3,
    d4Return: d4,
    d5Return: d5,
    d6Return: d6,
    d7Return: d7,
    d8Return: d8,
    d9Return: d9,
    d10Return: d10,
    d20Return: d20,
    maxGain,
    maxLoss,
  };
}
