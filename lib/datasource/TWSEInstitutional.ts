/**
 * TWSE 三大法人買賣超資料源（T86 日報）
 *
 * API: https://www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALL&response=json
 *
 * 欄位結構：
 *   0: 證券代號    1: 證券名稱
 *   4: 外陸資買賣超股數（不含外資自營商）
 *   10: 投信買賣超股數
 *   11: 自營商買賣超股數（總計 = 自行買賣 + 避險）
 *   18: 三大法人買賣超股數（總計）
 *
 * 書本依據：Part 10 淘汰 #8「三大法人連續賣超」
 * 用於偵測主力出貨。
 */

export interface InstitutionalRecord {
  symbol:  string;           // 純數字，例如 '2330'
  name:    string;
  foreign: number;           // 外陸資淨買賣（股數，正=買超、負=賣超）
  trust:   number;           // 投信淨買賣
  dealer:  number;           // 自營商淨買賣（含自行買賣+避險）
  total:   number;           // 三大法人淨買賣總計
}

interface TWSEResponse {
  stat?:   string;
  date?:   string;
  fields?: string[];
  data?:   string[][];
}

function parseNetShares(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/**
 * 抓單日 TWSE 三大法人買賣超
 * @param date YYYY-MM-DD
 */
export async function fetchTWSEInstitutional(date: string): Promise<InstitutionalRecord[]> {
  const yyyymmdd = date.replace(/-/g, '');
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${yyyymmdd}&selectType=ALL&response=json`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; rockstock/2.0)' },
  });
  if (!res.ok) throw new Error(`TWSE T86 HTTP ${res.status} for ${date}`);

  const json = await res.json() as TWSEResponse;
  if (json.stat !== 'OK' || !json.data) {
    // 非交易日或資料未公布，回空
    return [];
  }

  const records: InstitutionalRecord[] = [];
  for (const row of json.data) {
    if (!row[0]) continue;
    const symbol = row[0].trim();
    const name   = (row[1] ?? '').trim();
    const foreign = parseNetShares(row[4] ?? '0');
    const trust   = parseNetShares(row[10] ?? '0');
    const dealer  = parseNetShares(row[11] ?? '0');
    const total   = parseNetShares(row[18] ?? '0');
    records.push({ symbol, name, foreign, trust, dealer, total });
  }
  return records;
}
