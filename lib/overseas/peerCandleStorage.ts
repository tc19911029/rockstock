/**
 * 海外同業日K儲存（純顯示層 — 海外同業對照 /overseas 專用）
 *
 * 為什麼不進既有 L1 candle 體系（readCandleFile / writeCandleFile）：
 *   1. L1 介面 market 參數硬型別 'TW' | 'CN'，海外 ticker 沒有合法值
 *   2. L1 寫入層 guard 全是台/陸市場假設 — 漲跌停 limitMoveGuard（台 10% / 陸
 *      10/20%）、ghost .TW guard、volume 張/手單位 sanity — 對 USD/JPY/KRW
 *      標的會誤殺或無意義
 *   3. audit-l1-invariant 等每日稽核掃 data/candles/{TW,CN}/ 整目錄，
 *      混入海外檔會污染稽核結果
 * → 獨立存 data/overseas/candles/{ticker}.json，merge-by-date
 *   （信封格式仿 lib/chips/ChipExtrasStorage.ts）。
 *
 * FS-only：寫入端是本地 launchd cron（fetch-global-peers），讀取端是本機
 * prod/dev server — 不做 Vercel Blob dual-storage（本功能為本機顯示層參考）。
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { Candle } from '@/types';

const DIR = path.join(process.cwd(), 'data', 'overseas', 'candles');

export interface OverseasCandleFile {
  ticker: string;
  market: 'OVERSEAS';
  lastDate: string;
  updatedAt: string;
  candles: Candle[];
}

// ticker 安全檢查（防 path traversal）：
//   美股字母（可帶 -B）、^ 指數、東京 .T / 首爾 .KS 後綴
const TICKER_RE = /^(?:\^[A-Z0-9]{1,8}|[A-Z0-9]{1,6}(?:-[A-Z])?(?:\.(?:T|KS))?)$/i;

function tickerPath(ticker: string): string {
  if (!TICKER_RE.test(ticker)) {
    throw new Error(`invalid overseas ticker: ${JSON.stringify(ticker)}`);
  }
  return path.join(DIR, `${ticker.toUpperCase()}.json`);
}

export async function readOverseasCandles(ticker: string): Promise<OverseasCandleFile | null> {
  try {
    const raw = await fs.readFile(tickerPath(ticker), 'utf8');
    const data = JSON.parse(raw) as OverseasCandleFile;
    if (!data.candles || data.candles.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * merge-by-date 寫入：同日期後者覆蓋（盤後完整 bar wins），其餘保留。
 * 內容沒變不重寫（避免 data/ churn）。
 */
export async function writeOverseasCandles(
  ticker: string,
  rows: Candle[],
): Promise<{ added: boolean; lastDate: string; total: number }> {
  const filePath = tickerPath(ticker);
  const existing = await readOverseasCandles(ticker);
  const map = new Map<string, Candle>();
  for (const c of existing?.candles ?? []) map.set(c.date, c);
  let added = false;
  for (const c of rows) {
    const prev = map.get(c.date);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(c)) added = true;
    map.set(c.date, c); // 後者覆蓋
  }
  const merged = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  const lastDate = merged[merged.length - 1]?.date ?? '';
  if (!added) return { added: false, lastDate, total: merged.length };

  const file: OverseasCandleFile = {
    ticker: ticker.toUpperCase(),
    market: 'OVERSEAS',
    lastDate,
    updatedAt: new Date().toISOString(),
    candles: merged,
  };
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await fs.mkdir(DIR, { recursive: true });
  await atomicFsPut(filePath, JSON.stringify(file));
  return { added: true, lastDate, total: merged.length };
}
