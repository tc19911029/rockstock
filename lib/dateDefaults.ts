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

/** YYYY-MM-DD ± N 天 → YYYY-MM-DD（不管星期，純日期算術）*/
export function shiftDateYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → "5/22 (四)" 中文週幾標籤 */
export function fmtDateLabelTw(ymd: string): string {
  try {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getUTCDay()];
    return `${m}/${d} (${week})`;
  } catch {
    return ymd;
  }
}

/**
 * 日期導覽統一規則：去重後由新到舊。
 *
 * 首頁策略掃描、YouTube／券商報告與籌碼週次都使用同一閱讀方向：
 * 左上（或第一列）永遠是最新日期，避免同一畫面切換區塊後時間方向反轉。
 */
export function newestDatesFirst(dates: string[], limit = Number.POSITIVE_INFINITY): string[] {
  return Array.from(new Set(dates))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);
}

/**
 * 日期列需保留目前選取值時，仍維持新 → 舊順序。
 * 若選取值早於最近 N 筆，就顯示「最近 N-1 筆 + 選取值」，選取值留在最右／最後。
 */
export function newestDatesIncludingSelection(dates: string[], selected: string, limit: number): string[] {
  const ordered = newestDatesFirst(selected ? [...dates, selected] : dates);
  if (ordered.length <= limit) return ordered;

  const visible = ordered.slice(0, limit);
  if (!selected || visible.includes(selected)) return visible;
  return [...ordered.slice(0, Math.max(0, limit - 1)), selected];
}
