/**
 * 融資壓力（輕量版）— 台股張數口徑 + 陸股金額口徑
 *
 * 守的是「融資成本回推」與「斷頭/追繳價倍數」兩件事：
 *   台股：追繳 = 成本 × 成數 0.6 × 1.3（→ 0.78×）、警戒 × 1.4（→ 0.84×）、解除追繳 × 1.66
 *   陸股：平倉 = 成本 × 0.5 × 1.3（→ 0.65×）、警戒 × 1.5（→ 0.75×）
 */

import { distanceToLiquidation } from '@/lib/chipcost/marginPressure';
import { computeMarginLongCosts } from '@/lib/chipcost/marginLongCost';
import {
  marginLiquidationPrice,
  MARGIN_CALL_MAINTENANCE,
  MARGIN_RELEASE_MAINTENANCE,
  MARGIN_RATIO_LISTED,
  MARGIN_RATIO_OTC,
} from '@/lib/chipcost/marginLiquidationPrice';
import {
  computeCnMarginCost,
  cnLiquidationPrice,
  CN_MARGIN_PARAMS,
  CN_DEBT_RATIO,
} from '@/lib/chipcost/cnMarginPressure';
import { adjustMarginNetForExRights, exRightsMultiplier } from '@/lib/chipcost/exRightsAdjust';
import type { MarginDay, PriceDay } from '@/lib/squeeze/types';

function priceDay(date: string, vwap: number): PriceDay {
  return { date, open: vwap, high: vwap, low: vwap, close: vwap, volume: 1000, turnover: vwap * 1000, vwap };
}
function marginDay(date: string, marginNet: number): MarginDay {
  return { date, marginBalance: 10000, marginNet, shortBalance: 0, shortNet: 0, marginUtilRate: 0 };
}

describe('台股融資成本 + 追繳價', () => {
  const prices = [priceDay('2026-07-14', 100), priceDay('2026-07-15', 200), priceDay('2026-07-16', 300)];

  it('加權平均：只算融資增加的日子，減少日不進分母', () => {
    const margin = [
      marginDay('2026-07-14', 100),   // 100 張 @ 100
      marginDay('2026-07-15', 300),   // 300 張 @ 200
      marginDay('2026-07-16', -500),  // 淨回補 → 丟掉
    ];
    // (100×100 + 300×200) / 400 = 175
    expect(computeMarginLongCosts(margin, prices).d5).toBe(175);
  });

  it('全期間都是淨減少 → 回 null（不顯示這行）', () => {
    const margin = [marginDay('2026-07-14', -10), marginDay('2026-07-15', -20)];
    expect(computeMarginLongCosts(margin, prices).d5).toBeNull();
  });

  it('成數 0.6：追繳 = 0.78×成本、警戒 = 0.84×成本、解除追繳 = 0.996×成本', () => {
    expect(marginLiquidationPrice(100, MARGIN_RATIO_LISTED)).toBe(78);
    expect(marginLiquidationPrice(100, MARGIN_RATIO_LISTED, MARGIN_CALL_MAINTENANCE)).toBe(84);
    expect(marginLiquidationPrice(100, MARGIN_RATIO_LISTED, MARGIN_RELEASE_MAINTENANCE)).toBe(99.6);
  });

  // 金管會令（103.11.10 生效）：上市及上櫃最高融資比率同為六成。
  // 舊制上櫃 50% 已廢止 — 這條測試守住不要改回去。
  it('上櫃成數與上市相同（都是 0.6）', () => {
    expect(MARGIN_RATIO_OTC).toBe(MARGIN_RATIO_LISTED);
    expect(MARGIN_RATIO_OTC).toBe(0.6);
    expect(marginLiquidationPrice(100, MARGIN_RATIO_OTC)).toBe(78);
  });

  it('成本算不出來 → 追繳價也是 null', () => {
    expect(marginLiquidationPrice(null)).toBeNull();
    expect(marginLiquidationPrice(0)).toBeNull();
  });
});

describe('距追繳價 %', () => {
  it('現價在追繳價之上 → 正值（還要跌這麼多）', () => {
    expect(distanceToLiquidation(100, 78)).toBe(22);
  });
  it('現價已跌破追繳價 → 負值', () => {
    expect(distanceToLiquidation(70, 78)).toBeCloseTo(-11.43, 2);
  });
  it('無追繳價或無收盤 → null', () => {
    expect(distanceToLiquidation(100, null)).toBeNull();
    expect(distanceToLiquidation(0, 78)).toBeNull();
  });
});

