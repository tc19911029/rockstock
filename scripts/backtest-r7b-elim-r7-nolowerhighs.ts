/**
 * 驗證 1：淘汰 R7 拿掉「頭頭低」前置條件
 *
 * 現況 lib/scanner/eliminationFilter.ts rule07：必須先 lowerHighs 才檢查 MACD/KD 背離。
 * 課程 5-3/p09 第 11 條「MACD 或 KD 指標背離的股票」是獨立一條、無前置。
 *
 * 檢定：拿掉前置後「多淘汰」的那批股票日，之後 D5/D20 去 beta 超額是正還負？
 *   負 → 該淘汰（改動有理）；正 → 誤殺（維持現狀）。
 *
 * 三組對照：
 *   A. current-fire  = 現行條件就會淘汰（頭頭低 + 背離）
 *   B. new-only      = 拿掉前置後才多淘汰的（背離但非頭頭低）← 本案關鍵
 *   C. baseline      = 宇宙全體（同流動性門檻）
 */
import { detectTrend, findPivots } from '@/lib/analysis/trendAnalysis';
import type { CandleWithIndicators } from '@/types';
import {
  loadStocks, loadBench, benchFwd, liquid, HORIZONS,
  type Obs, reportGroup, splitDate, attachUniverseExcess,
} from './backtest-r7b-common';

/** 只做背離判定（rule07 的後半段，無前置） */
function divergenceOnly(candles: CandleWithIndicators[], idx: number): boolean {
  if (idx < 10) return false;
  const c = candles[idx];
  const prev5 = candles[idx - 5];
  if (!prev5) return false;
  if (c.macdOSC != null && prev5.macdOSC != null && c.high > prev5.high && c.macdOSC < prev5.macdOSC) return true;
  if (c.kdK != null && prev5.kdK != null && c.high > prev5.high && c.kdK < prev5.kdK) return true;
  return false;
}

/** 生產現行的前置：空頭 或 findPivots 兩個 high 遞減 */
function lowerHighs(candles: CandleWithIndicators[], idx: number): boolean {
  if (detectTrend(candles, idx) === '空頭') return true;
  const pivots = findPivots(candles, idx, 8, false);
  const highs = pivots.filter(p => p.type === 'high');
  return highs.length >= 2 && highs[0].price < highs[1].price;
}

function main() {
  const bench = loadBench();
  const stocks = loadStocks();
  const FROM = '2023-04-13'; // ^TWII 起始
  const groups: Record<string, Obs[]> = { current: [], newOnly: [], baseline: [] };

  let done = 0;
  for (const s of stocks) {
    const cs = s.candles;
    for (let t = 60; t + 20 < cs.length; t++) {
      const c = cs[t];
      if (c.date < FROM) continue;
      if (!liquid(c)) continue;

      const ex: Record<number, number> = {};
      let ok = true;
      for (const h of HORIZONS) {
        const b = benchFwd(bench, c.date, h);
        if (b == null) { ok = false; break; }
        ex[h] = (cs[t + h].close / c.close - 1) * 100 - b;
      }
      if (!ok) continue;
      const o: Obs = { date: c.date, symbol: s.symbol, ex };
      groups.baseline.push(o);

      if (!divergenceOnly(cs, t)) continue;
      // 只在背離成立時才付 detectTrend/findPivots 的代價
      if (lowerHighs(cs, t)) groups.current.push(o);
      else groups.newOnly.push(o);
    }
    if (++done % 300 === 0) process.stdout.write('.');
  }
  console.log('');

  attachUniverseExcess(groups.baseline, [groups.baseline, groups.current, groups.newOnly]);
  const mid = splitDate(groups.baseline);
  console.log(`\n===== 驗證 1：R7 拿掉「頭頭低」前置 =====`);
  console.log(`宇宙 ${groups.baseline.length} 股票日，train/test 分界 ${mid}`);

  console.log('\n########## 基準 A：^TWII（含等權 vs 市值權規模偏差，僅供參考）##########');
  reportGroup('C. baseline 宇宙全體', groups.baseline, mid, 'twii');
  reportGroup('A. current-fire 現行就淘汰', groups.current, mid, 'twii');
  reportGroup('B. new-only 多淘汰的', groups.newOnly, mid, 'twii');

  console.log('\n########## 基準 B：同日宇宙平均（主判定）##########');
  reportGroup('A. current-fire 現行就淘汰（頭頭低+背離）', groups.current, mid, 'univ');
  reportGroup('B. new-only 拿掉前置後「多淘汰」的 ← 關鍵', groups.newOnly, mid, 'univ');
  console.log('\n判讀：B 組 train 與 test 的 D5/D20 超額都明顯為負 → 改動有理（該淘汰）；');
  console.log('      若為正或 train/test 翻面 → 誤殺，否決，維持現狀。');
}
main();
