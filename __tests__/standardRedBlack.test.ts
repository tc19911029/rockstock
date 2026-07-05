// 課程 CH2-6 第1組「標準長紅長黑」— 高低點差不多、彼此沒過＝止漲（6組最弱，WATCH）。
// 重點測互斥讓位：達到吞噬/貫穿/母子/開高（遭遇覆蓋族）幾何時不可搶發。
import { standardRedBlackHigh } from '@/lib/rules/twoBarReversalRules';
import { gradeTrade } from '@/lib/portfolio/perfMetrics';
import type { CandleWithIndicators } from '@/types';

function bar(date: string, open: number, high: number, low: number, close: number): CandleWithIndicators {
  return { date, open, high, low, close, volume: 1000 } as unknown as CandleWithIndicators;
}

/** 上漲段前綴（滿足 isUptrendWave：高低點連續墊高）＋ 最後兩根自訂 */
function mkSeries(red: CandleWithIndicators, black: CandleWithIndicators): CandleWithIndicators[] {
  const pre: CandleWithIndicators[] = [];
  for (let k = 0; k < 8; k++) {
    const base = 90 + k * 1.5;
    pre.push(bar(`2026-01-${String(k + 1).padStart(2, '0')}`, base, base + 1, base - 1, base + 0.8));
  }
  return [...pre, red, black];
}

const RED = bar('2026-01-09', 100, 106, 99.5, 105); // 長紅 5%

describe('standardRedBlackHigh — CH2-6 第1組', () => {
  test('高低點差不多、彼此沒過 → 發 WATCH 止漲', () => {
    // 黑K高 106.2（探過紅高一點點、容差內）、低 99.4、收在紅實體上半 → 其他 5 組都不成立
    const black = bar('2026-01-10', 104.8, 106.2, 99.4, 100.5);
    const s = standardRedBlackHigh.evaluate(mkSeries(RED, black), 9);
    expect(s).not.toBeNull();
    expect(s!.type).toBe('WATCH');
  });

  test('整根被紅K包住 → 讓給母子，不發', () => {
    const black = bar('2026-01-10', 104.5, 105.5, 100.5, 101.5); // high<紅高 且 low>紅低
    expect(standardRedBlackHigh.evaluate(mkSeries(RED, black), 9)).toBeNull();
  });

  test('吞噬幾何（開高於紅收、收低於紅開）→ 讓給吞噬，不發', () => {
    const black = bar('2026-01-10', 105.5, 106.2, 99.4, 99.6); // open≥105 close≤100
    expect(standardRedBlackHigh.evaluate(mkSeries(RED, black), 9)).toBeNull();
  });

  test('收盤破紅K低 → 讓給貫穿，不發', () => {
    const black = bar('2026-01-10', 104.8, 106.2, 98.0, 98.5);
    expect(standardRedBlackHigh.evaluate(mkSeries(RED, black), 9)).toBeNull();
  });

  test('開盤高於紅K高 → 讓給遭遇/覆蓋族，不發', () => {
    const black = bar('2026-01-10', 106.5, 107, 100, 100.5);
    expect(standardRedBlackHigh.evaluate(mkSeries(RED, black), 9)).toBeNull();
  });
});

describe('gradeTrade — 直播 Q25 三級分類', () => {
  test('>10% 大賺、0~10% 小賺、0~-10% 小賠、≤-10% 大賠', () => {
    expect(gradeTrade(12)).toBe('big_win');
    expect(gradeTrade(7)).toBe('small_win');
    expect(gradeTrade(-6)).toBe('small_loss');
    expect(gradeTrade(-12)).toBe('big_loss');
  });
});
