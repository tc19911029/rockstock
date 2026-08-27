/**
 * 合約測試 — Y 法人偷買(原)（2026-06-14 新增）
 *
 * 鎖定不可漂走的 invariants（比照 W 大戶偷買 / X 法人接刀）：
 *   1. Y 屬偷買(原)軌（inststeal）/ 不過 Step 1 / 字母名為「法人偷買(原)」
 *   2. ZHU_INST_STEAL 策略 config 符合「不過六條件」契約
 *   3. lib/inststeal 訊號：跌 + 5日集中度在增加 + 法人連買，三個同時成立才 isHit（單一事實）
 */
import {
  LETTER_NAMES,
  INSTSTEAL_TRACK_LETTERS,
  INSTSTEAL_TRACK_SET,
  NON_STEP1_SET,
  requiresStep1Pool,
  trackOf,
} from '@/lib/scanner/buyMethodTracks';
import {
  ZHU_INST_STEAL,
  BUILT_IN_STRATEGIES,
} from '@/lib/strategy/StrategyConfig';
import { evaluateAt, type Candle } from '@/lib/inststeal/signal';
import { DEFAULT_PARAMS } from '@/lib/inststeal/types';

describe('Y 法人偷買(原) — 軌道分類契約', () => {
  it('Y 屬偷買(原)軌（inststeal）', () => {
    expect(trackOf('Y')).toBe('inststeal');
    expect(INSTSTEAL_TRACK_LETTERS).toEqual(['Y']);
    expect(INSTSTEAL_TRACK_SET.has('Y')).toBe(true);
  });

  it('Y 不過 Step 1 池子（比照 R / V / W / X）', () => {
    expect(requiresStep1Pool('Y')).toBe(false);
    expect(NON_STEP1_SET.has('Y')).toBe(true);
  });

  it('Y 中文名固定為「大戶法人偷買」（單一事實 LETTER_NAMES）', () => {
    expect(LETTER_NAMES.Y).toBe('大戶法人偷買');
  });
});

describe('Y 法人偷買(原) — StrategyConfig 契約', () => {
  it('ZHU_INST_STEAL 已註冊', () => {
    expect(BUILT_IN_STRATEGIES).toContain(ZHU_INST_STEAL);
  });

  it('strategyType 沿用 mechanical-rank（跳過六條件/戒律/Step 0）', () => {
    expect(ZHU_INST_STEAL.strategyType).toBe('mechanical-rank');
    expect(ZHU_INST_STEAL.buyMethod).toBe('Y');
  });

  it('六條件全關、各分區門檻 0、不過大盤/MTF/KD', () => {
    expect(ZHU_INST_STEAL.conditions).toEqual({
      trend: false, position: false, kbar: false,
      ma: false, volume: false, indicator: false,
    });
    expect(ZHU_INST_STEAL.thresholds.minScore).toBe(0);
    expect(ZHU_INST_STEAL.thresholds.marketTrendFilter).toBe(false);
    expect(ZHU_INST_STEAL.thresholds.multiTimeframeFilter).toBe(false);
    expect(ZHU_INST_STEAL.thresholds.kdDecliningFilter).toBe(false);
  });
});

describe('Y 法人偷買(原) — 訊號邏輯（lib/inststeal 單一事實）', () => {
  // 25 根日K，前 20 根平盤，最後 5 根 105→100（近5日 -4.8% 在跌）
  function dates(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')}`);
  }
  function candlesFalling(): Candle[] {
    const ds = dates(25);
    return ds.map((date, i) => ({
      date,
      close: i < 20 ? 105 : 105 - (i - 19), // i=20→104 ... i=24→100
      volume: 1000,
    }));
  }
  function candlesFlat(): Candle[] {
    return dates(25).map(date => ({ date, close: 105, volume: 1000 }));
  }
  // 集中度由小變大：前段每日 +5（≈0.5%）、近段每日 +50（≈5%）→ 在爬
  function brokerRising(cs: Candle[]): Map<string, number> {
    return new Map(cs.map((c, i) => [c.date, i < 20 ? 5 : 50]));
  }
  // 集中度持平（不爬）：每日 +5
  function brokerFlat(cs: Candle[]): Map<string, number> {
    return new Map(cs.map(c => [c.date, 5]));
  }
  const t = (cs: Candle[]) => cs.length - 1;

  it('跌 + 集中度在爬 + 法人連買 → isHit=true', () => {
    const cs = candlesFalling();
    const inst = new Map(cs.map(c => [c.date, 100])); // 法人天天買
    const ev = evaluateAt(cs, brokerRising(cs), inst, t(cs), DEFAULT_PARAMS);
    expect(ev?.isDropping).toBe(true);
    expect(ev?.isConcRising).toBe(true);
    expect(ev?.isInstBuying).toBe(true);
    expect(ev?.isHit).toBe(true);
  });

  it('集中度沒在爬（持平）→ isHit=false', () => {
    const cs = candlesFalling();
    const inst = new Map(cs.map(c => [c.date, 100]));
    const ev = evaluateAt(cs, brokerFlat(cs), inst, t(cs), DEFAULT_PARAMS);
    expect(ev?.isConcRising).toBe(false);
    expect(ev?.isHit).toBe(false);
  });

  it('法人在賣（沒連買）→ isHit=false', () => {
    const cs = candlesFalling();
    const inst = new Map(cs.map(c => [c.date, -100]));
    const ev = evaluateAt(cs, brokerRising(cs), inst, t(cs), DEFAULT_PARAMS);
    expect(ev?.isInstBuying).toBe(false);
    expect(ev?.isHit).toBe(false);
  });

  it('股價沒在跌（平盤）→ isHit=false', () => {
    const cs = candlesFlat();
    const inst = new Map(cs.map(c => [c.date, 100]));
    const ev = evaluateAt(cs, brokerRising(cs), inst, t(cs), DEFAULT_PARAMS);
    expect(ev?.isDropping).toBe(false);
    expect(ev?.isHit).toBe(false);
  });

  it('正式 Yahoo 近似模式任一視窗缺日就不評估，走圖容缺模式仍可呈現', () => {
    const cs = candlesFalling();
    const inst = new Map(cs.map(c => [c.date, 100]));
    const broker = brokerRising(cs);
    broker.delete(cs[18].date);
    expect(evaluateAt(cs, broker, inst, t(cs), DEFAULT_PARAMS)).not.toBeNull();
    expect(evaluateAt(cs, broker, inst, t(cs), DEFAULT_PARAMS, undefined, false, 1)).toBeNull();
  });
});
