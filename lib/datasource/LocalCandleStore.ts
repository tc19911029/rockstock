/**
 * LocalCandleStore — 本地 K 線檔案存取
 *
 * 每檔股票存一個 JSON 檔：data/candles/{market}/{symbol}.json
 * 只存原始 OHLCV，讀取時即時計算技術指標（指標參數可能會改）
 *
 * 架構：
 *   cron 收盤後下載 → saveLocalCandles()
 *   掃描時讀取     → loadLocalCandles() → computeIndicators()
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';

/** 本地數據根目錄 */
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles');

interface LocalCandleFile {
  symbol: string;
  lastDate: string;
  updatedAt: string;
  candles: Candle[];
}

function getFilePath(symbol: string, market: 'TW' | 'CN'): string {
  return path.join(DATA_ROOT, market, `${symbol}.json`);
}

/**
 * 讀取本地 K 線檔案並計算指標
 * @returns CandleWithIndicators[] 或 null（檔案不存在/讀取失敗）
 */
export async function loadLocalCandles(
  symbol: string,
  market: 'TW' | 'CN',
): Promise<CandleWithIndicators[] | null> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    if (!data.candles || data.candles.length === 0) return null;
    return computeIndicators(data.candles);
  } catch {
    return null; // 檔案不存在或格式錯誤
  }
}

/**
 * 讀取本地 K 線，只回傳數據涵蓋到 asOfDate 的結果
 * 如果本地數據的 lastDate < asOfDate，表示數據不夠新，回傳 null
 */
export async function loadLocalCandlesForDate(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
): Promise<CandleWithIndicators[] | null> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    if (!data.candles || data.candles.length === 0) return null;

    // 本地數據最後日期必須 >= asOfDate
    if (data.lastDate < asOfDate) return null;

    // 截取到 asOfDate 為止的 K 線
    const filtered = data.candles.filter(c => c.date <= asOfDate);
    if (filtered.length === 0) return null;

    return computeIndicators(filtered);
  } catch {
    return null;
  }
}

/**
 * 將原始 K 線存到本地檔案
 * candles 應為原始 OHLCV（不含指標）
 */
export async function saveLocalCandles(
  symbol: string,
  market: 'TW' | 'CN',
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) return;

  const dir = path.join(DATA_ROOT, market);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // 只保留原始 OHLCV 欄位
  const stripped: Candle[] = candles.map(c => ({
    date: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  const lastDate = stripped[stripped.length - 1].date;

  const data: LocalCandleFile = {
    symbol,
    lastDate,
    updatedAt: new Date().toISOString(),
    candles: stripped,
  };

  const filePath = getFilePath(symbol, market);
  await writeFile(filePath, JSON.stringify(data), 'utf-8');
}

/**
 * 檢查本地檔案是否存在且數據足夠新
 */
export async function isLocalDataFresh(
  symbol: string,
  market: 'TW' | 'CN',
  asOfDate: string,
): Promise<boolean> {
  const filePath = getFilePath(symbol, market);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data: LocalCandleFile = JSON.parse(raw);
    return data.lastDate >= asOfDate;
  } catch {
    return false;
  }
}

/** 取得已下載的股票數量（統計用） */
export function getLocalCandleDir(market: 'TW' | 'CN'): string {
  return path.join(DATA_ROOT, market);
}
