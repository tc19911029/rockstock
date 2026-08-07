// ============================================================
// 抓單檔陸股即時報價 — 還原手機 App 頂部報價列。
// 主源騰訊 qt.gtimg.cn（欄位最全、與既有 CN K 線同源），EastMoney 在部分環境連不上。
// 數值欄位是純 ASCII，GBK 編碼的股名用不到 → 直接 text() 切 '~' 取數字 index 即可。
// 非交易時段或抓不到 → 回 null，前端退回本地 K 的開高低收。
// ============================================================

import type { Candle } from '@/types';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export interface SanSeQuote {
  /** 報價所屬交易日（YYYY-MM-DD）；休市日不可冒充成今天。 */
  date?: string;
  price: number;        // 現價
  prevClose: number;    // 昨收
  open: number;         // 今開
  high: number;         // 最高
  low: number;          // 最低
  change: number;       // 漲跌額
  changePct: number;    // 漲跌幅 %
  amplitude: number;    // 振幅 %
  volumeLots: number;   // 成交量（手）
  amount: number;       // 成交額（元）
  volumeRatio: number;  // 量比
  turnover: number;     // 換手率 %
  peTTM: number;        // 市盈率(動)
  totalCap: number;     // 總市值（元）
  floatCap: number;     // 流通市值（元）
}

/** symbol 如 603986.SS / 000001.SZ → 騰訊 code（sh/sz 前綴） */
function toTencentCode(symbol: string): string | null {
  const [code, suf] = symbol.split('.');
  if (!/^\d{6}$/.test(code)) return null;
  if (suf === 'SS') return `sh${code}`;
  if (suf === 'SZ') return `sz${code}`;
  return null;
}

const num = (v: string | undefined): number => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : NaN;
};

export async function fetchQuote(symbol: string): Promise<SanSeQuote | null> {
  const tc = toTencentCode(symbol);
  if (!tc) return null;

  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${tc}`, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.text();
    // v_sh603986="1~名~代碼~現價~昨收~今開~量(手)~...~漲跌(31)~漲跌%(32)~高(33)~低(34)~...
    const m = body.match(/="([^"]*)"/);
    if (!m) return null;
    const p = m[1].split('~');
    if (p.length < 53) return null;
    const price = num(p[3]);
    if (!(price > 0)) return null; // 停牌/無報價

    return {
      date: /^\d{8}/.test(p[30] ?? '')
        ? `${p[30].slice(0, 4)}-${p[30].slice(4, 6)}-${p[30].slice(6, 8)}`
        : undefined,
      price,
      prevClose: num(p[4]),
      open: num(p[5]),
      high: num(p[33]),
      low: num(p[34]),
      change: num(p[31]),
      changePct: num(p[32]),
      amplitude: num(p[43]),
      volumeLots: num(p[6]),
      amount: num(p[37]) * 1e4,   // 成交額：萬元 → 元
      volumeRatio: num(p[49]),    // 量比
      turnover: num(p[38]),       // 換手率 %
      peTTM: num(p[52]),          // 市盈率(動)
      totalCap: num(p[45]) * 1e8, // 總市值：億 → 元
      floatCap: num(p[44]) * 1e8, // 流通市值：億 → 元
    };
  } catch {
    return null;
  }
}

/**
 * 用即時報價組「今日」K 棒，並把量對齊歷史 K 線單位。
 *
 * 非掃描宇宙的創業板/科創股不在 L1 也不在 L2 快照 → 歷史只到昨日封存。盤中/盤後用此 helper
 * 從即時報價補今日那根，讓走圖（主圖 K + 三色）延伸到今日。
 *
 * 量單位：repo 歷史基準是「股」（Tencent/Baidu/EastMoney provider 與 L1 store 皆股），但
 * quote.volumeLots 是「手」→ 用歷史近窗中位數量級比對校正（>30× 才縮放），避免最後一根造成
 * 單位斷層污染 midControl。報價無效（盤前 open=0 等）→ 回 null，呼叫端退回封存。
 *
 * @param quote    fetchQuote() 的結果
 * @param histTail 歷史最近數根（判斷量單位量級用；傳近 20 根即可）
 * @param todayDate 今日日期字串（YYYY-MM-DD，呼叫端依市場時區算）
 */
export function buildTodayBarFromQuote(
  quote: SanSeQuote | null,
  histTail: Candle[],
  todayDate: string,
): Candle | null {
  if (!quote || !(quote.price > 0) || !(quote.open > 0) || !(quote.high > 0) || !(quote.low > 0)) return null;
  let vol = quote.volumeLots;
  const recent = histTail.map((c) => c.volume).filter((v) => v > 0).sort((a, b) => a - b);
  if (recent.length >= 5 && vol > 0) {
    const med = recent[Math.floor(recent.length / 2)];
    if (med / vol > 30) vol *= 100;      // 歷史是「股」、報價是「手」→ ×100 對齊
    else if (vol / med > 30) vol /= 100; // 反向保險
  }
  return { date: todayDate, open: quote.open, high: quote.high, low: quote.low, close: quote.price, volume: vol };
}
