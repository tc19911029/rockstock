/**
 * 全站數字／日期格式統一工具。
 * 任何頁面顯示價格、百分比、張數、日期一律從這裡取，避免 .toFixed / toLocaleString 散落各處。
 */

/** 價格：固定 2 位小數 + $ 前綴。`null/undefined/0` 回傳 `—`。 */
export function formatPrice(value: number | null | undefined, withDollar = true): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '—';
  const s = value.toFixed(2);
  return withDollar ? `$${s}` : s;
}

/** 百分比：固定 2 位小數 + 強制 +/- 號 + `%`。 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** 成交量（股數）→ 張數，1 張 = 1000 股。 */
export function formatShares(shares: number | null | undefined): string {
  if (shares == null || !Number.isFinite(shares)) return '—';
  return `${Math.round(shares / 1000).toLocaleString('zh-TW')}張`;
}

/** 大數字：自動加千分位。 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-TW');
}

/**
 * 向零截斷到指定小數位，不做四捨五入。
 *
 * 小幅度的 tolerance 只用來抵銷 IEEE-754 在整數邊界的表示誤差，
 * 例如避免 1.15 放大 100 倍後被表示成 114.99999999999999。
 */
export function truncateToDecimals(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) {
    throw new RangeError('digits must be an integer between 0 and 10');
  }

  const factor = 10 ** digits;
  const scaled = value * factor;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const truncated = Math.trunc(scaled + Math.sign(scaled) * tolerance) / factor;
  return Object.is(truncated, -0) ? 0 : truncated;
}

/** 固定小數位並加千分位；數值先向零截斷，永不四捨五入。 */
export function formatTruncatedDecimal(
  value: number | null | undefined,
  digits = 2,
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const truncated = truncateToDecimals(value, digits);
  return truncated.toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 日期：`YYYY/M/D`（zh-TW 慣例）。輸入接受 ISO 字串或 Date。 */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-TW');
}

/** 時間：`HH:MM`（24h）。 */
export function formatTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 漲跌色 class（台股慣例：紅漲綠跌）。 */
export function bullBearClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-muted-foreground';
  return value >= 0 ? 'text-bull' : 'text-bear';
}
