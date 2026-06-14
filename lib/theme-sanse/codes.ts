// ============================================================
// 題材×三色 — 代號工具（裸碼 / 全代號 / CN 板別）。純函式。
// ============================================================

import type { CnBoardKind } from '@/lib/cn-agents/types';
import type { TsMarket } from './types';

/** 全代號 → 裸碼：600519.SS → 600519、2330.TW → 2330、8069.TWO → 8069。 */
export function bareCode(symbol: string): string {
  return symbol.split('.')[0];
}

/** CN 裸碼 → 板別（決定漲停幅度語意 + 結算 K 線路由）。 */
export function cnBoardKindFromCode(code: string): CnBoardKind {
  if (/^(688|689)/.test(code)) return 'STAR';
  if (/^(300|301)/.test(code)) return 'ChiNext';
  if (/^(8|4|920)/.test(code)) return 'BJ';
  if (/^[6]/.test(code)) return 'SH-main';
  return 'SZ-main'; // 000/001/002/003…
}

/** CN 裸碼 → 全代號（.SS/.SZ/.BJ）。 */
export function cnSymbolFromCode(code: string): string {
  const b = cnBoardKindFromCode(code);
  if (b === 'BJ') return `${code}.BJ`;
  if (b === 'SH-main' || b === 'STAR') return `${code}.SS`;
  return `${code}.SZ`;
}

/** 裸碼 → 全代號（market 派發）。TW 預設 .TW（結算/讀檔 loader 對缺檔會 fallback .TWO）。 */
export function fullSymbolFromCode(market: TsMarket, code: string): string {
  return market === 'CN' ? cnSymbolFromCode(code) : `${code}.TW`;
}

/** CN 成長板（創業/科創）— 三色掃描宇宙排除，熱門概念龍頭常在此。 */
export function isCnGrowthBoardCode(code: string): boolean {
  return /^(30|301|688|689)/.test(code);
}
