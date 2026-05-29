// ============================================================
// 抓單檔陸股的「成交額 / 成交量 / 換手率」（歷史每日）
// 用於捕撈季節副圖的 4 級量能彩柱（X_10 偏離成本 + X_11 換手率）。
//
// 資料源：騰訊（EastMoney push2his 在本機常連不上 → 改騰訊，與 cnQuote 同源）
//   - 歷史 vol（手）：web.ifzq.gtimg.cn fqkline（qfq 日K，與本地 qfq K 線對齊）
//   - 流通股本：qt.gtimg.cn 即時報價（流通市值 ÷ 現價）
//   成交額無歷史端點 → 用 close×vol 近似（X9 平滑成本本就是 amount/vol≈均價，等價於量加權收盤）
//   換手率 = vol(手)×100 ÷ 流通股 ×100，用實測對齊騰訊即時換手率（誤差 < 0.01%）
// ============================================================

export interface DayExtras { amount: number; vol: number; turnover: number }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

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

/** 即時報價推流通股本（流通市值 ÷ 現價）；抓不到回 NaN */
async function fetchFloatShares(tc: string): Promise<number> {
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${tc}`, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return NaN;
    const m = (await res.text()).match(/="([^"]*)"/);
    if (!m) return NaN;
    const p = m[1].split('~');
    const price = num(p[3]);
    const floatCap = num(p[44]) * 1e8; // 流通市值：億 → 元
    if (!(price > 0) || !(floatCap > 0)) return NaN;
    return floatCap / price; // 流通股（股）
  } catch {
    return NaN;
  }
}

/** 回傳 date → { amount(元), vol(手), turnover(%) } */
export async function fetchDayExtras(symbol: string): Promise<Map<string, DayExtras>> {
  const map = new Map<string, DayExtras>();
  const tc = toTencentCode(symbol);
  if (!tc) return map;

  try {
    const [klineRes, floatShares] = await Promise.all([
      fetch(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},day,,,500,qfq`, {
        headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(12000),
      }),
      fetchFloatShares(tc),
    ]);
    if (!klineRes.ok) return map;
    const json = (await klineRes.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
    const rows = json.data?.[tc]?.qfqday ?? json.data?.[tc]?.day ?? [];
    for (const r of rows) {
      // [date, open, close, high, low, volume(手)]
      const date = r[0];
      const close = num(r[2]);
      const volLots = num(r[5]);
      if (!date || !Number.isFinite(volLots)) continue;
      const amount = Number.isFinite(close) ? close * volLots * 100 : NaN; // 元（近似：close×股數）
      const turnover = floatShares > 0 ? (volLots * 10000) / floatShares : NaN; // 換手率 %
      map.set(date, { amount, vol: volLots, turnover });
    }
  } catch {
    /* 抓不到就回空 map，副圖少那排彩柱、其餘照常 */
  }
  return map;
}
