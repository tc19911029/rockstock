/**
 * 漲停 / 跌停判定規則（v12 議題 76 / 64 / 77）
 *
 * 各市場漲跌停幅度：
 * - TW 一般股：±10%
 * - CN 主板：±10%
 * - CN 創業板（30xxxx）：±20%
 * - CN 科創板（68xxxx）：±20%
 * - CN ST 股：±5%
 *
 * 書本依據：書本範例多次出現漲停板進場（寶典 p.689「開盤漲停最強」），
 * 紅 K 實體 ≥ 2% 的條件需要漲停例外處理（議題 64）。
 */

import type { MarketId } from '../scanner/types';
import { gtOrEqWithTick, ltOrEqWithTick } from './tickSize';

/**
 * 取得指定市場 + 股票的漲跌停幅度（百分比，小數形式）
 *
 * @param market 市場代碼
 * @param symbol 股票代號
 * @returns 漲跌停幅度（例如 0.10 表示 ±10%）
 */
export function getLimitMovePct(market: MarketId, symbol: string): number {
  if (market === 'CN') {
    if (isChiNext(symbol)) return 0.20;     // 創業板
    if (isStarMarket(symbol)) return 0.20;  // 科創板
    if (isSTStock(symbol)) return 0.05;     // ST 股
    return 0.10;                            // 主板
  }

  // TW 一般股
  return 0.10;
}

/**
 * 判定 close 是否達當日漲停價
 *
 * 用 tick-size 容忍度避免浮點誤差。
 */
export function isLimitUp(
  close: number,
  prevClose: number,
  market: MarketId,
  symbol: string,
): boolean {
  const pct = getLimitMovePct(market, symbol);
  const limitUpPrice = prevClose * (1 + pct);
  return gtOrEqWithTick(close, limitUpPrice, market);
}

/**
 * 判定 close 是否達當日跌停價
 */
export function isLimitDown(
  close: number,
  prevClose: number,
  market: MarketId,
  symbol: string,
): boolean {
  const pct = getLimitMovePct(market, symbol);
  const limitDownPrice = prevClose * (1 - pct);
  return ltOrEqWithTick(close, limitDownPrice, market);
}

// ── CN 股票分類判定 ──────────────────────────────────────────────────────

/**
 * 創業板（深圳）：股票代碼 300xxx - 301xxx
 */
function isChiNext(symbol: string): boolean {
  const code = symbol.split('.')[0];
  return /^30\d{4}$/.test(code);
}

/**
 * 科創板（上海）：股票代碼 688xxx - 689xxx
 */
function isStarMarket(symbol: string): boolean {
  const code = symbol.split('.')[0];
  return /^68[89]\d{3}$/.test(code);
}

/**
 * ST 股：書本沒明寫識別規則，需從股票名稱判定
 *
 * 由於本 helper 只取 symbol，無法直接判定 ST 狀態。
 * 暫時回傳 false（保守處理 — 用一般 ±10% 標準）。
 *
 * TODO: 若需精確判定 ST，需從 stock metadata 讀取 securityName 並檢查 'ST' / '*ST' 前綴。
 */
function isSTStock(_symbol: string): boolean {
  return false;
}

// ── 陸股板塊分類（徽章 / 顯示層單一事實）─────────────────────────────────────

/** 陸股交易板塊。主板=滬深主板/中小板；chinext=創業板；star=科創板；bse=北交所/老三板。 */
export type CnBoard = 'main' | 'chinext' | 'star' | 'bse' | 'other';

/**
 * 依代號判定陸股交易板塊（純函式，前後端共用）。
 * 創業板 30xxxx / 科創板 68[89]xxx 用既有 isChiNext/isStarMarket（與漲停幅度同一份判定）。
 */
export function cnBoard(symbol: string): CnBoard {
  if (isChiNext(symbol)) return 'chinext';   // 創業板 20%
  if (isStarMarket(symbol)) return 'star';   // 科創板 20%
  const code = symbol.split('.')[0];
  if (/^(8|4|920)/.test(code)) return 'bse'; // 北交所 / 老三板
  if (/^(60|000|001|002|003)/.test(code)) return 'main'; // 滬深主板 + 中小板
  return 'other';
}

// ── 公開測試用 ────────────────────────────────────────────────────────────

/** 公開供測試用 */
export const __testHelpers = {
  isChiNext,
  isStarMarket,
  isSTStock,
};
