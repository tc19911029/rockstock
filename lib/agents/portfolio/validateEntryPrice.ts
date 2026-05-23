/**
 * Holdings entryPrice 合理性驗證
 *
 * 背景：2026-05-22 發現 holdings.json 內 3037 欣興 entryPrice=215，
 * 但同日 K 線真實 close=970（差 351%），是測試/placeholder 資料漏進 production。
 *
 * 修法：upsertHolding 前比對 entryDate 那根 K 線的 close，超過 ±20% 拒絕。
 * 假日 fallback：往前找 5 個自然日內最近一根。
 *
 * 逃生口：API 接受 `forcePrice: true` 略過驗證（少數合理 case 如多筆平均成本）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MarketId } from '@/lib/scanner/types';

export const ENTRY_PRICE_TOLERANCE = 0.20;
export const ENTRY_PRICE_LOOKBACK_DAYS = 5;

export interface EntryPriceCandle {
  date: string;
  close: number;
}

export interface EntryPriceValidation {
  ok: boolean;
  symbol: string;
  entryDate: string;
  entryPrice: number;
  actualClose?: number;
  actualDate?: string;
  deviation?: number;
  reason?: string;
}

/**
 * 純函式：給 candles 與 entryDate/entryPrice，判斷合理性。
 *
 * 容錯：
 *   - candles 為空 → ok=true，reason='no_kline_data'（無法驗證 ≠ 不合理）
 *   - entryDate 早於最早 K 線 → ok=true，reason='entry_before_kline_history'
 *   - entryDate 是假日 → 向前 5 自然日內找最近一根
 *   - 5 自然日內找不到 → ok=true，reason='no_recent_kline'
 *   - 找到 K 線但 |entryPrice - close|/close > TOLERANCE → ok=false
 */
export function validateEntryPriceFromCandles(
  candles: readonly EntryPriceCandle[],
  symbol: string,
  entryDate: string,
  entryPrice: number,
): EntryPriceValidation {
  if (candles.length === 0) {
    return { ok: true, symbol, entryDate, entryPrice, reason: 'no_kline_data' };
  }

  // 假設 candles 已按 date asc 排序；不假設仍走 binary search 安全。
  // 找最大 date <= entryDate
  let matched: EntryPriceCandle | null = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date <= entryDate) {
      matched = candles[i];
      break;
    }
  }
  if (!matched) {
    return {
      ok: true, symbol, entryDate, entryPrice,
      reason: 'entry_before_kline_history',
    };
  }

  // entryDate 是假日的容錯：向前 N 天
  const entryDateMs = Date.parse(entryDate);
  const matchedDateMs = Date.parse(matched.date);
  const daysDiff = (entryDateMs - matchedDateMs) / 86400000;
  if (daysDiff > ENTRY_PRICE_LOOKBACK_DAYS) {
    return {
      ok: true, symbol, entryDate, entryPrice,
      reason: 'no_recent_kline',
    };
  }

  const deviation = (entryPrice - matched.close) / matched.close;
  if (Math.abs(deviation) > ENTRY_PRICE_TOLERANCE) {
    return {
      ok: false,
      symbol,
      entryDate,
      entryPrice,
      actualClose: matched.close,
      actualDate: matched.date,
      deviation,
      reason:
        `entryPrice ${entryPrice} 與 ${matched.date} K 線收盤 ${matched.close} ` +
        `差 ${(deviation * 100).toFixed(1)}%（超過 ±${(ENTRY_PRICE_TOLERANCE * 100).toFixed(0)}%）。` +
        `若確為平均成本或多筆合併，請於 API 傳 forcePrice=true 跳過驗證。`,
    };
  }

  return {
    ok: true,
    symbol,
    entryDate,
    entryPrice,
    actualClose: matched.close,
    actualDate: matched.date,
    deviation,
  };
}

/**
 * 從 data/candles/{market}/{symbol}.json 讀 K 線並驗證 entryPrice。
 *
 * K 線檔不存在 / 解析失敗 → ok=true（無法驗證 ≠ 不合理）。
 */
export async function validateEntryPrice(
  symbol: string,
  market: MarketId,
  entryDate: string,
  entryPrice: number,
): Promise<EntryPriceValidation> {
  const candlesPath = path.join(
    process.cwd(),
    'data', 'candles', market, `${symbol}.json`,
  );
  let candles: EntryPriceCandle[] = [];
  try {
    const raw = await fs.readFile(candlesPath, 'utf-8');
    const data = JSON.parse(raw) as { candles?: EntryPriceCandle[] };
    candles = Array.isArray(data.candles) ? data.candles : [];
  } catch {
    return { ok: true, symbol, entryDate, entryPrice, reason: 'no_kline_data' };
  }
  return validateEntryPriceFromCandles(candles, symbol, entryDate, entryPrice);
}
