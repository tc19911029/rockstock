/**
 * 台股2贏家策略即時掃描
 *
 * V型反轉 (PF 1.38, WR 52.5%) + 雙均線趨勢 (PF 1.36, 盈虧比 3.21)
 * 掃描最近 N 個交易日的訊號，顯示當前可操作的股票
 *
 * Usage: npx tsx scripts/scan-tw-2winners.ts
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import type { CandleWithIndicators } from '@/types';

const cacheFile = path.join(process.cwd(), 'data', 'backtest-candles.json');
const SCAN_LAST_N_DAYS = 5; // 掃描最近5個交易日

// ── 策略函數（與回測一致）─────────────────────────────────────

function scanVReversal(candles: CandleWithIndicators[], idx: number): {
  pass: boolean;
  deviation?: number;
  consecutiveDown?: number;
  closePosition?: number;
  volRatio?: number;
} {
  if (idx < 5) return { pass: false };
  const today = candles[idx];
  if (today.ma20 == null || today.avgVol5 == null) return { pass: false };

  let consecutiveDown = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
    if (candles[i].close < candles[i].open) consecutiveDown++;
    else break;
  }
  if (consecutiveDown < 3) return { pass: false };

  const deviation = (today.close - today.ma20) / today.ma20;
  if (deviation > -0.12) return { pass: false };

  const range = today.high - today.low;
  if (range <= 0) return { pass: false };
  const closePosition = (today.close - today.low) / range;
  if (closePosition < 0.4) return { pass: false };

  const volRatio = today.volume / today.avgVol5;
  if (volRatio < 1.2) return { pass: false };

  if (idx >= 20) {
    const ma20_20ago = candles[idx - 20].ma20;
    const ma20_40ago = idx >= 40 ? candles[idx - 40].ma20 : null;
    if (ma20_20ago != null && ma20_40ago != null && ma20_20ago < ma20_40ago) {
      return { pass: false };
    }
  }

  return { pass: true, deviation: +(deviation * 100).toFixed(1), consecutiveDown, closePosition: +closePosition.toFixed(2), volRatio: +volRatio.toFixed(1) };
}

function scanTwoMA(candles: CandleWithIndicators[], idx: number): {
  pass: boolean;
  ma10?: number;
  ma24?: number;
  ma24slope?: number;
} {
  if (idx < 5) return { pass: false };
  const today = candles[idx];
  const yesterday = candles[idx - 1];
  const fiveDaysAgo = candles[idx - 5];

  if (today.ma10 == null || today.ma24 == null) return { pass: false };
  if (yesterday.ma10 == null || yesterday.ma24 == null) return { pass: false };
  if (fiveDaysAgo.ma24 == null) return { pass: false };

  if (today.ma24 <= fiveDaysAgo.ma24) return { pass: false };
  if (today.close <= today.ma10) return { pass: false };
  if (today.ma10 <= today.ma24) return { pass: false };
  if (yesterday.close > yesterday.ma10) return { pass: false };
  if (today.close <= today.open) return { pass: false };

  const ma24slope = +((today.ma24 - fiveDaysAgo.ma24) / fiveDaysAgo.ma24 * 100).toFixed(2);

  return { pass: true, ma10: today.ma10, ma24: today.ma24, ma24slope };
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('載入台股數據...');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

  const allStocks = new Map<string, { name: string; candles: CandleWithIndicators[] }>();
  for (const [sym, data] of Object.entries(raw.stocks as Record<string, { name: string; candles: any[] }>)) {
    if (!data.candles || data.candles.length < 60) continue;
    try {
      allStocks.set(sym, { name: data.name, candles: computeIndicators(data.candles) });
    } catch { /* skip */ }
  }
  console.log(`  ${allStocks.size} 支股票\n`);

  // 取最後 N 個交易日
  const benchSymbol = allStocks.has('2330.TW') ? '2330.TW' : allStocks.keys().next().value;
  const benchCandles = allStocks.get(benchSymbol!)!.candles;
  const allDays = benchCandles.map(c => c.date?.slice(0, 10)).filter((d): d is string => !!d);
  const lastNDays = allDays.slice(-SCAN_LAST_N_DAYS);
  console.log(`掃描最近 ${SCAN_LAST_N_DAYS} 個交易日: ${lastNDays[0]} ~ ${lastNDays[lastNDays.length - 1]}\n`);

  // ── V型反轉掃描 ──
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  V型反轉訊號 (回測: PF 1.38, 勝率 52.5%, 總報酬 +63.3%)');
  console.log('  規則: 連跌3天+ | 偏離MA20≥12% | 反轉K棒 | 放量');
  console.log('  操作: 隔日開盤買 → 停損-7% / 達目標價 / 持有5天');
  console.log('═══════════════════════════════════════════════════════════════\n');

  interface VSignal {
    date: string; symbol: string; name: string;
    close: number; deviation: number; consecutiveDown: number;
    closePosition: number; volRatio: number;
    ma20: number;
    nextOpen?: number; // 隔日開盤（如果有的話）
    currentStatus?: string;
  }
  const vSignals: VSignal[] = [];

  for (const day of lastNDays) {
    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === day);
      if (idx < 25 || idx >= candles.length) continue;

      const result = scanVReversal(candles, idx);
      if (!result.pass) continue;

      const c = candles[idx];
      const nextCandle = idx + 1 < candles.length ? candles[idx + 1] : null;

      // 判斷狀態
      let currentStatus = '待進場';
      let nextOpen: number | undefined;
      if (nextCandle) {
        nextOpen = nextCandle.open;
        const entryPrice = nextCandle.open;
        // 檢查是否已經觸發出場
        const returnFromEntry = (nextCandle.close - entryPrice) / entryPrice * 100;
        const lowReturn = (nextCandle.low - entryPrice) / entryPrice * 100;
        if (lowReturn <= -7) {
          currentStatus = `已停損 (${lowReturn.toFixed(1)}%)`;
        } else {
          currentStatus = `持有中 (${returnFromEntry >= 0 ? '+' : ''}${returnFromEntry.toFixed(1)}%)`;
        }
      }

      vSignals.push({
        date: day,
        symbol, name: stockData.name,
        close: c.close,
        deviation: result.deviation!,
        consecutiveDown: result.consecutiveDown!,
        closePosition: result.closePosition!,
        volRatio: result.volRatio!,
        ma20: c.ma20!,
        nextOpen,
        currentStatus,
      });
    }
  }

  if (vSignals.length === 0) {
    console.log('  (最近5日無V型反轉訊號)\n');
  } else {
    console.log('  日期        代碼        名稱      收盤    MA20    偏離    連跌  收盤位  量比   隔日開盤  狀態');
    console.log('  ' + '─'.repeat(95));
    for (const s of vSignals.sort((a, b) => a.date.localeCompare(b.date) || a.deviation - b.deviation)) {
      console.log(
        '  ' + s.date + '  ' +
        s.symbol.padEnd(10) + '  ' +
        s.name.slice(0, 6).padEnd(8) +
        s.close.toFixed(1).padStart(7) + '  ' +
        s.ma20.toFixed(1).padStart(7) + '  ' +
        (s.deviation + '%').padStart(7) + '  ' +
        (s.consecutiveDown + '天').padStart(4) + '  ' +
        s.closePosition.toFixed(2).padStart(5) + '  ' +
        (s.volRatio + 'x').padStart(5) + '  ' +
        (s.nextOpen ? s.nextOpen.toFixed(1) : '  -  ').padStart(8) + '  ' +
        (s.currentStatus ?? '')
      );
    }
    console.log();
  }

  // ── 雙均線趨勢掃描 ──
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  雙均線趨勢訊號 (回測: PF 1.36, 盈虧比 3.21, 總報酬 +51.8%)');
  console.log('  規則: MA24上升 | close > MA10 > MA24 | 穿越MA10');
  console.log('  操作: 隔日開盤買 → 破MA10/MA24轉下/停損-7% / 最多20天');
  console.log('═══════════════════════════════════════════════════════════════\n');

  interface MASignal {
    date: string; symbol: string; name: string;
    close: number; ma10: number; ma24: number; ma24slope: number;
    bodyPct: number; volRatio: number;
    nextOpen?: number;
    currentStatus?: string;
  }
  const maSignals: MASignal[] = [];

  for (const day of lastNDays) {
    for (const [symbol, stockData] of allStocks) {
      const { candles } = stockData;
      const idx = candles.findIndex(c => c.date?.slice(0, 10) === day);
      if (idx < 25 || idx >= candles.length) continue;

      const result = scanTwoMA(candles, idx);
      if (!result.pass) continue;

      const c = candles[idx];
      const bodyPct = +((c.close - c.open) / c.open * 100).toFixed(1);
      const volRatio = c.avgVol5 && c.avgVol5 > 0 ? +(c.volume / c.avgVol5).toFixed(1) : 0;
      const nextCandle = idx + 1 < candles.length ? candles[idx + 1] : null;

      let currentStatus = '待進場';
      let nextOpen: number | undefined;
      if (nextCandle) {
        nextOpen = nextCandle.open;
        const entryPrice = nextCandle.open;
        // 簡單檢查
        const returnFromEntry = (nextCandle.close - entryPrice) / entryPrice * 100;
        if (nextCandle.ma10 != null && nextCandle.close < nextCandle.ma10) {
          currentStatus = `破MA10 (${returnFromEntry >= 0 ? '+' : ''}${returnFromEntry.toFixed(1)}%)`;
        } else {
          currentStatus = `持有中 (${returnFromEntry >= 0 ? '+' : ''}${returnFromEntry.toFixed(1)}%)`;
        }
      }

      maSignals.push({
        date: day,
        symbol, name: stockData.name,
        close: c.close, ma10: result.ma10!, ma24: result.ma24!, ma24slope: result.ma24slope!,
        bodyPct, volRatio,
        nextOpen,
        currentStatus,
      });
    }
  }

  if (maSignals.length === 0) {
    console.log('  (最近5日無雙均線趨勢訊號)\n');
  } else {
    console.log('  日期        代碼        名稱      收盤    MA10    MA24   MA24斜率  K棒%   量比   隔日開盤  狀態');
    console.log('  ' + '─'.repeat(100));
    for (const s of maSignals.sort((a, b) => a.date.localeCompare(b.date) || b.bodyPct - a.bodyPct)) {
      console.log(
        '  ' + s.date + '  ' +
        s.symbol.padEnd(10) + '  ' +
        s.name.slice(0, 6).padEnd(8) +
        s.close.toFixed(1).padStart(7) + '  ' +
        s.ma10.toFixed(1).padStart(7) + '  ' +
        s.ma24.toFixed(1).padStart(7) + '  ' +
        ('+' + s.ma24slope + '%').padStart(8) + '  ' +
        ('+' + s.bodyPct + '%').padStart(6) + '  ' +
        (s.volRatio + 'x').padStart(5) + '  ' +
        (s.nextOpen ? s.nextOpen.toFixed(1) : '  -  ').padStart(8) + '  ' +
        (s.currentStatus ?? '')
      );
    }
    console.log();
  }

  // ── 統計總結 ──
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  V型反轉: 最近5日 ${vSignals.length} 個訊號`);
  console.log(`  雙均線:   最近5日 ${maSignals.length} 個訊號`);
  console.log('═══════════════════════════════════════════════════════════════');

  // 找最新一天還未進場的（可操作）
  const latestDay = lastNDays[lastNDays.length - 1];
  const actionableV = vSignals.filter(s => s.date === latestDay);
  const actionableMA = maSignals.filter(s => s.date === latestDay);

  if (actionableV.length > 0 || actionableMA.length > 0) {
    console.log(`\n★ ${latestDay} 可操作訊號（隔日開盤買入）:`);
    for (const s of actionableV) {
      console.log(`  [V反轉] ${s.symbol} ${s.name.slice(0, 6)} — 收盤 ${s.close} | 偏離MA20 ${s.deviation}% | 連跌${s.consecutiveDown}天`);
    }
    for (const s of actionableMA) {
      console.log(`  [雙均線] ${s.symbol} ${s.name.slice(0, 6)} — 收盤 ${s.close} | MA10=${s.ma10.toFixed(1)} MA24=${s.ma24.toFixed(1)} | MA24斜率 +${s.ma24slope}%`);
    }
  } else {
    console.log(`\n  ${latestDay} 無新訊號`);
  }
}

main().catch(console.error);
