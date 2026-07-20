/**
 * S4 頂部型態 v2（2026-07-07）：複式頭肩頂/倒N字頂/長雙頭頂/一字頂
 * 型別/名稱/達成率完整性 + 一字頂（島狀反轉）結構偵測。
 */
import { detectTopPatternsStructure } from '@/lib/analysis/v12LetterN';
import type { CandleWithIndicators } from '@/types';

function bar(
  date: string, o: number, h: number, l: number, c: number,
  ma?: { ma5: number; ma10: number; ma20: number; ma60: number },
): CandleWithIndicators {
  return { date, open: o, high: h, low: l, close: c, volume: 1000, ...ma } as unknown as CandleWithIndicators;
}

// ⚠️ 2026-07-20 第七輪修：本檔原本測的是「島狀反轉」（向上跳空→孤島→向下跳空）。
// 但 2026-07-12（commit 643926b）已把一字頂**重寫成課程 6-11 的定義** ——
// 高檔窄幅橫盤 + 均線靠攏（MA5/10/20 糾結 <3%、MA20 與 MA60 <5%），無跳空要件；
// 島狀反轉需要兩個缺口，是「另一個型態」。測試沒跟著改 → 從 07-12 起一直是紅的。
// 這裡改成測課程定義。
describe('一字頂（課程 6-11：高檔窄幅橫盤 + 均線靠攏）detectTopPatternsStructure', () => {
  test('高檔窄幅橫盤 + MA5/10/20 糾結 + MA20≈MA60 → 偵測 one-line-top', () => {
    const candles: CandleWithIndicators[] = [];
    // 均線帶：全部靠攏在 100 附近（三線 <3%、MA20 vs MA60 <5%）
    const ma = { ma5: 100.5, ma10: 100.2, ma20: 100.0, ma60: 98.5 };
    // 前段鋪滿歷史（過 N_MIN_HISTORY=30、且 idx >= MAX_DAYS+2）
    for (let i = 0; i < 30; i++) candles.push(bar(`d${i}`, 100, 100.5, 99.5, 100, ma));
    // 高檔窄幅橫盤 5 根：收盤區間 <10%，且橫盤高點在 MA20 之上（排除一字底）
    for (let i = 30; i < 35; i++) candles.push(bar(`d${i}`, 105, 106, 104.5, 105, ma));
    // 今日大量長黑跌破橫盤支撐
    candles.push(bar('d35', 105, 105.2, 100, 100.5, ma));

    const r = detectTopPatternsStructure(candles, candles.length - 1);
    expect(r.patternType).toBe('one-line-top');
    expect(r.necklinePrice).toBeGreaterThan(0);
    expect(r.patternTargetPrice).toBeLessThan(r.necklinePrice!); // 目標在頸線之下（等距投射）
  });

  test('均線沒靠攏（MA20 遠離 MA60）→ 不算一字頂', () => {
    const candles: CandleWithIndicators[] = [];
    const maApart = { ma5: 100.5, ma10: 100.2, ma20: 100.0, ma60: 80.0 }; // MA20 vs MA60 差 25%
    for (let i = 0; i < 30; i++) candles.push(bar(`d${i}`, 100, 100.5, 99.5, 100, maApart));
    for (let i = 30; i < 35; i++) candles.push(bar(`d${i}`, 105, 106, 104.5, 105, maApart));
    candles.push(bar('d35', 105, 105.2, 100, 100.5, maApart));

    const r = detectTopPatternsStructure(candles, candles.length - 1);
    expect(r.patternType).not.toBe('one-line-top');
  });
});

describe('S4 v2 型別完整性（enum ↔ 名稱 ↔ 達成率）', () => {
  test('7 型都有中文名（間接驗 Record 完整，缺 key tsc 會擋）', () => {
    // detectTopPatternsStructure 對空/無結構回 triggered:false，此處只驗模組載入不拋錯
    const empty = detectTopPatternsStructure([bar('d0', 100, 101, 99, 100)], 0);
    expect(empty.triggered).toBe(false);
  });
});
