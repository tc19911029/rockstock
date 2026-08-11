import type { QuarterRow } from './types';

export interface TTMResult {
  /** 各期財報揭露 EPS 加總；符合報表口徑，但各季可能使用不同加權平均股數。 */
  ttmEps: number;
  /** 以目前最新股數重算的備考 TTM EPS；股本改變後用來做保守可比。 */
  proFormaTtmEps: number | null;
  ttmRevenue: number;
  ttmNetIncome: number;
  ttmNetMargin: number;
  quartersUsed: number;
}

/**
 * 近四季 EPS / 營收 / 稅後淨利加總。
 * quarters 由近到遠或由遠到近皆可，本函數只取前 4 筆（已假設來源已排序）。
 */
function quarterOrdinal(value: string): number | null {
  const label = value.match(/^(\d{4})Q([1-4])$/i);
  if (label) return Number(label[1]) * 4 + Number(label[2]);
  const date = value.match(/^(\d{4})-(\d{2})/);
  if (!date) return null;
  return Number(date[1]) * 4 + Math.ceil(Number(date[2]) / 3);
}

export function computeTTM(quarters: QuarterRow[], latestShares?: number | null): TTMResult | null {
  if (!quarters || quarters.length === 0) return null;
  const recent = [...quarters]
    .map(row => ({ row, ordinal: quarterOrdinal(row.quarter) }))
    .filter((item): item is { row: QuarterRow; ordinal: number } => item.ordinal != null)
    .sort((a, b) => b.ordinal - a.ordinal)
    .slice(0, 4);
  if (recent.length < 4) return null;
  if (new Set(recent.map(item => item.ordinal)).size !== 4) return null;
  if (recent.some((item, index) => index > 0 && recent[index - 1].ordinal - item.ordinal !== 1)) return null;
  if (recent.some(({ row }) => !Number.isFinite(row.eps) || !Number.isFinite(row.revenue) || !Number.isFinite(row.netIncome))) return null;

  const ttmEps = recent.reduce((s, item) => s + item.row.eps, 0);
  const ttmRevenue = recent.reduce((s, item) => s + item.row.revenue, 0);
  const ttmNetIncome = recent.reduce((s, item) => s + item.row.netIncome, 0);
  const ttmNetMargin = ttmRevenue > 0 ? ttmNetIncome / ttmRevenue : 0;
  const proFormaTtmEps = latestShares != null && latestShares > 0
    ? ttmNetIncome / latestShares
    : null;

  return {
    ttmEps,
    proFormaTtmEps,
    ttmRevenue,
    ttmNetIncome,
    ttmNetMargin,
    quartersUsed: recent.length,
  };
}

/**
 * 只用正式單季 EPS 計算 TTM。
 *
 * 有些官方來源（例如 TWSE 投資資訊中心）提供完整歷季 EPS，但營收／淨利欄位
 * 可能只有最近幾季。這時仍可精確計算報表口徑 TTM EPS，不應因其他欄位缺值
 * 把 EPS 一併降成 null；季度連續性與四季完整性仍維持和 computeTTM 相同門檻。
 */
export function computeReportedTTMEps(
  quarters: Array<Pick<QuarterRow, 'quarter' | 'eps'>>,
): number | null {
  const recent = [...quarters]
    .map(row => ({ row, ordinal: quarterOrdinal(row.quarter) }))
    .filter((item): item is { row: Pick<QuarterRow, 'quarter' | 'eps'>; ordinal: number } => item.ordinal != null)
    .sort((a, b) => b.ordinal - a.ordinal)
    .slice(0, 4);
  if (recent.length !== 4) return null;
  if (new Set(recent.map(item => item.ordinal)).size !== 4) return null;
  if (recent.some((item, index) => index > 0 && recent[index - 1].ordinal - item.ordinal !== 1)) return null;
  if (recent.some(({ row }) => !Number.isFinite(row.eps))) return null;
  return recent.reduce((sum, { row }) => sum + row.eps, 0);
}

export function computeTTMPe(price: number, ttmEps: number): number {
  if (!ttmEps || ttmEps <= 0) return Number.POSITIVE_INFINITY;
  return price / ttmEps;
}

/**
 * 動態 PE（市盈率「動」）= 股價 /（最新一季 EPS × 4）
 * 假設最新一季獲利可以維持全年。陸股常用，台股當作補充指標。
 *
 * 警示：如果最新一季有一次性收益（處分利益 / 匯兌 / 政府補助），
 *       動態 PE 會過度樂觀 — skill prompt 內要做扣非檢查。
 */
export function computeDynamicPe(price: number, latestQuarterEps: number): number {
  if (!latestQuarterEps || latestQuarterEps <= 0) return Number.POSITIVE_INFINITY;
  return price / (latestQuarterEps * 4);
}

/**
 * 靜態 PE（市盈率「靜」）= 股價 / 去年全年 EPS
 * 陸股 App 常見欄位。用來判斷「最新一季 EPS 是否已大幅超越去年平均獲利速度」。
 */
export function computeStaticPe(price: number, lastYearTotalEps: number): number {
  if (!lastYearTotalEps || lastYearTotalEps <= 0) return Number.POSITIVE_INFINITY;
  return price / lastYearTotalEps;
}

/**
 * 用近 8 季資料推「去年全年 EPS」= quarters[4..7] 加總（前 4 季是今年，後 4 季是去年）。
 * 如果不滿 8 季，回 null。
 */
export function computeLastYearEps(quarters: QuarterRow[]): number | null {
  const parsed = quarters
    .map(row => ({ row, ordinal: quarterOrdinal(row.quarter) }))
    .filter((item): item is { row: QuarterRow; ordinal: number } => item.ordinal != null);
  if (parsed.length === 0) return null;
  const latestYear = Math.floor((Math.max(...parsed.map(item => item.ordinal)) - 1) / 4);
  const byYear = new Map<number, Map<number, QuarterRow>>();
  for (const item of parsed) {
    const year = Math.floor((item.ordinal - 1) / 4);
    const quarter = ((item.ordinal - 1) % 4) + 1;
    if (year >= latestYear) continue;
    if (!byYear.has(year)) byYear.set(year, new Map());
    byYear.get(year)!.set(quarter, item.row);
  }
  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    const rows = byYear.get(year)!;
    if (rows.size !== 4) continue;
    const values = [1, 2, 3, 4].map(q => rows.get(q)?.eps);
    if (values.some(value => value == null || !Number.isFinite(value))) continue;
    return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  return null;
}
