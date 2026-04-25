/**
 * FinMind 籌碼面額外資料：融資融券、當沖、借券
 *
 * 用於補足 /api/chip 老介面顯示的欄位（除了三大法人 + TDCC 之外的部分）
 */

const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';

function getToken(): string {
  return process.env.FINMIND_API_TOKEN?.replace(/['"]/g, '').trim() ?? '';
}

async function fmGet<T>(dataset: string, code: string, startDate: string, endDate?: string): Promise<T[]> {
  const token = getToken();
  if (!token) return [];
  const end = endDate ?? startDate;
  const url = `${FINMIND_API}?dataset=${dataset}&data_id=${encodeURIComponent(code)}&start_date=${startDate}&end_date=${end}&token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    const json = await res.json() as { status?: number; data?: T[] };
    if (json.status !== 200) return [];
    return json.data ?? [];
  } catch {
    return [];
  }
}

// ── 融資融券 ────────────────────────────────────────────────────────────────

export interface MarginInfo {
  /** 融資餘額（張） */
  marginBalance: number;
  /** 融資增減（今日 - 昨日，張） */
  marginNet: number;
  /** 融券餘額（張） */
  shortBalance: number;
  /** 融券增減（今日 - 昨日，張） */
  shortNet: number;
  /** 融資使用率 % */
  marginUtilRate: number;
}

interface FmMarginRow {
  MarginPurchaseTodayBalance: number;
  MarginPurchaseYesterdayBalance: number;
  MarginPurchaseLimit: number;
  ShortSaleTodayBalance: number;
  ShortSaleYesterdayBalance: number;
}

export async function fetchMarginForStock(code: string, date: string): Promise<MarginInfo | null> {
  const rows = await fmGet<FmMarginRow>('TaiwanStockMarginPurchaseShortSale', code, date);
  const r = rows[0];
  if (!r) return null;
  const marginBalance = r.MarginPurchaseTodayBalance;
  const marginNet = r.MarginPurchaseTodayBalance - r.MarginPurchaseYesterdayBalance;
  const shortBalance = r.ShortSaleTodayBalance;
  const shortNet = r.ShortSaleTodayBalance - r.ShortSaleYesterdayBalance;
  const marginUtilRate = r.MarginPurchaseLimit > 0
    ? +((marginBalance / r.MarginPurchaseLimit) * 100).toFixed(2)
    : 0;
  return { marginBalance, marginNet, shortBalance, shortNet, marginUtilRate };
}

// ── 當沖 ───────────────────────────────────────────────────────────────────

export interface DayTradeInfo {
  /** 當沖成交張數 */
  dayTradeVolume: number;
  /** 當沖比例 % = 當沖量 / 總量（需要外部傳入 totalVolume，否則為 0） */
  dayTradeRatio: number;
}

interface FmDayTradeRow {
  Volume: number;
  BuyAmount: number;
  SellAmount: number;
}

export async function fetchDayTradeForStock(code: string, date: string, totalVolumeShares?: number): Promise<DayTradeInfo | null> {
  const rows = await fmGet<FmDayTradeRow>('TaiwanStockDayTrading', code, date);
  const r = rows[0];
  if (!r) return null;
  const volume = Math.round((r.Volume ?? 0) / 1000); // 股 → 張
  const ratio = totalVolumeShares && totalVolumeShares > 0
    ? +((r.Volume / totalVolumeShares) * 100).toFixed(2)
    : 0;
  return { dayTradeVolume: volume, dayTradeRatio: ratio };
}

// ── 借券（今日 vs 7 日前比較計算淨額） ────────────────────────────────────

export interface LendingInfo {
  /** 借券今日總量（張） */
  lendingBalance: number;
  /** 借券淨增減（今日 - 上一交易日，張） */
  lendingNet: number;
}

interface FmLendingRow {
  date: string;
  volume: number;
  transaction_type: string;
}

function dateMinus(d: string, days: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

export async function fetchLendingForStock(code: string, date: string): Promise<LendingInfo | null> {
  // 一次抓 7 天區間，自己分組對比今日 vs 前一個有借券交易的日子
  const startDate = dateMinus(date, 7);
  const rows = await fmGet<FmLendingRow>('TaiwanStockSecuritiesLending', code, startDate, date);
  if (rows.length === 0) return null;

  // 按日期 group
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (!r.date) continue;
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + (r.volume ?? 0));
  }
  const sortedDates = Array.from(byDate.keys()).sort();
  const todayVol = byDate.get(date) ?? 0;
  // 找今日之前最近一個有交易的日子
  const prevDate = sortedDates.filter(d => d < date).slice(-1)[0];
  const prevVol = prevDate ? (byDate.get(prevDate) ?? 0) : 0;

  // 借券單筆通常很小（幾十~幾千股），除1000常變0；改用 ceil 確保非0值顯示為至少 1 張
  const toLots = (sharesValue: number): number => {
    if (sharesValue === 0) return 0;
    if (Math.abs(sharesValue) < 1000) return sharesValue >= 0 ? 1 : -1;
    return Math.round(sharesValue / 1000);
  };
  return {
    lendingBalance: toLots(todayVol),
    lendingNet: toLots(todayVol - prevVol),
  };
}
