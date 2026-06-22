/**
 * 陸股板塊「歷史」漲幅 + 主力淨流入（東財，2026-06-20）
 *
 * 板塊在東財是一個指數（secid = 90.BKxxxx），有完整日K + 資金流歷史，所以 5/10/20 日漲幅、
 * 主力 N 日累計都拿得到——但我們每天存的板塊快照只回到功能上線日（板塊卡 10/20 日因此空白）。
 * 本模組直接抓板塊歷史 K 線回補；走 fetchJsonWithCurlFallback（含 curl/代理 fallback）扛 push2 時段性 TLS reset。
 *
 * 純顯示層，不參與選股（鐵則 #5）。
 */
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

interface KlineResp { data?: { klines?: string[] } | null }

const REFERER = 'https://quote.eastmoney.com/';

/** 板塊日K → [{date, pct(漲跌幅%)}]（升冪；抓不到 throw 讓 caller 重試）。f59=漲跌幅。 */
export async function fetchBoardKline(code: string, lmt = 30): Promise<{ date: string; pct: number }[]> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get`
    + `?secid=90.${code}&klt=101&fqt=1&lmt=${lmt}&fields1=f1&fields2=f51,f59`;
  const r = await fetchJsonWithCurlFallback<KlineResp>(url, { timeoutMs: 12000, headers: { Referer: REFERER } });
  const klines = r.data?.data?.klines ?? [];
  return klines.map((line) => { const p = line.split(','); return { date: p[0], pct: parseFloat(p[1]) || 0 }; });
}

/** 板塊資金流日K → [{date, mainNet(主力淨流入元)}]（升冪）。f52=主力淨流入。 */
export async function fetchBoardFlow(code: string, lmt = 30): Promise<{ date: string; mainNet: number }[]> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get`
    + `?secid=90.${code}&klt=101&lmt=${lmt}&fields1=f1&fields2=f51,f52`;
  const r = await fetchJsonWithCurlFallback<KlineResp>(url, { timeoutMs: 12000, headers: { Referer: REFERER } });
  const klines = r.data?.data?.klines ?? [];
  return klines.map((line) => { const p = line.split(','); return { date: p[0], mainNet: parseFloat(p[1]) || 0 }; });
}
