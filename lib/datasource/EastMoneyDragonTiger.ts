/**
 * EastMoney CN 籌碼面 Provider — 龙虎榜（陸股獨有，台股無對應；對標「分點主力進出」的最高強度版）
 *
 * 龙虎榜 = 當日異動股（漲跌幅/換手/振幅偏離達標）的券商營業部買賣明細。
 * 個股上榜 = 該日有強力買賣盤介入，淨額正/負 = 主力淨買/淨賣。
 *
 * 端點：https://datacenter-web.eastmoney.com/api/data/v1/get
 *   reportName=RPT_DAILYBILLBOARD_DETAILSNEW
 *   filter=(SECURITY_CODE="002251")  sortColumns=TRADE_DATE sortTypes=-1
 *
 * 解讀：BILLBOARD_NET_AMT 淨額 > 0（買 > 賣）= 主力淨買進、偏多；
 *   D1/D5/D10_CLOSE_ADJCHRATE = 上榜後 1/5/10 日漲跌幅（驗證上榜後的真實表現）。
 */

import { fetchEmDatacenter } from './eastMoneyDatacenter';

const COLUMNS = [
  'SECURITY_CODE', 'SECURITY_NAME_ABBR', 'TRADE_DATE', 'CLOSE_PRICE', 'CHANGE_RATE', 'TURNOVERRATE',
  'EXPLANATION', 'BILLBOARD_NET_AMT', 'BILLBOARD_BUY_AMT', 'BILLBOARD_SELL_AMT',
  'BUY_SEAT', 'SELL_SEAT', 'D1_CLOSE_ADJCHRATE', 'D5_CLOSE_ADJCHRATE', 'D10_CLOSE_ADJCHRATE',
].join(',');

export interface DragonTigerDay {
  tradeDate: string;        // YYYY-MM-DD
  name: string;
  closePrice: number | null;
  changeRate: number | null;     // 當日漲跌幅 %
  turnoverRate: number | null;   // 換手率 %
  reason: string;                // 上榜原因
  netAmt: number | null;         // 龙虎榜淨額（元，>0=主力淨買）
  buyAmt: number | null;         // 龙虎榜買入額（元）
  sellAmt: number | null;        // 龙虎榜賣出額（元）
  buySeat: number | null;        // 買方席位數
  sellSeat: number | null;       // 賣方席位數
  fwdD1: number | null;          // 上榜後 1 日漲跌幅 %
  fwdD5: number | null;          // 上榜後 5 日
  fwdD10: number | null;         // 上榜後 10 日
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const ymd = (v: unknown): string => String(v ?? '').slice(0, 10);

/**
 * 抓 CN 個股近 N 次龙虎榜（新→舊）；沒上榜過則回空陣列。快取/重試/限流防護見 eastMoneyDatacenter。
 * @param code 6 位數代碼（無後綴）
 * @param limit 筆數（預設 10）
 */
export async function fetchDragonTiger(code: string, limit = 10): Promise<DragonTigerDay[]> {
  const rows = await fetchEmDatacenter({
    reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW', columns: COLUMNS, filterField: 'SECURITY_CODE', code,
    sortColumns: 'TRADE_DATE', pageSize: limit, cacheKey: `emLhb:${code}:${limit}`, ttlMs: 60 * 60 * 1000,
  });
  return rows.map((r) => ({
    tradeDate: ymd(r.TRADE_DATE),
    name: String(r.SECURITY_NAME_ABBR ?? ''),
    closePrice: num(r.CLOSE_PRICE),
    changeRate: num(r.CHANGE_RATE),
    turnoverRate: num(r.TURNOVERRATE),
    reason: String(r.EXPLANATION ?? ''),
    netAmt: num(r.BILLBOARD_NET_AMT),
    buyAmt: num(r.BILLBOARD_BUY_AMT),
    sellAmt: num(r.BILLBOARD_SELL_AMT),
    buySeat: num(r.BUY_SEAT),
    sellSeat: num(r.SELL_SEAT),
    fwdD1: num(r.D1_CLOSE_ADJCHRATE),
    fwdD5: num(r.D5_CLOSE_ADJCHRATE),
    fwdD10: num(r.D10_CLOSE_ADJCHRATE),
  }));
}
