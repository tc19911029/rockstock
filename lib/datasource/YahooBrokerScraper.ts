/**
 * Yahoo 籌碼分頁 — 主力券商分點 scraper
 *
 * Source: https://tw.stock.yahoo.com/quote/{code}/broker-trading
 *
 * 該頁是 SPA，但 initial state 整包 JSON 嵌在 HTML 內。
 * 我們從 HTML 中抓 `brokerTrades":{"data":{...}}` 部分解析。
 *
 * 對齊籌碼K線 app 的「主力 -102 / 主力集中 -4.00%」這兩個關鍵指標。
 *
 * 資料更新時間：每日盤後 17:00 後（券商分點要等 TWSE 公布）
 */

const CACHE = new Map<string, { data: YahooBrokerTrades; expiresAt: number }>();
const CACHE_TTL = 30 * 60_000;  // 30 分鐘 — 該資料一天只更新一次，但避免抓太頻繁

export interface BrokerRankRow {
  rank: number;
  /** 券商分點名稱 e.g. "美商高盛" / "凱基台北" */
  name: string;
  /** 買進張數 (K = 張) */
  buyVolK: number;
  /** 賣出張數 */
  sellVolK: number;
  /** 淨買賣 (買 - 賣) */
  netVolK: number;
}

export interface YahooBrokerTrades {
  /** 資料日 YYYY-MM-DD */
  date: string;
  /** 前 15 大買進券商 */
  buyerRankList: BrokerRankRow[];
  /** 前 15 大賣出券商 */
  sellerRankList: BrokerRankRow[];
  /** 主力買賣超（張）= 前 15 買 − 前 15 賣 — 對齊「主力 -102」*/
  totalDifferenceVolK: number;
  /** 前 15 大買進總量（張）*/
  totalOverbuyVolK: number;
  /** 前 15 大賣出總量（張）*/
  totalOversellVolK: number;
  /** 主力集中度（%，0-1 小數）— 對齊「主力集中 -4.00%」
   *  注意 Yahoo 的 tradeVolumeRate 是正值，跟籌碼K線符號邏輯不同；要看 totalDifferenceVolK 判定方向 */
  concentration: number;
}

/**
 * 抓單檔股票最新一日的主力券商資料。
 * @param code 純股票代號（去掉 .TW/.TWO）
 */
export async function fetchYahooBrokerTrades(code: string): Promise<YahooBrokerTrades | null> {
  const cacheKey = code;
  const cached = CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(code)}.TW/broker-trading`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const parsed = extractBrokerTrades(html);
    if (!parsed) return null;
    CACHE.set(cacheKey, { data: parsed, expiresAt: Date.now() + CACHE_TTL });
    return parsed;
  } catch {
    return null;
  }
}

/** 從 Yahoo HTML 解出 brokerTrades 區塊 */
function extractBrokerTrades(html: string): YahooBrokerTrades | null {
  // HTML 中嵌入 JSON 片段：`"brokerTrades":{"data":{ ... }}`
  // 用 brace counter 找 balanced JSON
  const marker = '"brokerTrades":';
  const startIdx = html.indexOf(marker);
  if (startIdx < 0) return null;

  const dataStart = html.indexOf('{', startIdx + marker.length);
  if (dataStart < 0) return null;

  // 找配對的 closing brace
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = dataStart; i < html.length; i++) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx < 0) return null;

  try {
    const block = JSON.parse(html.slice(dataStart, endIdx + 1));
    const data = block.data;
    if (!data || !Array.isArray(data.buyerRankList)) return null;

    const toRow = (r: Record<string, unknown>): BrokerRankRow => {
      const buy = Number(r.buyVolK) || 0;
      const sell = Number(r.sellVolK) || 0;
      return {
        rank: Number(r.rank) || 0,
        name: String(r.name ?? ''),
        buyVolK: buy,
        sellVolK: sell,
        netVolK: buy - sell,
      };
    };

    return {
      date: typeof data.date === 'string' ? data.date.slice(0, 10) : '',
      buyerRankList: data.buyerRankList.map(toRow),
      sellerRankList: (data.sellerRankList ?? []).map(toRow),
      totalDifferenceVolK: Number(data.totalDifferenceVolK) || 0,
      totalOverbuyVolK: Number(data.totalOverbuyVolK) || 0,
      totalOversellVolK: Number(data.totalOversellVolK) || 0,
      concentration: Number(data.tradeVolumeRate) || 0,
    };
  } catch {
    return null;
  }
}
