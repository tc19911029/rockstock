/**
 * EastMoney 主力資金流（CN A 股）
 *
 * API: https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get
 * 每個 secid 一個 call，一次可抓歷史 N 天日線資金流
 *
 * secid format:
 *   1.SHxxxxxx → 上海（6 開頭）
 *   0.SZxxxxxx → 深圳（0/3 開頭）
 *
 * 回傳 f51-f57：
 *   f51: 日期 YYYY-MM-DD
 *   f52: 主力淨流入（大單 + 超大單）
 *   f53: 小單
 *   f54: 中單
 *   f55: 大單
 *   f56: 超大單
 *   f57: 漲跌幅 %
 *
 * 用於 CN 版本「淘汰 #8 主力連續淨流出」（等同 TW 三大法人連續賣超）
 */

export interface CapitalFlowDay {
  date:    string;   // YYYY-MM-DD
  mainNet: number;   // 主力淨流入（大+超大單）
}

interface EMResponse {
  data?: {
    code?: string;
    klines?: string[];
  } | null;
}

/**
 * 把 .SS/.SZ 轉成 EastMoney secid 格式
 */
function toSecid(symbol: string): string {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  if (/\.SS$/i.test(symbol)) return `1.${code}`;  // 上海
  if (/\.SZ$/i.test(symbol)) return `0.${code}`;  // 深圳
  // fallback 猜：6 開頭 = 上海，其他 = 深圳
  return code.startsWith('6') ? `1.${code}` : `0.${code}`;
}

/**
 * 抓單股近 N 天資金流（日K）
 * @param symbol e.g. '600519.SS'
 * @param lmt 天數（預設 5）
 */
export async function fetchCapitalFlow(
  symbol: string,
  lmt: number = 5,
): Promise<CapitalFlowDay[]> {
  const secid = toSecid(symbol);
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get`
    + `?secid=${secid}&klt=101&lmt=${lmt}`
    + `&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer':    'https://quote.eastmoney.com/',
      },
    });
    if (!res.ok) return [];
    const json = await res.json() as EMResponse;
    const klines = json.data?.klines ?? [];
    return klines.map(line => {
      const parts = line.split(',');
      return {
        date:    parts[0],
        mainNet: parseFloat(parts[1]) || 0,  // f52 主力淨流入
      };
    });
  } catch {
    return [];
  }
}
