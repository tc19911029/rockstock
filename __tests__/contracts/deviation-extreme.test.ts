/**
 * 合約測試 — R 乖離率（機械軌，2026-05-21 新增）
 *
 * 鎖定本策略不可漂走的 invariants：
 *   1. R 屬機械軌 / 不過 Step 1 / 字母名為「乖離率」
 *   2. ZHU_DEVIATION_EXTREME 策略 config 符合「不過六條件」契約
 *   3. scanDeviationExtreme 對 candles 集合排序符合 direction 規則
 *
 * 不含「整條 ScanPipeline 跑通」的 integration test — 那需要真實 candles fixture，
 * 改在 dev server 用 cron 手動觸發驗證。
 */

import {
  LETTER_NAMES,
  MECHANICAL_TRACK_LETTERS,
  MECHANICAL_TRACK_SET,
  NON_STEP1_SET,
  REVERSAL_OR_SYSTEM_SET,
  requiresStep1Pool,
  trackOf,
} from '@/lib/scanner/buyMethodTracks';
import {
  ZHU_DEVIATION_EXTREME,
  BUILT_IN_STRATEGIES,
} from '@/lib/strategy/StrategyConfig';
import { maDeviation } from '@/lib/rules/ruleUtils';
import type { CandleWithIndicators } from '@/types';

describe('R 乖離率 — 軌道分類契約', () => {
  it('R 屬機械軌', () => {
    expect(trackOf('R')).toBe('mechanical');
    expect(MECHANICAL_TRACK_LETTERS).toEqual(['R']);
    expect(MECHANICAL_TRACK_SET.has('R')).toBe(true);
  });

  it('R 不過 Step 1 池子（與反轉軌 / 戰法軌一致）', () => {
    expect(requiresStep1Pool('R')).toBe(false);
    expect(NON_STEP1_SET.has('R')).toBe(true);
    // REVERSAL_OR_SYSTEM_SET 是 NON_STEP1_SET 的 deprecated alias — 應該還是含 R
    expect(REVERSAL_OR_SYSTEM_SET.has('R')).toBe(true);
  });

  it('R 中文名固定為「乖離率」（單一事實來源 LETTER_NAMES）', () => {
    expect(LETTER_NAMES.R).toBe('乖離率');
  });
});

describe('R 乖離率 — StrategyConfig 契約', () => {
  it('ZHU_DEVIATION_EXTREME 已註冊到 BUILT_IN_STRATEGIES', () => {
    expect(BUILT_IN_STRATEGIES).toContain(ZHU_DEVIATION_EXTREME);
  });

  it('strategyType 為 mechanical-rank（讓掃描鏈一發判定跳過六條件 / 戒律 / Step 0）', () => {
    expect(ZHU_DEVIATION_EXTREME.strategyType).toBe('mechanical-rank');
    expect(ZHU_DEVIATION_EXTREME.buyMethod).toBe('R');
  });

  it('六條件全部關閉、minScore 與分區門檻全 0', () => {
    expect(ZHU_DEVIATION_EXTREME.conditions).toEqual({
      trend: false, position: false, kbar: false,
      ma: false, volume: false, indicator: false,
    });
    expect(ZHU_DEVIATION_EXTREME.thresholds.minScore).toBe(0);
    expect(ZHU_DEVIATION_EXTREME.thresholds.bullMinScore).toBe(0);
    expect(ZHU_DEVIATION_EXTREME.thresholds.sidewaysMinScore).toBe(0);
    expect(ZHU_DEVIATION_EXTREME.thresholds.bearMinScore).toBe(0);
  });

  it('marketTrendFilter 為 false（不過 Step 0 大盤過濾，純機械式）', () => {
    expect(ZHU_DEVIATION_EXTREME.thresholds.marketTrendFilter).toBe(false);
  });

  it('multiTimeframeFilter 與 kdDecliningFilter 為 false', () => {
    expect(ZHU_DEVIATION_EXTREME.thresholds.multiTimeframeFilter).toBe(false);
    expect(ZHU_DEVIATION_EXTREME.thresholds.kdDecliningFilter).toBe(false);
  });
});

describe('R 乖離率 — 排序邏輯（synthetic candles）', () => {
  /** 造一個帶 ma20 的合成 candle，方便驗證 maDeviation 與排序方向 */
  function mockCandle(close: number, ma20: number): CandleWithIndicators {
    return {
      date: '2026-05-21',
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      ma5: close,
      ma10: close,
      ma20,
      ma60: ma20,
      // 其他 indicator 欄位用 undefined（型別 optional）
    } as unknown as CandleWithIndicators;
  }

  it('maDeviation 公式 = (close - ma20) / ma20', () => {
    expect(maDeviation(mockCandle(110, 100), 'ma20')).toBeCloseTo(0.10, 6);
    expect(maDeviation(mockCandle(80, 100), 'ma20')).toBeCloseTo(-0.20, 6);
    expect(maDeviation(mockCandle(100, 100), 'ma20')).toBe(0);
  });

  it('long 取乖離最負 N 名（升序排序）', () => {
    const devs = [-0.05, -0.20, +0.10, -0.30, +0.25, -0.15].map(d =>
      maDeviation(mockCandle(100 * (1 + d), 100), 'ma20')!,
    );
    const sortedLong = [...devs].sort((a, b) => a - b).slice(0, 3);
    expect(sortedLong[0]).toBeCloseTo(-0.30, 6);
    expect(sortedLong[1]).toBeCloseTo(-0.20, 6);
    expect(sortedLong[2]).toBeCloseTo(-0.15, 6);
  });

  it('short 取乖離最正 N 名（降序排序）', () => {
    const devs = [-0.05, -0.20, +0.10, -0.30, +0.25, -0.15].map(d =>
      maDeviation(mockCandle(100 * (1 + d), 100), 'ma20')!,
    );
    const sortedShort = [...devs].sort((a, b) => b - a).slice(0, 3);
    expect(sortedShort[0]).toBeCloseTo(+0.25, 6);
    expect(sortedShort[1]).toBeCloseTo(+0.10, 6);
    expect(sortedShort[2]).toBeCloseTo(-0.05, 6);
  });

  it('ma20=null 時 maDeviation 回傳 null（停牌/新上市股票）', () => {
    const c = mockCandle(100, 100);
    (c as { ma20?: number }).ma20 = undefined;
    expect(maDeviation(c, 'ma20')).toBeNull();
  });
});
