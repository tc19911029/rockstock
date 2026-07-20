/**
 * 除權（股票股利）造成的「假融資增加」修正
 *
 * ── 問題 ──
 * 台股除權日，交易所會把融資／融券餘額按配股比例「膨脹」（因為配股後你手上的股數變多）。
 * 但檔案裡記的 marginNet 是「今日餘額 − 昨日餘額」的原始差，會把這段膨脹算成「有人加碼融資」。
 *
 * 實例（3081 聯亞，2026-07-15 除權，股票股利 1 元＝每千股配 100 股）：
 *   07-14 餘額 4468 張 → 除權調整基準 4468 × 1.1 = 4915 張
 *   07-15 實際餘額 4621 張
 *   檔案 marginNet = +153 張（看起來在加碼）
 *   真實變化 = 4621 − 4915 = −294 張（其實在減碼！）
 *
 * 因為除權日股價也同步變低，這筆假的「加碼」會被當成「在低價新建立的融資部位」，
 * 把融資成本估算往下拉。3081 實測：2033.61 → 2124.28。
 *
 * ── 修正 ──
 * 除權日的 marginNet 改成「今日餘額 − 昨日餘額 × (1 + 配股率)」。
 * 配股率 = 股票股利(元) / 10（面額 10 元；1 元股票股利 = 每股配 0.1 股）。
 *
 * 只影響「除權（發股票）」；純現金股息不改股數，marginNet 不失真，不需修正。
 */

import { getFinMindToken } from '@/lib/env';
import type { MarginDay } from '@/lib/squeeze/types';

export interface ExRightsEvent {
  /** 除權交易日 YYYY-MM-DD */
  date: string;
  /** 股票股利（元/股，面額 10 元） */
  stockDividend: number;
}

/** 配股率 → 餘額膨脹倍數（1 元股票股利 = ×1.1） */
export function exRightsMultiplier(stockDividend: number): number {
  return 1 + stockDividend / 10;
}

/**
 * 把除權日的 marginNet 換成「扣掉配股膨脹」後的真實淨變化。
 *
 * 純函式、不改動輸入陣列；沒有除權事件或找不到前一日時原樣回傳。
 */
export function adjustMarginNetForExRights(
  margin: MarginDay[],
  events: ExRightsEvent[],
): MarginDay[] {
  if (events.length === 0 || margin.length === 0) return margin;
  const byDate = new Map(events.filter(e => e.stockDividend > 0).map(e => [e.date, e]));
  if (byDate.size === 0) return margin;

  return margin.map((row, i) => {
    const ev = byDate.get(row.date);
    if (!ev || i === 0) return row;
    const prevBalance = margin[i - 1].marginBalance;
    if (!(prevBalance > 0)) return row;
    const baseline = prevBalance * exRightsMultiplier(ev.stockDividend);
    return { ...row, marginNet: Math.round(row.marginBalance - baseline) };
  });
}

// ── FinMind 除權息資料（帶記憶體快取，避免每次請求都打 API）─────────────────

interface FmDividendRow {
  date?: string;
  StockExDividendTradingDate?: string;
  StockEarningsDistribution?: number;
}

const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
/** code → 事件；TTL 1 天（除權息表一年只變幾次） */
const cache = new Map<string, { at: number; events: ExRightsEvent[] }>();
const TTL_MS = 24 * 60 * 60 * 1000;

function ymdPlusDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 抓某檔近期的「除權」事件（只回股票股利 > 0 的）。
 *
 * FinMind 缺 token 或失敗一律回 []（等於不修正），不讓成本估算整條掛掉。
 */
export async function fetchExRightsEvents(
  code: string,
  startDate: string,
  endDate: string,
): Promise<ExRightsEvent[]> {
  const key = `${code}:${startDate}:${endDate}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.events;

  // 走單一事實來源（會 strip 引號；記憶 env_token_quotes_bug）
  const token = getFinMindToken();
  if (!token) return [];

  try {
    // ⚠️ FinMind 的 start/end 是比對 `date`（股利分派基準日），那個日期通常「晚於」
    //    除權交易日（3081：除權 07-15、基準日 07-21）。若直接用 endDate 查，
    //    剛除權的那筆會被 FinMind 自己濾掉 → 抓到空陣列、修正失效。
    //    所以查詢範圍往後放寬 90 天，實際範圍在本地用 StockExDividendTradingDate 過濾。
    const queryEnd = ymdPlusDays(endDate, 90);
    const url = `${FINMIND_API}?dataset=TaiwanStockDividend&data_id=${encodeURIComponent(code)}`
      + `&start_date=${startDate}&end_date=${queryEnd}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = await res.json() as { status?: number; data?: FmDividendRow[] };
    if (json.status !== 200) return [];

    const events: ExRightsEvent[] = [];
    for (const r of json.data ?? []) {
      const d = r.StockExDividendTradingDate;
      const stock = r.StockEarningsDistribution ?? 0;
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || stock <= 0) continue;
      if (d < startDate || d > endDate) continue;
      events.push({ date: d, stockDividend: stock });
    }
    cache.set(key, { at: Date.now(), events });
    return events;
  } catch {
    return [];
  }
}
