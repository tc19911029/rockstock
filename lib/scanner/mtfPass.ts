import type { StockScanResult } from './types';

type MtfFields = Pick<StockScanResult, 'mtfPass' | 'mtfWeeklyPass'>;

/**
 * 新 session 優先採用已套用週／月 strict 設定的 mtfPass；只有舊資料缺欄位時
 * 才退回 mtfWeeklyPass。allowMissing 僅供歷史 UI 即時切換，避免舊 session 整批消失。
 */
export function passesMtf(result: MtfFields, allowMissing = false): boolean {
  if (result.mtfPass != null) return result.mtfPass;
  if (result.mtfWeeklyPass != null) return result.mtfWeeklyPass;
  return allowMissing;
}
