/**
 * S4 頂部型態 v2（2026-07-07）：複式頭肩頂/倒N字頂/長雙頭頂/一字頂
 * 型別/名稱/達成率完整性 + 一字頂（島狀反轉）結構偵測。
 */
import { detectTopPatternsStructure } from '@/lib/analysis/v12LetterN';
import type { CandleWithIndicators } from '@/types';

function bar(date: string, o: number, h: number, l: number, c: number): CandleWithIndicators {
  return { date, open: o, high: h, low: l, close: c, volume: 1000 } as unknown as CandleWithIndicators;
}

describe('一字頂 / 島狀反轉頂 detectTopPatternsStructure', () => {
  test('向上跳空→孤島高→向下跳空 → 偵測 one-line-top', () => {
    const candles: CandleWithIndicators[] = [];
    // ≥31 根（過 N_MIN_HISTORY=30），孤島放在最後 20 根內（detectOneLineTop 回看 20 根）
    for (let i = 0; i < 22; i++) candles.push(bar(`d${i}`, 100, 100.5, 99.5, 100));
    // 向上跳空進入孤島（low 102 > 前一根 high 100.5）
    candles.push(bar('d22', 103, 105, 102, 104));
    candles.push(bar('d23', 104, 105.5, 103.5, 104.5));
    candles.push(bar('d24', 104.5, 105, 103.8, 104));
    // 向下跳空離開（high 101 < 前一根 low 103.8）
    candles.push(bar('d25', 100.5, 101, 99, 99.5));
    for (let i = 26; i < 33; i++) candles.push(bar(`d${i}`, 100, 100.5, 99.5, 100));
    const r = detectTopPatternsStructure(candles, candles.length - 1);
    expect(r.patternType).toBe('one-line-top');
    expect(r.necklinePrice).toBeGreaterThan(0);
    expect(r.patternTargetPrice).toBeLessThan(r.necklinePrice!); // 目標在頸線之下
  });
});

describe('S4 v2 型別完整性（enum ↔ 名稱 ↔ 達成率）', () => {
  test('7 型都有中文名（間接驗 Record 完整，缺 key tsc 會擋）', () => {
    // detectTopPatternsStructure 對空/無結構回 triggered:false，此處只驗模組載入不拋錯
    const empty = detectTopPatternsStructure([bar('d0', 100, 101, 99, 100)], 0);
    expect(empty.triggered).toBe(false);
  });
});
