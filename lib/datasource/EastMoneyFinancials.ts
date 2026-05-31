/**
 * EastMoney CN 基本面 Provider — 財報歷史（業績報表，逐季）。對標台股「財報狗逐季 EPS/營收/毛利」。
 *
 * 補既有 EastMoneyFundamentals（只有當下估值 PE/PB/淨利/淨資產）缺的「逐季財報趨勢」。
 *
 * 端點：https://datacenter-web.eastmoney.com/api/data/v1/get
 *   reportName=RPT_LICO_FN_CPD（業績報表，季度頻率）
 *   欄位用拼音縮寫：YSTZ=营收同比、SJLTZ=净利同比、XSMLL=销售毛利率、BPS=每股净资产
 *
 * 台陸名稱對照（見記憶 tw_cn_terminology）：
 *   营业收入=營收｜归母净利润=稅後淨利｜每股收益=EPS｜加权ROE=股東權益報酬率｜
 *   销售毛利率=毛利率｜每股净资产=每股淨值｜同比=年增率(YoY)
 */

import { fetchEmDatacenter } from './eastMoneyDatacenter';

const COLUMNS = [
  'SECURITY_CODE', 'REPORTDATE', 'NOTICE_DATE', 'TOTAL_OPERATE_INCOME', 'YSTZ',
  'PARENT_NETPROFIT', 'SJLTZ', 'WEIGHTAVG_ROE', 'BASIC_EPS', 'BPS', 'XSMLL', 'MGJYXJJE',
].join(',');

export interface FinancialQuarter {
  reportDate: string;        // 報告期 YYYY-MM-DD
  noticeDate: string | null; // 公告日
  revenue: number | null;    // 营业收入（元）
  revenueYoY: number | null; // 营收同比 %（年增率）
  netProfit: number | null;  // 归母净利润（元）
  netProfitYoY: number | null; // 净利同比 %
  roe: number | null;        // 加权ROE %
  eps: number | null;        // 每股收益
  bps: number | null;        // 每股净资产
  grossMargin: number | null; // 销售毛利率 %
  opCashPerShare: number | null; // 每股经营现金流
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const ymd = (v: unknown): string => String(v ?? '').slice(0, 10);

/**
 * 抓 CN 個股近 N 季財報（新→舊）。快取/重試/限流防護見 eastMoneyDatacenter。
 * @param code 6 位數代碼（無後綴）
 * @param limit 季數（預設 12 = 3 年）
 */
export async function fetchCnFinancials(code: string, limit = 12): Promise<FinancialQuarter[]> {
  const rows = await fetchEmDatacenter({
    reportName: 'RPT_LICO_FN_CPD', columns: COLUMNS, filterField: 'SECURITY_CODE', code,
    sortColumns: 'REPORTDATE', pageSize: limit, cacheKey: `emFin:${code}:${limit}`, ttlMs: 6 * 60 * 60 * 1000,
  });
  return rows.map((r) => ({
    reportDate: ymd(r.REPORTDATE),
    noticeDate: r.NOTICE_DATE ? ymd(r.NOTICE_DATE) : null,
    revenue: num(r.TOTAL_OPERATE_INCOME),
    revenueYoY: num(r.YSTZ),
    netProfit: num(r.PARENT_NETPROFIT),
    netProfitYoY: num(r.SJLTZ),
    roe: num(r.WEIGHTAVG_ROE),
    eps: num(r.BASIC_EPS),
    bps: num(r.BPS),
    grossMargin: num(r.XSMLL),
    opCashPerShare: num(r.MGJYXJJE),
  }));
}
