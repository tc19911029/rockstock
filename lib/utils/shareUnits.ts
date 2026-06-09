/**
 * 股/張/手 單位換算與顯示
 *
 * 台股：1 張 = 1000 股   （顯示單位「張」）
 * 陸股：1 手 = 100 股    （顯示單位「手」）
 * 場外基金：h.shares = 份額，顯示單位「份」（無張/手概念）
 *
 * 系統內部 h.shares 一律存「股」（基金則為「份」），顯示時換算。
 */

import { isFundSymbol } from '@/lib/market/classify';

export type Market = 'TW' | 'CN';

export function lotSizeOf(market: Market): number {
  return market === 'CN' ? 100 : 1000;
}

export function unitLabelOf(market: Market): '張' | '手' {
  return market === 'CN' ? '手' : '張';
}

/** 從 symbol 後綴判斷市場（.TW/.TWO → TW；.SS/.SZ/.OF → CN；預設 TW） */
export function marketFromSymbol(symbol: string): Market {
  return /\.(SS|SZ|OF)$/i.test(symbol) ? 'CN' : 'TW';
}

/**
 * 把內部的「股」換算成顯示用的「張/手」字串。
 *
 * 範例：
 *   formatSharesAsLots(14000, 'TW') → "14 張"
 *   formatSharesAsLots(1500, 'TW')  → "1.5 張"
 *   formatSharesAsLots(300, 'CN')   → "3 手"
 */
export function formatSharesAsLots(shares: number, market: Market): string {
  const lot = lotSizeOf(market);
  const lots = shares / lot;
  const num = Number.isInteger(lots) ? String(lots) : lots.toFixed(1);
  return `${num} ${unitLabelOf(market)}`;
}

/** 只回傳數字（不帶單位），用於計算或自訂排版 */
export function sharesToLots(shares: number, market: Market): number {
  return shares / lotSizeOf(market);
}

/**
 * 持倉數量顯示（symbol-aware）：
 *   - 場外基金（.OF）→「{份額} 份」（基金以份額計，無張/手）
 *   - 股票 → 沿用 formatSharesAsLots（張/手）
 *
 * 範例：
 *   formatHoldingQty(101962.74, '000217.OF') → "101,963 份"
 *   formatHoldingQty(14000, '3661.TW')       → "14 張"
 */
export function formatHoldingQty(shares: number, symbol: string): string {
  if (isFundSymbol(symbol)) {
    return `${shares.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 份`;
  }
  return formatSharesAsLots(shares, marketFromSymbol(symbol));
}
