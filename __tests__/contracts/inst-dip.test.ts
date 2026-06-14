/**
 * 合約測試 — X 法人接刀（2026-06-14 新增）
 *
 * 鎖定不可漂走的 invariants（比照 W 大戶偷買 smart-money-dip.test.ts）：
 *   1. X 屬接刀軌 / 不過 Step 1 / 字母名為「法人接刀」
 *   2. ZHU_INST_DIP 策略 config 符合「不過六條件」契約
 *   3. lib/instdip 訊號：在跌/長黑 + 法人逆勢買 才 isHit（單一事實）
 */
import {
  LETTER_NAMES,
  INSTDIP_TRACK_LETTERS,
  INSTDIP_TRACK_SET,
  NON_STEP1_SET,
  requiresStep1Pool,
  trackOf,
} from '@/lib/scanner/buyMethodTracks';
import {
  ZHU_INST_DIP,
  BUILT_IN_STRATEGIES,
} from '@/lib/strategy/StrategyConfig';
import { evaluateAt, type Candle } from '@/lib/instdip/signal';
import { DEFAULT_PARAMS } from '@/lib/instdip/types';

describe('X 法人接刀 — 軌道分類契約', () => {
  it('X 屬接刀軌（instdip）', () => {
    expect(trackOf('X')).toBe('instdip');
    expect(INSTDIP_TRACK_LETTERS).toEqual(['X']);
    expect(INSTDIP_TRACK_SET.has('X')).toBe(true);
  });

  it('X 不過 Step 1 池子（比照 R / V / W）', () => {
    expect(requiresStep1Pool('X')).toBe(false);
    expect(NON_STEP1_SET.has('X')).toBe(true);
  });

  it('X 中文名固定為「法人接刀」（單一事實 LETTER_NAMES）', () => {
    expect(LETTER_NAMES.X).toBe('法人接刀');
  });
});

describe('X 法人接刀 — StrategyConfig 契約', () => {
  it('ZHU_INST_DIP 已註冊', () => {
    expect(BUILT_IN_STRATEGIES).toContain(ZHU_INST_DIP);
  });

  it('strategyType 沿用 mechanical-rank（跳過六條件/戒律/Step 0）', () => {
    expect(ZHU_INST_DIP.strategyType).toBe('mechanical-rank');
    expect(ZHU_INST_DIP.buyMethod).toBe('X');
  });

  it('六條件全關、各分區門檻 0、不過大盤/MTF/KD', () => {
    expect(ZHU_INST_DIP.conditions).toEqual({
      trend: false, position: false, kbar: false,
      ma: false, volume: false, indicator: false,
    });
    expect(ZHU_INST_DIP.thresholds.minScore).toBe(0);
    expect(ZHU_INST_DIP.thresholds.marketTrendFilter).toBe(false);
    expect(ZHU_INST_DIP.thresholds.multiTimeframeFilter).toBe(false);
    expect(ZHU_INST_DIP.thresholds.kdDecliningFilter).toBe(false);
  });
});

describe('X 法人接刀 — 訊號邏輯（lib/instdip 單一事實）', () => {
  // 在跌(近5日<-3%) 或 今日長黑(收/開-1<-3%)，且法人5日淨買超>0 → isHit
  function mk(closes: number[]): Candle[] {
    return closes.map((c, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`, open: c, close: c, volume: 1000,
    }));
  }

  it('近5日在跌 + 法人逆勢買 → isHit=true', () => {
    const candles = mk([110, 108, 106, 104, 102, 100]); // 近5日 -9%
    const inst = new Map(candles.map(c => [c.date, 200])); // 法人每天買 200
    const ev = evaluateAt(candles, inst, candles.length - 1, DEFAULT_PARAMS);
    expect(ev?.isHit).toBe(true);
    expect(ev!.isWeak).toBe(true);
    expect(ev!.instBuy).toBe(true);
  });

  it('今日長黑 + 法人逆勢買 → isHit=true（即使近5日沒跌很多）', () => {
    // 價格平盤，但今日開高收低（長黑 -5%）
    const candles: Candle[] = [100, 100, 100, 100, 100].map((c, i) => ({
      date: `2026-05-0${i + 1}`, open: c, close: c, volume: 1000,
    }));
    candles.push({ date: '2026-05-06', open: 100, close: 95, volume: 1000 }); // 收/開-1 = -5%
    const inst = new Map(candles.map(c => [c.date, 150]));
    const ev = evaluateAt(candles, inst, candles.length - 1, DEFAULT_PARAMS);
    expect(ev?.todayChg).toBeLessThan(-3);
    expect(ev?.isHit).toBe(true);
  });

  it('在跌但法人在賣（沒接刀）→ isHit=false', () => {
    const candles = mk([110, 108, 106, 104, 102, 100]);
    const inst = new Map(candles.map(c => [c.date, -200])); // 法人在賣
    const ev = evaluateAt(candles, inst, candles.length - 1, DEFAULT_PARAMS);
    expect(ev?.instBuy).toBe(false);
    expect(ev?.isHit).toBe(false);
  });

  it('法人大買但股價在漲又非長黑 → isHit=false（沒有恐慌可買）', () => {
    const candles = mk([100, 102, 104, 106, 108, 110]); // 一路漲，open=close 非長黑
    const inst = new Map(candles.map(c => [c.date, 200]));
    const ev = evaluateAt(candles, inst, candles.length - 1, DEFAULT_PARAMS);
    expect(ev?.isWeak).toBe(false);
    expect(ev?.isHit).toBe(false);
  });
});
