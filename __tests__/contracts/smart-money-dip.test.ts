/**
 * 合約測試 — W 大戶偷買（籌碼集中度軌，2026-06-13 新增）
 *
 * 鎖定不可漂走的 invariants（比照 R 乖離率 deviation-extreme.test.ts）：
 *   1. W 屬大戶軌 / 不過 Step 1 / 字母名為「大戶偷買」
 *   2. ZHU_SMART_MONEY_DIP 策略 config 符合「不過六條件」契約
 *   3. lib/smartmoney 訊號（refined）：主力分點20日集中度由負轉正 + 濾隔日沖 + 不爆量才 isHit
 *   4. W 不可與已移除的舊 S 軌（TDCC 大戶累積，無 alpha）混淆 — W 用主力分點(前15大券商)買賣超
 */

import {
  LETTER_NAMES,
  SMARTMONEY_TRACK_LETTERS,
  SMARTMONEY_TRACK_SET,
  NON_STEP1_SET,
  requiresStep1Pool,
  trackOf,
} from '@/lib/scanner/buyMethodTracks';
import {
  ZHU_SMART_MONEY_DIP,
  BUILT_IN_STRATEGIES,
} from '@/lib/strategy/StrategyConfig';
import { evaluateAt, type Candle } from '@/lib/smartmoney/signal';
import { DEFAULT_PARAMS } from '@/lib/smartmoney/types';

describe('W 大戶偷買 — 軌道分類契約', () => {
  it('W 屬大戶軌（smartmoney）', () => {
    expect(trackOf('W')).toBe('smartmoney');
    expect(SMARTMONEY_TRACK_LETTERS).toEqual(['W']);
    expect(SMARTMONEY_TRACK_SET.has('W')).toBe(true);
  });

  it('W 不過 Step 1 池子（比照 R / V）', () => {
    expect(requiresStep1Pool('W')).toBe(false);
    expect(NON_STEP1_SET.has('W')).toBe(true);
  });

  it('W 中文名固定為「大戶偷買」（單一事實 LETTER_NAMES）', () => {
    expect(LETTER_NAMES.W).toBe('大戶偷買');
  });
});

describe('W 大戶偷買 — StrategyConfig 契約', () => {
  it('ZHU_SMART_MONEY_DIP 已註冊', () => {
    expect(BUILT_IN_STRATEGIES).toContain(ZHU_SMART_MONEY_DIP);
  });

  it('strategyType 沿用 mechanical-rank（掃描鏈跳過六條件/戒律/Step 0）', () => {
    expect(ZHU_SMART_MONEY_DIP.strategyType).toBe('mechanical-rank');
    expect(ZHU_SMART_MONEY_DIP.buyMethod).toBe('W');
  });

  it('六條件全關、各分區門檻 0、不過大盤/MTF/KD', () => {
    expect(ZHU_SMART_MONEY_DIP.conditions).toEqual({
      trend: false, position: false, kbar: false,
      ma: false, volume: false, indicator: false,
    });
    expect(ZHU_SMART_MONEY_DIP.thresholds.minScore).toBe(0);
    expect(ZHU_SMART_MONEY_DIP.thresholds.marketTrendFilter).toBe(false);
    expect(ZHU_SMART_MONEY_DIP.thresholds.multiTimeframeFilter).toBe(false);
    expect(ZHU_SMART_MONEY_DIP.thresholds.kdDecliningFilter).toBe(false);
  });
});

describe('W 大戶偷買 — 訊號邏輯（lib/smartmoney 單一事實，refined）', () => {
  // refined 門檻：主力分點20日集中度「由負轉正」+ 落在[1,5]% + 5日<8(濾隔日沖) + 量比<1.8(不爆量)。
  // need = longWin(20)+turnBack(5) = 25 → 用 26 根、量固定 1000、評估在 t=25。
  const N = 26;
  function makeCandles(): Candle[] {
    return Array.from({ length: N }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      close: 100, volume: 1000,
    }));
  }
  /** 依「每根淨買賣超(張)」建主力分點 map。net[k] 對應第 k 根。 */
  function broker(net: (k: number) => number): Map<string, number> {
    const c = makeCandles();
    return new Map(c.map((x, k) => [x.date, net(k)]));
  }

  it('主力分點由負轉正 + 區間內 + 不隔日沖 + 不爆量 → isHit=true', () => {
    // 最舊5根(k1..5)=-40(壓低 prev 窗)、中間15根(k6..20)=+10、最新5根(k21..25)=+60
    // conc20=2.25% / conc20prev=-0.25% / conc5=6% / volRatio=1
    const net = (k: number) => (k >= 1 && k <= 5 ? -40 : k >= 6 && k <= 20 ? 10 : k >= 21 ? 60 : 0);
    const ev = evaluateAt(makeCandles(), broker(net), N - 1, DEFAULT_PARAMS);
    expect(ev?.isHit).toBe(true);
    expect(ev!.conc20).toBeGreaterThan(0);
    expect(ev!.conc20prev).toBeLessThanOrEqual(0);
    expect(ev!.conc5).toBeLessThan(8);
  });

  it('短線集中度爆高(隔日沖假象，conc5>8) → isHit=false', () => {
    // 最新5根狂買 200 → conc5=20% > shortMax(8) 被剔除
    const net = (k: number) => (k >= 1 && k <= 5 ? -40 : k >= 6 && k <= 20 ? 10 : k >= 21 ? 200 : 0);
    const ev = evaluateAt(makeCandles(), broker(net), N - 1, DEFAULT_PARAMS);
    expect(ev?.conc5).toBeGreaterThan(8);
    expect(ev?.isHit).toBe(false);
  });

  it('沒有「由負轉正」(prev 窗已是正) → isHit=false', () => {
    // 全程都正 → conc20prev > 0，不算剛開始偷買
    const net = (k: number) => (k >= 1 ? 30 : 0);
    const ev = evaluateAt(makeCandles(), broker(net), N - 1, DEFAULT_PARAMS);
    expect(ev?.conc20prev).toBeGreaterThan(0);
    expect(ev?.isHit).toBe(false);
  });
});
