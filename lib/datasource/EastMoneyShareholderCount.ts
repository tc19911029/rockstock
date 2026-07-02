/**
 * EastMoney CN 籌碼面 Provider — 股东户数（對標台股「集保/股權分散」散戶集中度）
 *
 * 端點：https://datacenter-web.eastmoney.com/api/data/v1/get
 *   reportName=RPT_HOLDERNUM_DET（逐期股东户数明细，季度頻率）
 *   filter=(SECURITY_CODE="600519")  sortColumns=END_DATE sortTypes=-1（新→舊）
 *
 * 解讀（台股術語對照見記憶 tw_cn_terminology）：
 *   - HOLDER_NUM 股东户数 ↓（HOLDER_NUM_RATIO 為負）= 籌碼集中 = 大户/主力進場 → 偏多
 *   - 股东户数 ↑ = 籌碼分散 = 散戶湧入/大户出貨 → 偏空
 *   - AVG_HOLD_NUM 户均持股、AVG_MARKET_CAP 户均市值 越高 = 大户主導
 *
 * 注意：股东户数為季報/定期揭露（非每日），多數股票一年 4~8 個資料點。
 */

import { fetchEmDatacenter } from './eastMoneyDatacenter';

const COLUMNS = [
  'SECURITY_CODE', 'END_DATE', 'HOLDER_NUM', 'PRE_HOLDER_NUM',
  'HOLDER_NUM_CHANGE', 'HOLDER_NUM_RATIO', 'AVG_HOLD_NUM', 'AVG_MARKET_CAP',
  'CLOSE_PRICE', 'HOLD_NOTICE_DATE',
].join(',');

export interface ShareholderCountQuarter {
  endDate: string;          // 報告期 YYYY-MM-DD
  holderNum: number;        // 股东户数
  prevHolderNum: number | null;
  holderNumChange: number | null;   // 較上期戶數變化（戶）
  holderNumRatio: number | null;    // 較上期戶數變化 %（負=集中、正=分散）
  avgHoldNum: number | null;        // 户均持股（股）
  avgMarketCap: number | null;      // 户均市值（元）
  closePrice: number | null;        // 報告期收盤
  noticeDate: string | null;        // 揭露日
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const ymd = (v: unknown): string => String(v ?? '').slice(0, 10);

/**
 * 抓 CN 個股近 N 期股东户数（新→舊）。快取/重試/限流防護見 eastMoneyDatacenter。
 * @param code 6 位數代碼（無後綴）
 * @param limit 期數（預設 8 季）
 */
export async function fetchShareholderCount(code: string, limit = 8): Promise<ShareholderCountQuarter[]> {
  const rows = await fetchEmDatacenter({
    reportName: 'RPT_HOLDERNUM_DET', columns: COLUMNS, filterField: 'SECURITY_CODE', code,
    sortColumns: 'END_DATE', pageSize: limit, cacheKey: `emGdhs:${code}:${limit}`, ttlMs: 6 * 60 * 60 * 1000,
  });
  return rows.map((r) => ({
    endDate: ymd(r.END_DATE),
    holderNum: num(r.HOLDER_NUM) ?? 0,
    prevHolderNum: num(r.PRE_HOLDER_NUM),
    holderNumChange: num(r.HOLDER_NUM_CHANGE),
    holderNumRatio: num(r.HOLDER_NUM_RATIO),
    avgHoldNum: num(r.AVG_HOLD_NUM),
    avgMarketCap: num(r.AVG_MARKET_CAP),
    closePrice: num(r.CLOSE_PRICE),
    noticeDate: r.HOLD_NOTICE_DATE ? ymd(r.HOLD_NOTICE_DATE) : null,
  }));
}
