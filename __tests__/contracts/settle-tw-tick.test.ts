/**
 * Contract test：EOD settle TW 檔位守衛（2026-06-09）
 *
 * 背景：.TWO 盤後封存時 FinMind 被 402 熔斷缺席 → 落到 Yahoo/EODHD 的中間價（如 100-500 檔
 * 區間的 158.75），加上 0.5% 容差太鬆，把次檔位偽價封進 L1（全市場 ~半數受影響）。
 *
 * 守的規則：
 *   - twTick：真實成交價落在檔位網格；次檔位（中間價）判 invalid，snap 到最近檔位
 *   - reconcile 一致群優先挑「檔位合法」的收盤（合法 159 勝過中間價 158.75）
 *   - 殘值（全 vendor 都是中間價、FinMind 缺席）→ snap 最近檔位 + 標警，L1 永不寫次檔位偽價
 *   - CN 不套用（檔位規則不同）
 */

import { reconcile } from '@/lib/datasource/eodSettle';
import { isValidTwTick, snapTwTick, twTickSize, isTwEtf, isTwIndex } from '@/lib/datasource/twTick';

const q = (vendor: string, close: number, vol = 10) => ({
  vendor, open: close, high: close, low: close, close, volume: vol,
});

describe('twTick 工具', () => {
  test('檔位表分段', () => {
    expect(twTickSize(8)).toBe(0.01);
    expect(twTickSize(30)).toBe(0.05);
    expect(twTickSize(70)).toBe(0.1);
    expect(twTickSize(158)).toBe(0.5);
    expect(twTickSize(700)).toBe(1);
    expect(twTickSize(1500)).toBe(5);
  });

  test('isValidTwTick：合法檔位 vs 中間價', () => {
    expect(isValidTwTick(159)).toBe(true);
    expect(isValidTwTick(158.5)).toBe(true);
    expect(isValidTwTick(158.75)).toBe(false); // 100-500 檔位 0.5 的中間價
    expect(isValidTwTick(57.3)).toBe(true);
    expect(isValidTwTick(57.35)).toBe(false);  // 50-100 檔位 0.1 的中間價
    expect(isValidTwTick(272.25)).toBe(false);
    expect(isValidTwTick(0)).toBe(false);
  });

  test('snapTwTick：中間價 snap 到最近檔位（round-half-up）', () => {
    expect(snapTwTick(158.75)).toBe(159);
    expect(snapTwTick(57.35)).toBe(57.4);
    expect(snapTwTick(159)).toBe(159); // 已合法不變
  });

  test('ETF 檔位較細：同一價對 ETF 合法、對個股不合法（防誤 snap 0050）', () => {
    expect(isTwEtf('0050.TW')).toBe(true);
    expect(isTwEtf('00980A.TW')).toBe(true);
    expect(isTwEtf('1268.TWO')).toBe(false);
    expect(isValidTwTick(100.95, true)).toBe(true);   // ETF ≥50 → 0.05
    expect(isValidTwTick(100.95, false)).toBe(false);  // 個股 100-500 → 0.5
    expect(isValidTwTick(23.64, true)).toBe(true);     // ETF <50 → 0.01
    expect(isValidTwTick(23.64, false)).toBe(false);   // 個股 10-50 → 0.05
  });
});

describe('settle reconcile — TW 檔位守衛', () => {
  test('一致群優先挑檔位合法收盤（FinMind 159 勝中間價 Yahoo 158.75）', () => {
    const r = reconcile([q('FinMind', 159), q('Yahoo', 158.75)], 'TW');
    expect(r.settled?.close).toBe(159);
    expect(r.status).toBe('settled-multi-source');
    expect(r.warning).toBeUndefined();
  });

  test('全是中間價（FinMind 缺席）→ snap + 標警', () => {
    const r = reconcile([q('Yahoo', 158.75), q('L1-existing', 158.75)], 'TW');
    expect(r.settled?.close).toBe(159);
    expect(r.warning).toMatch(/snap/);
  });

  test('單一中間價來源 → snap + 標警', () => {
    const r = reconcile([q('Yahoo', 158.75)], 'TW');
    expect(r.settled?.close).toBe(159);
    expect(r.status).toBe('settled-single-source');
    expect(r.warning).toMatch(/snap/);
  });

  test('合法多源 → 原值、無警', () => {
    const r = reconcile([q('FinMind', 159), q('EODHD', 159)], 'TW');
    expect(r.settled?.close).toBe(159);
    expect(r.warning).toBeUndefined();
  });

  test('CN 不套用檔位守衛（次檔位值原樣保留）', () => {
    const r = reconcile([q('EastMoney', 12.345), q('Tencent', 12.345)], 'CN');
    expect(r.settled?.close).toBe(12.345);
    expect(r.warning).toBeUndefined();
  });

  test('ETF 不誤 snap（0050 的 100.95 是合法 ETF 價 → 原樣保留）', () => {
    const r = reconcile([q('FinMind', 100.95), q('Yahoo', 100.95)], 'TW', true);
    expect(r.settled?.close).toBe(100.95);
    expect(r.warning).toBeUndefined();
  });

  test('個股的 100.95 視為次檔位 → snap 101', () => {
    const r = reconcile([q('Yahoo', 100.95)], 'TW', false);
    expect(r.settled?.close).toBe(101);
    expect(r.warning).toMatch(/snap/);
  });
});

/**
 * 指數豁免（2026-07-23）：^TWII 是加權平均計算值不是撮合成交價，任何小數都合法。
 * 沒豁免會被當成「≥1000 元 → 檔位 5」，實案：2026-07-22 收盤 44,825.78 被 snap 成 44,825、
 * 開盤 44,513.75 被 snap 成 44,515（四價全變 5 的倍數）。
 */
describe('指數不套檔位守衛', () => {
  test('isTwIndex 認得 ^ 前綴', () => {
    expect(isTwIndex('^TWII')).toBe(true);
    expect(isTwIndex('2330.TW')).toBe(false);
    expect(isTwIndex('0050.TW')).toBe(false);
  });

  test('單源：44825.78 原樣保留、不 snap 成 44825', () => {
    const r = reconcile([q('Yahoo', 44825.78)], 'TW', false, true);
    expect(r.settled?.close).toBe(44825.78);
    expect(r.warning).toBeUndefined();
  });

  test('多源一致：OHLC 小數全保留', () => {
    const bar = { vendor: 'Yahoo', open: 44513.75, high: 45323.75, low: 44513.75, close: 44825.78, volume: 11296458 };
    const r = reconcile([bar, { ...bar, vendor: 'TWSE' }], 'TW', false, true);
    expect(r.settled?.open).toBe(44513.75);
    expect(r.settled?.high).toBe(45323.75);
    expect(r.settled?.close).toBe(44825.78);
    expect(r.warning).toBeUndefined();
  });

  test('isIndex=false 時同一根仍會被 snap（證明豁免真的有作用）', () => {
    const r = reconcile([q('Yahoo', 44825.78)], 'TW', false);
    expect(r.settled?.close).toBe(44825);
    expect(r.warning).toMatch(/snap/);
  });
});
