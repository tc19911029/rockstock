/**
 * CH5 選股補強偵測器單元測試
 *   底部③（反彈站月線橫盤突破）+ 強勢飆股第二波
 * 直接建構帶明確 ma 欄位的 K 棒，精準控制型態成立/不成立。
 */

import {
  reboundHoldMA20Breakout,
  strongSurgeSecondWave,
} from '../lib/rules/ch5SelectionRules';
import type { CandleWithIndicators } from '../types';

function mk(
  i: number,
  o: number, h: number, l: number, close: number,
  ma: Partial<Pick<CandleWithIndicators, 'ma5' | 'ma10' | 'ma20' | 'ma60'>>,
  extra: Partial<CandleWithIndicators> = {},
): CandleWithIndicators {
  return {
    date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
    open: o, high: h, low: l, close,
    volume: 1000,
    avgVol5: 1000,
    ...ma,
    ...extra,
  } as CandleWithIndicators;
}

// ── 底部③：反彈站月線橫盤突破 ─────────────────────────────────────────────
function buildRebound(): CandleWithIndicators[] {
  const arr: CandleWithIndicators[] = [];
  for (let i = 0; i <= 44; i++) {
    // ma20：先降（0..34）→ 平（35..41）→ 揚（42..44）
    let ma20: number;
    if (i <= 34) ma20 = 100 - i * 0.5;      // 100 → 83
    else if (i <= 41) ma20 = 83;            // 平
    else ma20 = 83 + (i - 41) * 0.4;        // 揚 → 84.2

    if (i <= 34) {
      // 下跌段，收在月線下
      arr.push(mk(i, ma20 - 5, ma20 - 4, ma20 - 6, ma20 - 5, { ma20 }));
    } else if (i === 35) {
      // 整理前一根：仍在月線下（反彈剛突破前）
      arr.push(mk(i, 80.2, 80.5, 79.5, 80, { ma20 }));
    } else if (i <= 43) {
      // 橫盤整理：站在月線上、小幅震盪
      arr.push(mk(i, 84, 85, 83, 84, { ma20 }));
    } else {
      // 今日：帶量長紅突破橫盤高 85
      arr.push(mk(i, 85, 89, 84.5, 88, { ma20 }, { volume: 1500 }));
    }
  }
  return arr;
}

// ── 飆股第二波 ──────────────────────────────────────────────────────────────
function buildSecondWave(): CandleWithIndicators[] {
  const arr: CandleWithIndicators[] = [];
  const ma = { ma5: 130, ma10: 128, ma20: 124, ma60: 110 };
  for (let i = 0; i <= 60; i++) {
    if (i === 12) {
      arr.push(mk(i, 101, 103, 100, 102, { ma5: 105, ma10: 104, ma20: 103, ma60: 100 })); // 前波低點 100
    } else if (i === 40) {
      arr.push(mk(i, 145, 150, 143, 148, { ma5: 140, ma10: 135, ma20: 128, ma60: 115 })); // 第一波高點 150
    } else if (i <= 39) {
      arr.push(mk(i, 118, 122, 116, 120, { ma5: 122, ma10: 120, ma20: 118, ma60: 108 }));
    } else if (i <= 59) {
      // 第一波後回檔不破月線（收 132 ≥ ma20 124），高點 ≤134
      const ma20 = 120 + (i - 40) * 0.2; // 緩升，ma20[60] 需 > ma20[55]
      arr.push(mk(i, 131, 134, 130, 132, { ma5: 130, ma10: 128, ma20, ma60: 110 }));
    } else {
      // 今日：帶量長紅、突破近 5 日高 134
      arr.push(mk(i, 134, 139, 133, 138, ma, { volume: 1500 }));
    }
  }
  return arr;
}

describe('底部③ 反彈站月線橫盤突破', () => {
  it('型態成立時觸發 BUY', () => {
    const arr = buildRebound();
    const sig = reboundHoldMA20Breakout.evaluate(arr, arr.length - 1);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe('BUY');
    expect(sig!.label).toContain('橫盤突破');
  });

  it('今日收黑（非長紅）不觸發', () => {
    const arr = buildRebound();
    const last = arr[arr.length - 1];
    last.open = 89; last.close = 84; // 收黑
    expect(reboundHoldMA20Breakout.evaluate(arr, arr.length - 1)).toBeNull();
  });

  it('今日量能不足（<1.3×）不觸發', () => {
    const arr = buildRebound();
    arr[arr.length - 1].volume = 1100; // < 1000*1.3
    expect(reboundHoldMA20Breakout.evaluate(arr, arr.length - 1)).toBeNull();
  });

  it('未突破橫盤高不觸發', () => {
    const arr = buildRebound();
    const last = arr[arr.length - 1];
    last.close = 84.6; last.high = 85; // ≤ rangeHigh 85
    expect(reboundHoldMA20Breakout.evaluate(arr, arr.length - 1)).toBeNull();
  });
});

describe('強勢飆股第二波', () => {
  it('凌厲第一波後回檔不破月線再起 → 觸發 WATCH', () => {
    const arr = buildSecondWave();
    const sig = strongSurgeSecondWave.evaluate(arr, arr.length - 1);
    expect(sig).not.toBeNull();
    expect(sig!.type).toBe('WATCH');
    expect(sig!.label).toContain('第二波');
  });

  it('第一波不夠凌厲（<30%）不觸發', () => {
    const arr = buildSecondWave();
    // 墊高前波低點（100→116）+ 壓低第一波高點（150→140），使整體漲幅 <30%
    arr[12].low = 116; arr[12].close = 118; arr[12].open = 117; arr[12].high = 119;
    arr[40].high = 140; arr[40].close = 138; arr[40].open = 136;
    expect(strongSurgeSecondWave.evaluate(arr, arr.length - 1)).toBeNull();
  });

  it('回檔曾跌破月線 → 不觸發', () => {
    const arr = buildSecondWave();
    arr[50].close = 100; // < ma20
    expect(strongSurgeSecondWave.evaluate(arr, arr.length - 1)).toBeNull();
  });

  it('非四線多排 → 不觸發', () => {
    const arr = buildSecondWave();
    arr[arr.length - 1].ma60 = 200; // 破壞多排
    expect(strongSurgeSecondWave.evaluate(arr, arr.length - 1)).toBeNull();
  });
});