describe('陸股融資成本（餘額元 → 股數）', () => {
  const prices = [
    { date: '2026-07-14', close: 100, vwap: 100 },
    { date: '2026-07-15', close: 200, vwap: 200 },
    { date: '2026-07-16', close: 150, vwap: 150 },
  ];

  it('餘額差分 ÷ 當日均價換成股數後加權', () => {
    const balances = [
      { date: '2026-07-14', rzYe: 0 },
      { date: '2026-07-15', rzYe: 20_000 },   // +20000 元 ÷ 200 = 100 股 @ 200
      { date: '2026-07-16', rzYe: 65_000 },   // +45000 元 ÷ 150 = 300 股 @ 150
    ];
    // (100×200 + 300×150) / 400 = 162.5
    expect(computeCnMarginCost(balances, prices)).toBe(162.5);
  });

  it('餘額只減不增 → null', () => {
    const balances = [
      { date: '2026-07-14', rzYe: 100_000 },
      { date: '2026-07-15', rzYe: 80_000 },
      { date: '2026-07-16', rzYe: 50_000 },
    ];
    expect(computeCnMarginCost(balances, prices)).toBeNull();
  });

  it('只有一筆餘額（無法差分）→ null', () => {
    expect(computeCnMarginCost([{ date: '2026-07-14', rzYe: 100_000 }], prices)).toBeNull();
  });

  it('負債比例 0.5：平倉 = 0.65×成本、警戒 = 0.75×成本', () => {
    expect(CN_DEBT_RATIO).toBe(0.5);
    expect(cnLiquidationPrice(100, CN_MARGIN_PARAMS.liquidationMaintenance)).toBe(65);
    expect(cnLiquidationPrice(100, CN_MARGIN_PARAMS.warningMaintenance)).toBe(75);
    expect(cnLiquidationPrice(null, CN_MARGIN_PARAMS.liquidationMaintenance)).toBeNull();
  });
});

// ── 除權（股票股利）造成的假融資增加 ─────────────────────────────────────────
describe('除權修正 adjustMarginNetForExRights', () => {
  // 真實案例：3081 聯亞 2026-07-15 除權，股票股利 1 元（每千股配 100 股）
  //   07-14 餘額 4468 → 除權基準 4468×1.1 = 4915
  //   07-15 餘額 4621，檔案記 marginNet +153（假加碼），真實是 −294（減碼）
  const margin: MarginDay[] = [
    { date: '2026-07-14', marginBalance: 4468, marginNet: -229, shortBalance: 0, shortNet: 0, marginUtilRate: 19 },
    { date: '2026-07-15', marginBalance: 4621, marginNet: 153, shortBalance: 0, shortNet: 0, marginUtilRate: 20 },
  ];

  it('配股率換算：1 元股票股利 = ×1.1', () => {
    expect(exRightsMultiplier(1)).toBeCloseTo(1.1, 10);
    expect(exRightsMultiplier(0)).toBe(1);
    expect(exRightsMultiplier(2)).toBeCloseTo(1.2, 10);
  });

  it('除權日的假加碼被修正成真實減碼', () => {
    const out = adjustMarginNetForExRights(margin, [{ date: '2026-07-15', stockDividend: 1 }]);
    expect(out[1].marginNet).toBe(-294);
    expect(out[0].marginNet).toBe(-229);          // 非除權日不動
    expect(out[1].marginBalance).toBe(4621);      // 餘額不動，只改淨變化
  });

  it('沒有除權事件 / 純現金股利 → 原樣回傳', () => {
    expect(adjustMarginNetForExRights(margin, [])).toBe(margin);
    expect(adjustMarginNetForExRights(margin, [{ date: '2026-07-15', stockDividend: 0 }])).toBe(margin);
  });

  it('除權日是第一筆（沒有前一日可比）→ 不動', () => {
    const out = adjustMarginNetForExRights(margin, [{ date: '2026-07-14', stockDividend: 1 }]);
    expect(out[0].marginNet).toBe(-229);
  });

  it('修正後成本會被拉高（假加碼發生在除權後的低價）', () => {
    const prices = [priceDay('2026-07-14', 1925), priceDay('2026-07-15', 1787)];
    const before = computeMarginLongCosts(margin, prices).d5;
    const after = computeMarginLongCosts(
      adjustMarginNetForExRights(margin, [{ date: '2026-07-15', stockDividend: 1 }]),
      prices,
    ).d5;
    expect(before).toBe(1787);   // 只有 07-15 是正的 → 成本被釘在除權後低價
    expect(after).toBeNull();    // 修正後兩天都是減碼 → 這個窗口沒有新建立部位
  });
});
