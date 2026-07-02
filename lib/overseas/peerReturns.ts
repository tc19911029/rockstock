/**
 * 海外同業對照 — 報酬計算 + 市場時段工具（純函式，可單測）
 *
 * d1  = 最新收盤 vs 前一根收盤
 * dN  = 最新收盤 vs N 根前收盤（d5 / d20 / d60）
 * 全部回 %、1 位小數；K 線不足 → null。
 */

import type { Candle } from '@/types';

export interface HorizonReturns {
  /** 最新收盤價 */
  last: number | null;
  /** 最新收盤日（YYYY-MM-DD） */
  lastDate: string | null;
  d1: number | null;
  d5: number | null;
  d20: number | null;
  d60: number | null;
}

export const EMPTY_RETURNS: HorizonReturns = {
  last: null, lastDate: null, d1: null, d5: null, d20: null, d60: null,
};

function pctVs(candles: Pick<Candle, 'close'>[], n: number): number | null {
  const lastIdx = candles.length - 1;
  const baseIdx = lastIdx - n;
  if (baseIdx < 0) return null;
  const last = candles[lastIdx].close;
  const base = candles[baseIdx].close;
  if (!Number.isFinite(last) || !Number.isFinite(base) || base <= 0) return null;
  return Math.round((last / base - 1) * 1000) / 10; // %、1 位小數
}

export function computeHorizonReturns(
  candles: Pick<Candle, 'date' | 'close'>[] | null | undefined,
): HorizonReturns {
  if (!candles || candles.length === 0) return EMPTY_RETURNS;
  const last = candles[candles.length - 1];
  return {
    last: Number.isFinite(last.close) ? last.close : null,
    lastDate: last.date ?? null,
    d1: pctVs(candles, 1),
    d5: pctVs(candles, 5),
    d20: pctVs(candles, 20),
    d60: pctVs(candles, 60),
  };
}

// ── 市場時段：未收盤的「今日半根」不落地 ─────────────────────────────────────
//
// Yahoo 在盤中會回當日進行中的 bar（且 yahooProvider 對美股還有即時報價覆蓋），
// 直接 merge 進儲存會留下半根污染（同 L1 的盤中半根教訓）。
// 規則：最後一根的 date == 該市場當地「今日」且當地時間 < 收盤 + 60 分鐘 → 丟掉。
// merge-by-date 下，就算漏丟，下一次 cron 也會用完整 bar 覆蓋（自癒）。

type OverseasSession = { tz: string; closeMin: number };

function sessionOf(ticker: string): OverseasSession {
  if (/\.T$/i.test(ticker)) return { tz: 'Asia/Tokyo', closeMin: 15 * 60 + 30 };  // TSE 15:30
  if (/\.KS$/i.test(ticker)) return { tz: 'Asia/Seoul', closeMin: 15 * 60 + 30 }; // KRX 15:30
  return { tz: 'America/New_York', closeMin: 16 * 60 };                           // 美股（含 ^SOX/^IXIC）16:00 ET
}

const SETTLE_BUFFER_MIN = 60;

/** 取 now 在指定時區的 { 日期字串, 當日分鐘數 } */
function localNow(tz: string, now: Date): { dateStr: string; min: number } {
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const parts = now
    .toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
    .split(':');
  const hour = parseInt(parts[0], 10) % 24; // '24:xx' edge → 0
  const min = parseInt(parts[1], 10);
  return { dateStr, min: hour * 60 + min };
}

/**
 * 丟掉「尚未確定收盤」的今日 bar（與未來日期的髒 bar）。
 * @param now 注入用於測試；預設當下
 */
export function dropUnsettledTodayBar(
  ticker: string,
  candles: Candle[],
  now: Date = new Date(),
): Candle[] {
  if (candles.length === 0) return candles;
  const { tz, closeMin } = sessionOf(ticker);
  const { dateStr: localToday, min } = localNow(tz, now);
  const settled = min >= closeMin + SETTLE_BUFFER_MIN;

  let end = candles.length;
  while (end > 0) {
    const d = candles[end - 1].date;
    if (d > localToday) { end--; continue; }       // 未來日期 → 一律丟
    if (d === localToday && !settled) { end--; continue; } // 今日且未收盤+緩衝 → 丟
    break;
  }
  return end === candles.length ? candles : candles.slice(0, end);
}
