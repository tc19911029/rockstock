/**
 * 預設日期 helpers — 首頁 right tab default date 用。
 *
 * 為什麼不用 today：
 *   - 每日 YouTube 節目掃描要等晚上 20:15 CST 跑完才有 analysis
 *   - Candidates Pool 要等盤後 scan 完才能 build
 *   - Multi-Agent 要等使用者跑 prepare-batch + skill
 *   - 所以「今日」資料通常要到當晚或隔天才完整
 *
 * 用最近工作日當預設：週末打開首頁會顯示週五；平日早上會顯示昨天。
 * User 仍可手動切日期。
 */

/** 今天台灣時間（YYYY-MM-DD）*/
export function todayYmdTaipei(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

/**
 * 最近一個工作日（不含今天）的台灣日期字串。
 * 週一 → 上週五；其他 → 昨天。
 */
export function lastBusinessDayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  tpe.setUTCDate(tpe.getUTCDate() - 1);
  // getUTCDay 在 +8h 後仍是 Taipei 的星期（因為 dateObj 已 shift）
  while (tpe.getUTCDay() === 0 || tpe.getUTCDay() === 6) {
    tpe.setUTCDate(tpe.getUTCDate() - 1);
  }
  return tpe.toISOString().slice(0, 10);
}
