// ============================================================
// 抓單檔陸股的「成交額 / 成交量 / 換手率」（東方財富 push2his）
// 用於捕撈季節副圖的 4 級量能彩柱（X_10 偏離成本 + X_11 換手率）。
// 本地 K 線只存 OHLCV，這些欄位現抓現用。
// ============================================================

export interface DayExtras { amount: number; vol: number; turnover: number }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/** symbol 如 603986.SS / 000001.SZ → 東方財富 secid（1.=滬, 0.=深） */
function toSecid(symbol: string): string | null {
  const [code, suf] = symbol.split('.');
  if (!/^\d{6}$/.test(code)) return null;
  if (suf === 'SS') return `1.${code}`;
  if (suf === 'SZ') return `0.${code}`;
  return null;
}

/** 回傳 date → { amount(元), vol(手), turnover(%) } */
export async function fetchDayExtras(symbol: string): Promise<Map<string, DayExtras>> {
  const map = new Map<string, DayExtras>();
  const secid = toSecid(symbol);
  if (!secid) return map;

  // fields2: f51日期 f52開 f53收 f54高 f55低 f56量 f57額 f58振幅 f59漲跌% f60漲跌額 f61換手%
  // fqt=1 前復權，與本地 K 線日期/區間對齊（amount/turnover 本身不受復權影響）
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&beg=20240101&end=20500101`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return map;
    const json = (await res.json()) as { data?: { klines?: string[] } };
    for (const k of json.data?.klines ?? []) {
      const p = k.split(',');
      map.set(p[0], { amount: parseFloat(p[6]), vol: parseFloat(p[5]), turnover: parseFloat(p[10]) });
    }
  } catch {
    /* 抓不到就回空 map，副圖少那排彩柱、其餘照常 */
  }
  return map;
}
