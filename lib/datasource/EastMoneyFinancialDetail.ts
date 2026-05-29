/**
 * EastMoneyFinancialDetail.ts — 東方財富 f10 主要指標季報（2026-05-27）
 *
 * 補 EastMoneyFundamentals.ts 缺的「季度營收 YoY / 歸母淨利 YoY / 扣非淨利 / 扣非淨利 YoY /
 * 季毛利率 / 季淨利率 / ROE / 經營現金流」。
 *
 * Endpoint：
 *   https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/MainTargetAjax/Get?code={SH|SZ}{code}
 *
 * 回傳是 JSON 陣列，每筆對應一個 reporting period（最新在前）：
 *   [{REPORT_DATE, REPORT_TYPE, EPSJB, BPS, ROEJQ, OPERATEINCOME_YOY, PARENTNETPROFIT_YOY,
 *     KFJLR_YOY, SJL, XSMLL, PARENTNETPROFIT, KFJLR, OPERATEINCOME, ...}, ...]
 *
 * 失敗 / 缺欄位 / API 改版 → 回 null（單檔不阻斷批次）。
 * 8 小時記憶體 cache（季報每天最多更新一次）。
 *
 * 注意：本檔不爬巨潮（巨潮給 PDF，需 PDF 解析才能取得「非經常性損益細項」，留 V2）。
 *       目前用「扣非淨利 / 歸母淨利」比例做為「非經常性收益占比」proxy。
 */

import { globalCache } from './MemoryCache';

const DETAIL_TTL = 8 * 60 * 60 * 1000; // 8 小時

export interface EastMoneyQuarterDetail {
  reportDate: string;             // YYYY-MM-DD
  reportType: string;             // 一季報 / 中報 / 三季報 / 年報
  eps: number | null;             // 基本每股收益（單季）
  bookValuePerShare: number | null;  // 每股淨資產
  roe: number | null;             // ROE（加權）%
  revenue: number | null;         // 營業收入（元）
  revenueYoY: number | null;      // 營業收入 YoY %
  parentNetProfit: number | null; // 歸母淨利（元）
  parentNetProfitYoY: number | null; // 歸母淨利 YoY %
  deductedNetProfit: number | null;     // 扣非淨利（元）
  deductedNetProfitYoY: number | null;  // 扣非淨利 YoY %
  grossMargin: number | null;     // 銷售毛利率 %
  netMargin: number | null;       // 銷售淨利率 %
}

export interface EastMoneyFinancialDetail {
  code: string;
  quarters: EastMoneyQuarterDetail[];   // 由近到遠
  sourceUrl: string;
  fetchedAt: string;
}

function detectMarketPrefix(stockId: string): 'SH' | 'SZ' | null {
  const bare = stockId.replace(/\.(SS|SZ)$/i, '');
  if (!/^\d{6}$/.test(bare)) return null;
  if (/^(6|9)/.test(bare)) return 'SH';   // 滬 A / 科創板
  if (/^(0|1|2|3)/.test(bare)) return 'SZ'; // 深 A / 創業板
  return null;
}

function n(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '--' || s === 'null') return null;
    const num = Number(s);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

interface RawRow {
  REPORT_DATE?: string;
  REPORT_TYPE?: string;
  EPSJB?: number | string;        // 基本 EPS
  BPS?: number | string;          // 每股淨資產
  ROEJQ?: number | string;        // ROE 加權 %
  OPERATEINCOME?: number | string;
  OPERATEINCOME_YOY?: number | string;
  PARENTNETPROFIT?: number | string;
  PARENTNETPROFIT_YOY?: number | string;
  KFJLR?: number | string;        // 扣非淨利
  KFJLR_YOY?: number | string;
  XSMLL?: number | string;        // 銷售毛利率 %
  SJL?: number | string;          // 銷售淨利率 %
  // 其他欄位（暫不取）
  [k: string]: unknown;
}

export async function getEastMoneyFinancialDetail(
  stockId: string,
): Promise<EastMoneyFinancialDetail | null> {
  const cacheKey = `emFinDetail:${stockId}`;
  const cached = globalCache.get<EastMoneyFinancialDetail>(cacheKey);
  if (cached) return cached;

  const prefix = detectMarketPrefix(stockId);
  if (!prefix) return null;
  const bare = stockId.replace(/\.(SS|SZ)$/i, '');
  const code = `${prefix}${bare}`;
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/MainTargetAjax/Get?code=${code}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; rockstock/1.0)',
        Referer: `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code=${code}`,
      },
    });
    if (!res.ok) return null;
    const txt = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(txt);
    } catch {
      return null;
    }
    // 兩種可能格式：陣列 / 包在 data
    let arr: RawRow[] = [];
    if (Array.isArray(parsed)) {
      arr = parsed as RawRow[];
    } else if (parsed && typeof parsed === 'object') {
      const w = parsed as { data?: unknown };
      if (Array.isArray(w.data)) arr = w.data as RawRow[];
    }
    if (arr.length === 0) return null;

    const quarters: EastMoneyQuarterDetail[] = arr
      .filter((r) => r.REPORT_DATE)
      .map((r) => ({
        reportDate: String(r.REPORT_DATE),
        reportType: String(r.REPORT_TYPE ?? ''),
        eps: n(r.EPSJB),
        bookValuePerShare: n(r.BPS),
        roe: n(r.ROEJQ),
        revenue: n(r.OPERATEINCOME),
        revenueYoY: n(r.OPERATEINCOME_YOY),
        parentNetProfit: n(r.PARENTNETPROFIT),
        parentNetProfitYoY: n(r.PARENTNETPROFIT_YOY),
        deductedNetProfit: n(r.KFJLR),
        deductedNetProfitYoY: n(r.KFJLR_YOY),
        grossMargin: n(r.XSMLL),
        netMargin: n(r.SJL),
      }))
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate)); // 近到遠

    const result: EastMoneyFinancialDetail = {
      code: bare,
      quarters,
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
    };

    globalCache.set(cacheKey, result, DETAIL_TTL);
    return result;
  } catch {
    return null;
  }
}

/**
 * 計算「扣非淨利佔歸母淨利」比例
 * 用最新一季資料，若 KFJLR 為 null 或 PARENTNETPROFIT 為 0/null → 回 null
 */
export function deductedNetProfitRatio(detail: EastMoneyFinancialDetail | null): number | null {
  if (!detail || detail.quarters.length === 0) return null;
  const q = detail.quarters[0];
  if (q.parentNetProfit == null || q.parentNetProfit === 0) return null;
  if (q.deductedNetProfit == null) return null;
  return q.deductedNetProfit / q.parentNetProfit;
}

/**
 * 取最新季度的核心數值 — pipeline 用
 */
export function latestQuarter(detail: EastMoneyFinancialDetail | null): EastMoneyQuarterDetail | null {
  if (!detail || detail.quarters.length === 0) return null;
  return detail.quarters[0];
}
