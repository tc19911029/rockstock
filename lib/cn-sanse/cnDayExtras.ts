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

import type { Candle } from '@/types';
import { TENCENT_FQKLINE_BASES } from '@/lib/datasource/tencentKlineHosts';

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

// 騰訊 qfq 日K endpoint host 走 tencentKlineHosts（鏡像 proxy.finance.qq.com 優先、舊網域 fallback；
// 舊網域 web.ifzq.gtimg.cn 對 CN 代號自 2026-06 被 WAF 封回 501）。640 根 ≈ 2.6 年（騰訊文件上限）。
async function fetchKlineRes(tc: string): Promise<Response> {
  let lastErr: unknown;
  for (const host of TENCENT_FQKLINE_BASES) {
    try {
      const res = await fetch(`${host}?param=${tc},day,,,640,qfq`, {
        headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) return res; // 501/WAF → 試下一個 host
      lastErr = new Error(`kline ${host} HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('kline all hosts failed');
}

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

/**
 * 回傳 date → { amount(元), vol(手), turnover(%) }。
 * 騰訊 fqkline 只回最近 ~640 根（約 2.6 年）→ 走圖深度回放會超出窗口。
 * 傳入 localCandles（本地 L1 全段，最早可達 ~5 年）時，用「校準後的本地 volume」補騰訊窗口之外的更舊日期，
 * 讓深度回放也有彩柱（見 extendWithLocal）。
 */
export async function fetchDayExtras(symbol: string, localCandles?: Candle[]): Promise<Map<string, DayExtras>> {
  const map = new Map<string, DayExtras>();
  const tc = toTencentCode(symbol);
  if (!tc) return map;

  let floatShares = NaN;
  try {
    const [klineRes, fs] = await Promise.all([
      fetchKlineRes(tc),
      fetchFloatShares(tc),
    ]);
    floatShares = fs;
    if (!klineRes.ok) return extendWithLocal(map, localCandles, floatShares);
    const json = (await klineRes.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
    const rows = json.data?.[tc]?.qfqday ?? json.data?.[tc]?.day ?? [];
    // 騰訊 fqkline 量單位板塊敏感：科創(688/689)回「股」、其餘回「手」→ 科創 ÷100 正規化成「手」
    const starDiv = /^sh68[89]/.test(tc) ? 100 : 1;
    for (const r of rows) {
      // [date, open, close, high, low, volume(手)]
      const date = r[0];
      const close = num(r[2]);
      const volLots = num(r[5]) / starDiv;
      if (!date || !Number.isFinite(volLots)) continue;
      const amount = Number.isFinite(close) ? close * volLots * 100 : NaN; // 元（近似：close×股數）
      const turnover = floatShares > 0 ? (volLots * 10000) / floatShares : NaN; // 換手率 %
      map.set(date, { amount, vol: volLots, turnover });
    }
  } catch {
    /* 抓不到就回空 map（或只剩本地延伸），副圖少那排彩柱、其餘照常 */
  }
  return extendWithLocal(map, localCandles, floatShares);
}

/**
 * 用本地 L1 volume 補騰訊 640 根窗口「之外」的更舊日期，讓走圖深度回放（>2.6 年）也有彩柱。
 * 自我校準：本地 volume 單位可能是「股」(=騰訊手×100) 或被污染成其他尺度 → 用重疊區的
 * 中位數比例 k = median(騰訊手 / 本地volume) 把本地 volume 換算成「騰訊手」等價；中位數對少數壞日(單位污染) robust。
 * 需 ≥30 個重疊點才敢外推；校準不出來就維持原樣（只少深度彩柱、不亂畫）。
 */
function extendWithLocal(
  map: Map<string, DayExtras>,
  localCandles: Candle[] | undefined,
  floatShares: number,
): Map<string, DayExtras> {
  if (!localCandles?.length || !(floatShares > 0) || map.size === 0) return map;
  let tencentEarliest = '9999-99-99';
  for (const d of map.keys()) if (d < tencentEarliest) tencentEarliest = d;
  const ratios: number[] = [];
  for (const c of localCandles) {
    const t = map.get(c.date);
    if (t && Number.isFinite(t.vol) && Number.isFinite(c.volume) && c.volume > 0) ratios.push(t.vol / c.volume);
  }
  if (ratios.length < 30) return map;
  ratios.sort((a, b) => a - b);
  const k = ratios[Math.floor(ratios.length / 2)]; // 中位數：本地volume → 騰訊手
  if (!(k > 0) || !Number.isFinite(k)) return map;
  for (const c of localCandles) {
    if (c.date < tencentEarliest && !map.has(c.date) && Number.isFinite(c.volume) && c.volume > 0) {
      const volLots = c.volume * k;
      const amount = Number.isFinite(c.close) ? c.close * volLots * 100 : NaN;
      const turnover = (volLots * 10000) / floatShares;
      map.set(c.date, { amount, vol: volLots, turnover });
    }
  }
  return map;
}

// ── 走圖回放用 per-symbol 快取 ───────────────────────────────────────────────
// turnover 歷史對「過去日期」不變、只有今日那筆會盤中變動。快取讓走圖步進歷史時不必每步重打騰訊
// （否則每步最多卡 4s）。10 分鐘 TTL：盤中今日換手率最多落後 10 分鐘，但彩柱是 4 級粗分桶、10 分鐘內極少改變分級，
// 與 server 其他 turnover 快取策略一致。只快取「成功（非空）」結果，避免把暫時性抓取失敗鎖住整個 TTL。
const _dayExtrasTtlMs = 10 * 60 * 1000;
const _dayExtrasCache = new Map<string, { data: Map<string, DayExtras>; ts: number }>();

export async function fetchDayExtrasCached(symbol: string, localCandles?: Candle[]): Promise<Map<string, DayExtras>> {
  const hit = _dayExtrasCache.get(symbol);
  if (hit && Date.now() - hit.ts < _dayExtrasTtlMs) return hit.data;
  const data = await fetchDayExtras(symbol, localCandles);
  if (data.size > 0) _dayExtrasCache.set(symbol, { data, ts: Date.now() });
  return data;
}
