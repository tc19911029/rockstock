/**
 * 台灣證券交易所休市日曆（非週末的額外休市日）
 * 來源：https://www.twse.com.tw/zh/trading/holiday.html
 */
const TW_HOLIDAYS_2025: string[] = [
  '2025-01-01', // 元旦
  '2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', // 農曆春節
  '2025-02-03', // 農曆春節（補假）
  '2025-02-28', // 和平紀念日
  '2025-04-03', '2025-04-04', // 兒童節+清明節
  '2025-05-01', // 勞動節
  '2025-05-30', // 端午節（5/31週六）前一日補假
  '2025-06-02', // 端午節（補假）
  '2025-10-06', // 中秋節（10/6週一）
  '2025-10-10', // 國慶日
];

const TW_HOLIDAYS_2026: string[] = [
  '2026-01-01', // 元旦
  '2026-02-12', '2026-02-13', // 農曆春節前（封關後結算日）
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', // 農曆春節
  '2026-02-27', // 和平紀念日（2/28週六，前一日補假）
  '2026-04-03', // 兒童節（4/4週六，前一日補假）
  '2026-04-06', // 清明節（4/5週日，後一日補假）
  '2026-05-01', // 勞動節
  '2026-06-19', // 端午節
  '2026-09-25', // 中秋節
  '2026-09-28', // 孔子誕辰紀念日
  '2026-10-09', // 國慶日（10/10週六，前一日補假）
  '2026-10-26', // 台灣光復節（10/25週日，後一日補假）
];

/**
 * 中國 A 股休市日曆（非週末的額外休市日）
 * 來源：https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
 */
const CN_HOLIDAYS_2025: string[] = [
  '2025-01-01', // 元旦
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', // 春節
  '2025-02-03', '2025-02-04', // 春節
  '2025-04-04', // 清明節
  '2025-05-01', '2025-05-02', // 勞動節
  '2025-05-05', // 勞動節（補假）
  '2025-06-02', // 端午節（補假）
  '2025-10-01', '2025-10-02', '2025-10-03', // 國慶節
  '2025-10-06', '2025-10-07', // 國慶節
];

const CN_HOLIDAYS_2026: string[] = [
  '2026-01-01', '2026-01-02', // 元旦
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', // 春節
  '2026-02-23', // 春節（補假，2/15週日至2/23週一休市）
  '2026-04-06', // 清明節（4/4週六至4/6週一休市）
  '2026-05-01', '2026-05-04', '2026-05-05', // 勞動節（5/1-5/5休市）
  '2026-06-19', // 端午節
  '2026-09-25', // 中秋節
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', // 國慶節
];

type Market = 'TW' | 'CN';

const TW_HOLIDAY_SET = new Set([...TW_HOLIDAYS_2025, ...TW_HOLIDAYS_2026]);
const CN_HOLIDAY_SET = new Set([...CN_HOLIDAYS_2025, ...CN_HOLIDAYS_2026]);

function getHolidaySet(market?: Market): Set<string> {
  if (market === 'CN') return CN_HOLIDAY_SET;
  return TW_HOLIDAY_SET; // 預設台股
}

/**
 * 檢查日期是否為交易日（排除週末 + 國定假日）
 * @param market 'TW' 或 'CN'，預設 'TW'
 */
export function isTradingDay(dateStr: string, market?: Market): boolean {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  if (getHolidaySet(market).has(dateStr)) return false;
  return true;
}

/**
 * Check if a date string (YYYY-MM-DD) falls on a trading day
 * @deprecated 請改用 isTradingDay()
 */
export function isWeekday(dateStr: string, market?: Market): boolean {
  return isTradingDay(dateStr, market);
}

/**
 * 計算從今天往回看，existingDates 中缺漏的交易日。
 * 回傳按日期升序排列的缺漏日期陣列，最多回傳 maxDays 筆。
 */
export function getMissingTradingDays(
  existingDates: Set<string>,
  maxDays = 5,
  market?: Market,
): string[] {
  const missing: string[] = [];
  const utc8Now = new Date(Date.now() + 8 * 3600_000);
  const todayStr = utc8Now.toISOString().split('T')[0];

  const check = new Date(todayStr + 'T12:00:00');
  let checked = 0;
  while (missing.length < maxDays && checked < maxDays + 14) {
    const dateStr = check.toISOString().split('T')[0];
    if (isTradingDay(dateStr, market)) {
      if (!existingDates.has(dateStr)) {
        missing.push(dateStr);
      }
      checked++;
    }
    check.setDate(check.getDate() - 1);
  }

  return missing.reverse();
}
