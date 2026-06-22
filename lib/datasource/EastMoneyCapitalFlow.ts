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
  date:     string;          // YYYY-MM-DD
  mainNet:  number;          // 主力淨流入（大+超大單）
  superNet: number | null;   // 超大單淨流入（主買資金 — 機構/大戶真實買賣，f56）
  largeNet: number | null;   // 大單淨流入（f55）
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
/** 轉 Sina daima 格式：'600519.SS' → 'sh600519'、'000001.SZ' → 'sz000001' */
function toSinaDaima(symbol: string): string {
  const code = symbol.replace(/\.(SS|SZ)$/i, '');
  if (/\.SS$/i.test(symbol)) return `sh${code}`;
  if (/\.SZ$/i.test(symbol)) return `sz${code}`;
  return code.startsWith('6') ? `sh${code}` : `sz${code}`;
}

interface SinaFlowRow {
  opendate?: string;
  r0_net?: string;    // 主力淨額（大+超大單）
  netamount?: string; // 綜合淨流入
}

/**
 * Sina fallback：`money.finance.sina.com.cn`
 * 回傳 JSON array，欄位 opendate / r0_net / netamount
 */
async function fetchCapitalFlowSina(
  symbol: string, lmt: number,
): Promise<CapitalFlowDay[]> {
  const daima = toSinaDaima(symbol);
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs`
    + `?page=1&num=${lmt}&sort=opendate&asc=0&daima=${daima}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer':    'https://vip.stock.finance.sina.com.cn/',
    },
  });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim().startsWith('[')) return [];
  const rows = JSON.parse(text) as SinaFlowRow[];
  return rows.map(r => ({
    date:     (r.opendate ?? '').slice(0, 10),
    mainNet:  parseFloat(r.r0_net ?? '0') || 0,
    superNet: null,   // Sina 只給主力綜合，無超大單/大單拆分
    largeNet: null,
  })).filter(r => r.date);
}

/**
 * EastMoney primary
 */
// ⚠️ 必須用 http://（非 https）：push2his 的 HTTPS 在本機（中國線路）會 TLS reset → curl 000、
// Node fetch ECONNRESET（見記憶 direct_tls_reset_proxy_env_illusion）；HTTP 同 endpoint 秒回 200。
// 壞時段主站全滅 → 走 host failover（鏡像同結構），仿 emBoards。
const FFLOW_HOSTS = ['push2his.eastmoney.com', 'push2delay.eastmoney.com', '1.push2his.eastmoney.com'];

async function fetchCapitalFlowEM(
  symbol: string, lmt: number,
): Promise<CapitalFlowDay[]> {
  const secid = toSecid(symbol);
  const qs = `?secid=${secid}&klt=101&lmt=${lmt}`
    + `&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57`;
  for (const host of FFLOW_HOSTS) {
    try {
      const res = await fetch(`http://${host}/api/qt/stock/fflow/daykline/get${qs}`, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://quote.eastmoney.com/' },
      });
      if (!res.ok) continue;
      const json = await res.json() as EMResponse;
      const klines = json.data?.klines ?? [];
      if (klines.length === 0) continue;
      // f51,f52,f53,f54,f55,f56,f57 = 日期,主力淨,小單,中單,大單,超大單,漲跌幅
      return klines.map(line => {
        const p = line.split(',');
        return {
          date:     p[0],
          mainNet:  parseFloat(p[1]) || 0,
          largeNet: p[4] != null ? (parseFloat(p[4]) || 0) : null,
          superNet: p[5] != null ? (parseFloat(p[5]) || 0) : null,
        };
      });
    } catch { /* 下一個 host */ }
  }
  return [];
}

// 盤中即時：fflow 分鐘線（klt=1, lmt=0 = 今日全日逐分鐘），最後一筆 = 當下今日累計。
// daykline 會延遲 1~2 日、不含今日盤中；分鐘端點才是真正盤中即時值。同樣用 http 避 TLS reset。
const FFLOW_RT_HOSTS = ['push2.eastmoney.com', '1.push2.eastmoney.com', 'push2delay.eastmoney.com'];

/**
 * 今日盤中即時累計資金流（分鐘線最後一筆）。
 * 收盤後 = 今日最終累計；非交易時段 = 最後交易日。抓不到回 null（caller 退回 daykline）。
 */
export async function fetchTodayCapitalFlow(symbol: string): Promise<CapitalFlowDay | null> {
  const secid = toSecid(symbol);
  const qs = `?lmt=0&klt=1&secid=${secid}&fields1=f1&fields2=f51,f52,f53,f54,f55,f56`;
  for (const host of FFLOW_RT_HOSTS) {
    try {
      const res = await fetch(`http://${host}/api/qt/stock/fflow/kline/get${qs}`, {
        signal: AbortSignal.timeout(6_000),
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://quote.eastmoney.com/' },
      });
      if (!res.ok) continue;
      const json = await res.json() as EMResponse;
      const klines = json.data?.klines ?? [];
      if (klines.length === 0) continue;
      // f51,f52,f53,f54,f55,f56 = 時間,主力淨,小單,中單,大單,超大單
      const p = klines[klines.length - 1].split(',');
      return {
        date:     (p[0] ?? '').slice(0, 10),
        mainNet:  parseFloat(p[1]) || 0,
        largeNet: p[4] != null ? (parseFloat(p[4]) || 0) : null,
        superNet: p[5] != null ? (parseFloat(p[5]) || 0) : null,
      };
    } catch { /* 下一個 host */ }
  }
  return null;
}

/** 今日主買/主賣毛額（主力流入/流出，非淨額）— 回答「主買資金」 */
export interface MainBuySell {
  mainIn:  number;        // 主力流入（主買，毛額）f135
  mainOut: number;        // 主力流出（主賣，毛額）f136
  mainNet: number;        // 主力淨額 f137（= mainIn − mainOut）
  netPct:  number | null; // 主力淨佔比 % f184
}

/**
 * 今日盤中主力「買/賣」毛額（push2 即時 quote f135/f136/f137/f184）。
 * 「主買資金」= 主力流入毛額（買盤實際投入），跟「主力淨流入」（買−賣）不同。
 * 同 http + host failover。抓不到回 null。
 */
export async function fetchTodayMainBuySell(symbol: string): Promise<MainBuySell | null> {
  const secid = toSecid(symbol);
  const qs = `?secid=${secid}&fields=f135,f136,f137,f184`;
  for (const host of FFLOW_RT_HOSTS) {
    try {
      const res = await fetch(`http://${host}/api/qt/stock/get${qs}`, {
        signal: AbortSignal.timeout(6_000),
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'http://quote.eastmoney.com/' },
      });
      if (!res.ok) continue;
      const json = await res.json() as { data?: Record<string, number | null> | null };
      const d = json.data;
      if (!d || d.f135 == null || d.f136 == null) continue;
      return {
        mainIn:  Number(d.f135) || 0,
        mainOut: Number(d.f136) || 0,
        mainNet: Number(d.f137) || 0,
        netPct:  d.f184 != null ? Number(d.f184) : null,
      };
    } catch { /* 下一個 host */ }
  }
  return null;
}

/**
 * 抓單股近 N 天資金流（日K）
 * 優先 EastMoney，失敗或空時 fallback Sina
 */
export async function fetchCapitalFlow(
  symbol: string,
  lmt: number = 5,
): Promise<CapitalFlowDay[]> {
  try {
    const em = await fetchCapitalFlowEM(symbol, lmt);
    if (em.length > 0) return em;
  } catch { /* fallthrough */ }
  try {
    return await fetchCapitalFlowSina(symbol, lmt);
  } catch {
    return [];
  }
}
