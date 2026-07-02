/**
 * 陸股個股「兩融」（融資融券）餘額歷史 — 2026-06-20
 *
 * 來源：EastMoney datacenter `RPTA_WEB_RZRQ_GGMX`（個股融資融券明細，datacenter host
 * 支援任意歷史日期，與 push2ex 8 日窗不同）。欄位：
 *   RZYE   = 融資餘額（元）
 *   RQYE   = 融券餘額（元）
 *   RZRQYE = 融資融券餘額（兩融合計，元）
 *
 * 「兩融」當欄位顯示時用 RZRQYE 的「期間變化」= 今日餘額 − N 日前餘額（正=兩融加碼/紅、負=減/綠），
 * 對齊台股「融資」那排（也是餘額淨變化金額）。純顯示層，不參與選股（鐵則 #5）。
 */

export interface CnMarginDay {
  /** YYYY-MM-DD */
  date: string;
  /** 融資融券餘額（元） */
  rzrqYe: number;
  /** 融資餘額（元，做多槓桿） */
  rzYe: number;
  /** 融券餘額（元，做空；缺值 null） */
  rqYe: number | null;
}

interface GgmxRow {
  DATE?: string;
  RZYE?: number | null;
  RQYE?: number | null;
  RZRQYE?: number | null;
}
interface GgmxResp {
  result?: { data?: GgmxRow[] | null } | null;
}

/**
 * 抓單股近 N 筆兩融餘額（datacenter，回傳「升冪」by date；抓不到回 []）。
 * @param code 純代號（如 300285，不帶 .SS/.SZ）
 */
export async function fetchCnMarginHistory(code: string, pageSize = 60): Promise<CnMarginDay[]> {
  const bare = code.replace(/\.(SS|SZ|SH)$/i, '');
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
    + '?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&source=WEB'
    + `&pageSize=${pageSize}&pageNumber=1`
    + `&filter=(SCODE=%22${bare}%22)&sortColumns=DATE&sortTypes=-1`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' },
    });
    if (!res.ok) return [];
    const json = await res.json() as GgmxResp;
    const rows = json.result?.data ?? [];
    const out: CnMarginDay[] = [];
    for (const r of rows) {
      if (!r.DATE) continue;
      const rzrq = typeof r.RZRQYE === 'number' ? r.RZRQYE : null;
      const rz = typeof r.RZYE === 'number' ? r.RZYE : null;
      const rq = typeof r.RQYE === 'number' ? r.RQYE : null;
      if (rzrq == null) continue;
      out.push({ date: r.DATE.slice(0, 10), rzrqYe: rzrq, rzYe: rz ?? rzrq, rqYe: rq });
    }
    // datacenter 回傳降冪（新→舊）→ 轉升冪方便對齊
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  } catch {
    return [];
  }
}
