/**
 * 打板掃描器 — A 股漲停板戰法
 *
 * 掃描今日漲停的股票，過濾 ST/一字板/低成交，
 * 按首板優先 + 成交額排序，輸出明天的買入候選清單。
 *
 * 不繼承 MarketScanner（朱家泓管道不適用），獨立實作。
 */

import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';
import type { DabanScanResult, DabanScanSession, LimitUpType } from './types';

// ── 參數 ────────────────────────────────────────────────────────────────────

const LIMIT_UP_MAIN = 9.5;    // 主板漲停判定 %（10% 容差）
const LIMIT_UP_GEM  = 19.5;   // 創業板/科創板漲停判定 %（20% 容差）
const MIN_TURNOVER  = 5e6;    // 最低成交額 500 萬
const GAP_UP_FACTOR = 1.02;   // 高開門檻 = 收盤 × 1.02

// ── Helpers ─────────────────────────────────────────────────────────────────

function isGemOrStar(symbol: string): boolean {
  // 創業板 300xxx.SZ, 科創板 688xxx.SS
  return symbol.startsWith('300') || symbol.startsWith('688');
}

function getLimitUpThreshold(symbol: string): number {
  return isGemOrStar(symbol) ? LIMIT_UP_GEM : LIMIT_UP_MAIN;
}

function getDayReturn(candles: CandleWithIndicators[], idx: number): number {
  if (idx <= 0) return 0;
  return (candles[idx].close - candles[idx - 1].close) / candles[idx - 1].close * 100;
}

function getConsecutiveBoards(candles: CandleWithIndicators[], idx: number, symbol: string): number {
  const threshold = getLimitUpThreshold(symbol);
  let count = 0;
  for (let i = idx; i >= 1; i--) {
    if (getDayReturn(candles, i) >= threshold) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function getBoardType(boards: number): LimitUpType {
  if (boards <= 1) return '首板';
  if (boards === 2) return '二板';
  if (boards === 3) return '三板';
  return '四板+';
}

function getAvgVolume(candles: CandleWithIndicators[], idx: number, period: number): number {
  let sum = 0;
  const start = Math.max(0, idx - period + 1);
  for (let i = start; i <= idx; i++) sum += (candles[i].volume ?? 0);
  return sum / (idx - start + 1);
}

// ── Main Scanner ────────────────────────────────────────────────────────────

export interface DabanScanInput {
  stocks: Map<string, { name: string; candles: CandleWithIndicators[] }>;
  date: string; // YYYY-MM-DD
}

/**
 * 掃描指定日期的漲停股
 */
export function scanDaban(input: DabanScanInput): DabanScanSession {
  const { stocks, date } = input;
  const results: DabanScanResult[] = [];

  for (const [symbol, stockData] of stocks) {
    const candles = stockData.candles;
    const idx = candles.findIndex(c => c.date?.slice(0, 10) === date);
    if (idx < 2) continue;

    const today = candles[idx];
    const yesterday = candles[idx - 1];

    // 1. 判斷今日是否漲停
    const dayReturn = getDayReturn(candles, idx);
    const threshold = getLimitUpThreshold(symbol);
    if (dayReturn < threshold) continue;

    // 2. 過濾 ST（名稱檢查）
    if (stockData.name.includes('ST') || stockData.name.includes('*ST')) continue;

    // 3. 過濾一字板（開盤=最高=收盤，散戶買不到）
    const isYiZiBan = today.open === today.high && today.high === today.close;

    // 4. 成交額門檻
    const vol = today.volume ?? 0;
    const turnover = vol * today.close;
    if (turnover < MIN_TURNOVER) continue;

    // 5. 計算連板天數
    const consecutiveBoards = getConsecutiveBoards(candles, idx, symbol);
    const limitUpType = getBoardType(consecutiveBoards);

    // 6. 量比
    const avgVol5 = getAvgVolume(candles, idx, 5);
    const volumeRatio = avgVol5 > 0 ? +(vol / avgVol5).toFixed(2) : 0;

    // 7. 排序分數：首板優先 × 成交額
    const boardBonus = consecutiveBoards === 1 ? 2.0 : consecutiveBoards === 2 ? 1.5 : 1.0;
    const rankScore = +(boardBonus * Math.log10(Math.max(turnover, 1))).toFixed(2);

    // 8. 買入門檻價
    const buyThresholdPrice = +(today.close * GAP_UP_FACTOR).toFixed(2);

    results.push({
      symbol,
      name: stockData.name,
      closePrice: today.close,
      prevClose: yesterday.close,
      limitUpPct: +dayReturn.toFixed(2),
      limitUpType,
      consecutiveBoards,
      turnover: Math.round(turnover),
      volumeRatio,
      isYiZiBan,
      rankScore,
      buyThresholdPrice,
      scanDate: date,
    });
  }

  // 排序：分數高的在前，一字板放最後（買不到）
  results.sort((a, b) => {
    if (a.isYiZiBan !== b.isYiZiBan) return a.isYiZiBan ? 1 : -1;
    return b.rankScore - a.rankScore;
  });

  return {
    id: `daban-CN-${date}-${Date.now()}`,
    market: 'CN',
    date,
    scanTime: new Date().toISOString(),
    resultCount: results.length,
    results,
  };
}

/**
 * 從本地快取 JSON 載入股票資料並掃描
 */
export async function scanDabanFromCache(date: string): Promise<DabanScanSession> {
  const fs = await import('fs');
  const path = await import('path');

  const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles-cn.json');
  if (!fs.existsSync(cacheFile)) {
    throw new Error('找不到 CN 快取: ' + cacheFile);
  }

  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
  const stocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();

  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: unknown[] }>)) {
    if (!data.candles || data.candles.length < 30) continue;
    try {
      stocks.set(sym, { name: data.name, candles: computeIndicators(data.candles as CandleWithIndicators[]) });
    } catch { /* skip */ }
  }

  return scanDaban({ stocks, date });
}
