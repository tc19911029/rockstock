import { weightedCost, weightedShortCost } from '@/lib/squeeze/costEstimator';
import {
  marginLiquidationPrice,
  marginRatioForSymbol,
  MARGIN_CALL_MAINTENANCE,
} from '@/lib/chipcost/marginLiquidationPrice';
import { computeMarginLongCosts } from '@/lib/chipcost/marginLongCost';
import { computeInstCosts } from '@/lib/chipcost/instCost';
import { computeBrokerCosts, brokerCostStatus, BROKER_MIN_DAYS } from '@/lib/chipcost/brokerCost';
import { computeMainForceCompositeCosts } from '@/lib/chipcost/mainForceCost';
import type { MarginDay, SblDay, PriceDay } from '@/lib/squeeze/types';
import type { InstDay, BrokerDay } from '@/lib/chips/types';

// 共用：5 天「淨增 × VWAP」可手算的批次 → 加權成本 = 68000/600 = 113.33
const NETS = [100, 200, 0, 300, -50];
const VWAPS = [100, 110, 105, 120, 115];
const DATES = ['d1', 'd2', 'd3', 'd4', 'd5'];

function prices(vwaps: number[], dates = DATES): PriceDay[] {
  return dates.map((date, i) => ({
    date,
    open: vwaps[i], high: vwaps[i] + 2, low: vwaps[i] - 1, close: vwaps[i] + 1,
    volume: 1_000_000, turnover: vwaps[i] * 1_000_000, vwap: vwaps[i],
  }));
}

describe('weightedCost (shared primitive)', () => {
  it('is the same function as weightedShortCost (refactor kept alias)', () => {
    expect(weightedShortCost).toBe(weightedCost);
  });
  it('matches the hand-computed 113.33', () => {
    const lots = DATES.map((date, i) => ({ date, lots: NETS[i] }));
    const pm = new Map(DATES.map((d, i) => [d, VWAPS[i]]));
    expect(weightedCost(lots, pm)).toBeCloseTo(113.33, 1);
  });
});

describe('marginLiquidationPrice (#9 融資斷頭價)', () => {
  it('斷頭價(130%) = cost × 成數 × 1.3 → 上市 0.6 → 78', () => {
    expect(marginLiquidationPrice(100)).toBe(78);
  });
  it('追繳價(140%) = cost × 0.6 × 1.4 → 84', () => {
    expect(marginLiquidationPrice(100, 0.6, MARGIN_CALL_MAINTENANCE)).toBe(84);
  });
  it('上櫃成數 0.5 → 斷頭價 65', () => {
    expect(marginLiquidationPrice(100, 0.5)).toBe(65);
  });
  it('null / 0 / NaN → null', () => {
    expect(marginLiquidationPrice(null)).toBeNull();
    expect(marginLiquidationPrice(0)).toBeNull();
    expect(marginLiquidationPrice(NaN)).toBeNull();
  });
});

describe('marginRatioForSymbol', () => {
  it('.TWO（上櫃）→ 0.5', () => {
    expect(marginRatioForSymbol('5483.TWO')).toBe(0.5);
  });
  it('上市（無後綴或 .TW）→ 0.6', () => {
    expect(marginRatioForSymbol('3661')).toBe(0.6);
    expect(marginRatioForSymbol('2330.TW')).toBe(0.6);
  });
});

describe('computeMarginLongCosts (#5 融資成本)', () => {
  it('用 marginNet 正值日加權，d5 = 113.33', () => {
    const margin: MarginDay[] = DATES.map((date, i) => ({
      date, marginBalance: 1000, marginNet: NETS[i],
      shortBalance: 0, shortNet: 0, marginUtilRate: 0,
    }));
    const out = computeMarginLongCosts(margin, prices(VWAPS));
    expect(out.d5).toBeCloseTo(113.33, 1);
  });
  it('全為淨減/0 → null', () => {
    const margin: MarginDay[] = DATES.map((date) => ({
      date, marginBalance: 1000, marginNet: -10,
      shortBalance: 0, shortNet: 0, marginUtilRate: 0,
    }));
    expect(computeMarginLongCosts(margin, prices(VWAPS)).d5).toBeNull();
  });
});

describe('computeInstCosts (#1/#2/#3 法人成本)', () => {
  it('外資用 foreign 淨買加權；自營全賣 → null', () => {
    const inst: Array<{ date: string } & InstDay> = DATES.map((date, i) => ({
      date,
      foreign: NETS[i],
      trust: 50,
      dealer: -20,            // 全部賣超 → null
      total: NETS[i] + 30,
    }));
    const out = computeInstCosts(inst, prices(VWAPS));
    expect(out.foreign.d5).toBeCloseTo(113.33, 1);
    expect(out.trust.d5).toBeCloseTo(110, 1); // 全部 +50 → 等權平均 VWAP = (100+110+105+120+115)/5 = 110
    expect(out.dealer.d5).toBeNull();
  });
});

describe('computeBrokerCosts (#4 主力成本) + status', () => {
  it('用 netDifference 加權', () => {
    const broker: Array<{ date: string } & BrokerDay> = DATES.map((date, i) => ({
      date, netDifference: NETS[i], concentration: 5,
    }));
    expect(computeBrokerCosts(broker, prices(VWAPS)).d5).toBeCloseTo(113.33, 1);
  });
  it('status: 0=unavailable, <20=accumulating, ≥20=ok', () => {
    expect(brokerCostStatus(0)).toBe('unavailable');
    expect(brokerCostStatus(BROKER_MIN_DAYS - 1)).toBe('accumulating');
    expect(brokerCostStatus(BROKER_MIN_DAYS)).toBe('ok');
  });
});

describe('computeMainForceCompositeCosts (#4 主力綜合估算 fallback)', () => {
  it('主力綜合 = 外資+投信+自營 − 0.7×借券淨賣 − 0.5×融資淨增，加權 VWAP', () => {
    // 單日驗證：外資100 投信50 自營20 → 170；借券淨賣 10 → −7；融資淨增 40 → −20；綜合 = 143（>0）
    const inst = [{ date: 'd1', foreign: 100, trust: 50, dealer: 20, total: 170 }];
    const margin: MarginDay[] = [{ date: 'd1', marginBalance: 0, marginNet: 40, shortBalance: 0, shortNet: 0, marginUtilRate: 0 }];
    const sbl: SblDay[] = [{ date: 'd1', lendingBalance: 0, lendingNet: 10 }];
    const px: PriceDay[] = [{ date: 'd1', open: 200, high: 200, low: 200, close: 200, volume: 1, turnover: 200, vwap: 200 }];
    // 綜合>0 → 成本 = 該日 VWAP = 200
    expect(computeMainForceCompositeCosts(inst, margin, sbl, px).d5).toBeCloseTo(200, 1);
  });
  it('法人歷史為空 → null', () => {
    expect(computeMainForceCompositeCosts([], [], [], []).d20).toBeNull();
  });
});
