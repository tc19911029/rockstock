/**
 * A 股板別判定 + ST 判定（純函式，無 I/O）
 *
 * 板別決定漲停幅度語意：主板 10% / 創業板·科創板 20% / 北交所 30%，
 * 漲停池統計（cm20LimitUpCount）與打板風控都依賴這個分類。
 *
 * 代號規則（6 位裸碼，依交易所號段）：
 *   - 688xxx / 689xxx → 科創板（注意要在 60x 之前判，688 也是 6 開頭）
 *   - 60xxxx          → 上海主板
 *   - 30xxxx          → 創業板（300/301/302…）
 *   - 00xxxx          → 深圳主板（000/001/002/003，中小板已併入主板）
 *   - 4xxxxx / 8xxxxx / 92xxxx → 北交所（43x 精選層平移、83/87/88、920 新號段）
 *
 * 陷阱：EastMoney 池子偶有非 6 位數字（前導零被吃掉），呼叫端要先 padStart(6, '0')
 * 再進來；本檔不做防呆轉換，保持純判定。
 */

import type { CnBoardKind } from './types';

/** 6 位裸碼 → 板別。未知號段 fallback 深圳主板（10% 語意，保守不誤判成 20cm）。 */
export function classifyCnBoard(symbol: string): CnBoardKind {
  // 科創板要在「6 開頭=上海主板」之前判
  if (symbol.startsWith('688') || symbol.startsWith('689')) return 'STAR';
  if (symbol.startsWith('60')) return 'SH-main';
  if (symbol.startsWith('30')) return 'ChiNext';
  if (symbol.startsWith('00')) return 'SZ-main';
  if (symbol.startsWith('4') || symbol.startsWith('8') || symbol.startsWith('92')) return 'BJ';
  return 'SZ-main';
}

/**
 * 名稱含風險警示 / 退市標記？（ST / *ST / 退市 / XX退）
 *
 * EM 池子名稱的 ST 一律大寫拉丁字母；'退' 涵蓋「退市XX」與「XX退」兩種整理期格式。
 * 注意 XD/XR/DR 除權息前綴不是 ST，不可誤殺。
 */
export function isStName(name: string): boolean {
  return name.includes('ST') || name.includes('退');
}
