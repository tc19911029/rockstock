// ============================================================
// 台股大盤成交統計（TWSE 官方 FMTQIK）— ^TWII 成交量的單一事實來源。
//
// 為什麼需要這支（2026-07-23）：
//   Yahoo 對 ^TWII 回的 volume 只有官方成交股數的 35~57%，而且比例逐日浮動：
//     2026-07-17 崩盤日官方 182.4 億股（當月最大量），Yahoo 只給 638 萬張 → 排中段
//     2026-07-01 官方 146.8 億股，Yahoo 給 842 萬張 → 57%
//   比例不固定 ⇒ 不是單位換算問題，是 Yahoo 本身資料殘缺。指數量價分析
//  （捕撈季節彩柱、爆量/量縮判讀）整段被扭曲，必須改用官方數字。
//
// 單位：官方「成交股數」是股 → ÷1000 轉「張」，對齊 L1 台股 volume 單位
//      （mis.twse t00 的 m 欄位也是張，兩者對得上，差異只在盤後定價交易）。
//
// 端點：https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=YYYYMM01&response=json
//      一次回整個月，欄位 = [日期, 成交股數, 成交金額, 成交筆數, 發行量加權股價指數, 漲跌點數]
// ============================================================

import { fetchJsonWithCurlFallback } from './curlFetch';

export interface TwseMarketDayStat {
  date: string;        // YYYY-MM-DD
  /** 成交量（張）= 官方成交股數 / 1000 */
  volume: number;
  /** 成交金額（元） */
  amount: number;
  /** 成交筆數 */
  trades: number;
  /** 發行量加權股價指數收盤 */
  close: number;
}

interface FmtqikResponse {
  stat?: string;
  fields?: string[];
  data?: string[][];
}

/** yyyymm → 該月統計；過去月份永久 cache、當月短 TTL（盤後才會有今天） */
const monthCache = new Map<string, { at: number; stats: Map<string, TwseMarketDayStat> }>();
const CURRENT_MONTH_TTL_MS = 10 * 60 * 1000;

function toNum(s: string): number {
  const n = parseFloat((s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 民國日期 '115/07/22' → '2026-07-22' */
function rocToIso(roc: string): string | null {
  const m = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec((roc ?? '').trim());
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}

function taipeiMonth(): string {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  return d.slice(0, 4) + d.slice(5, 7);
}

/**
 * 抓某月（yyyymm，例 '202607'）的大盤成交統計。
 * 失敗回空 Map（fail-open — 呼叫端保留原值，不可因為官方站掛掉就把 volume 抹成 0）。
 */
export async function fetchTwseMarketStatsMonth(yyyymm: string): Promise<Map<string, TwseMarketDayStat>> {
  const cached = monthCache.get(yyyymm);
  if (cached) {
    const isCurrent = yyyymm === taipeiMonth();
    if (!isCurrent || Date.now() - cached.at < CURRENT_MONTH_TTL_MS) return cached.stats;
  }

  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${yyyymm}01&response=json`;
  const stats = new Map<string, TwseMarketDayStat>();
  try {
    const { data: json } = await fetchJsonWithCurlFallback<FmtqikResponse>(url, {
      timeoutMs: 15000,
      headers: { Referer: 'https://www.twse.com.tw/zh/trading/historical/fmtqik.html' },
    });
    for (const row of json.data ?? []) {
      const date = rocToIso(row[0]);
      if (!date) continue;
      const shares = toNum(row[1]);
      if (!(shares > 0)) continue; // 休市/無資料
      stats.set(date, {
        date,
        volume: Math.round(shares / 1000),
        amount: toNum(row[2]),
        trades: toNum(row[3]),
        close: toNum(row[4]),
      });
    }
  } catch (err) {
    console.warn(`[TwseMarketStats] ${yyyymm} 抓取失敗:`, err instanceof Error ? err.message : err);
    return stats; // 空 Map，呼叫端 fail-open
  }

  if (stats.size > 0) monthCache.set(yyyymm, { at: Date.now(), stats });
  return stats;
}

/**
 * 給一批日期（YYYY-MM-DD），回 date → 官方成交量（張）。
 * 逐月抓，併發上限 4（3 年份 ≈ 40 個月：串行要 12s，併發 4 約 2s；且過去月份永久 cache，
 * 只有第一次冷啟動付這個成本）。
 */
const MONTH_FETCH_CONCURRENCY = 4;

export async function getTwseIndexVolumes(dates: string[]): Promise<Map<string, number>> {
  const months = [...new Set(dates.map((d) => d.slice(0, 4) + d.slice(5, 7)))].sort();
  const out = new Map<string, number>();
  for (let i = 0; i < months.length; i += MONTH_FETCH_CONCURRENCY) {
    const batch = months.slice(i, i + MONTH_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map((m) => fetchTwseMarketStatsMonth(m)));
    for (const stats of results) {
      for (const [date, s] of stats) out.set(date, s.volume);
    }
  }
  return out;
}

/**
 * 把 ^TWII K 線的 volume 換成官方成交量（張）。就地回傳新陣列，抓不到的日期保留原值。
 * 只覆蓋 volume，OHLC 不動（官方 FMTQIK 只有收盤，開高低仍走原 provider）。
 */
export async function applyTwseIndexVolume<T extends { date: string; volume: number }>(
  candles: T[],
): Promise<T[]> {
  if (candles.length === 0) return candles;
  const volumes = await getTwseIndexVolumes(candles.map((c) => c.date));
  if (volumes.size === 0) return candles;
  return candles.map((c) => {
    const v = volumes.get(c.date);
    return v && v > 0 ? { ...c, volume: v } : c;
  });
}
