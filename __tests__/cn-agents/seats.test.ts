/**
 * 陸股 Agent P2 — 席位貼標 lookupSeat 單元測試（純 fixture，零 IO）
 *
 * 覆蓋重點：
 *   deptCode 精確匹配優先於 namePattern / deptCode='0' 不可當主鍵 /
 *   namePattern 陣列序先列先贏 / 內建規則（机构专用·沪深股通·拉萨）/ unknown fallback /
 *   seed 結構完整性（每條至少一個匹配鍵 + label + type）
 */

import { lookupSeat, SEAT_REGISTRY_SEED } from '@/lib/cn-agents/seats';
import type { SeatRegistryFile } from '@/lib/cn-agents/types';
import { CN_AGENTS_SCHEMA_VERSION } from '@/lib/cn-agents/types';

function reg(seats: SeatRegistryFile['seats']): SeatRegistryFile {
  return { schemaVersion: CN_AGENTS_SCHEMA_VERSION, updatedAt: '2026-06-13T00:00:00.000Z', seats };
}

describe('lookupSeat 優先序', () => {
  test('deptCode 精確匹配優先於 namePattern（即使 namePattern 也命中）', () => {
    const registry = reg([
      { namePattern: '上海江苏路证券营业部', label: '章盟主', type: 'hot_money' },
      { deptCode: '10634999', label: '某量化（碼優先）', type: 'quant' },
    ]);
    // 名稱同時命中章盟主 pattern，但 deptCode 精確匹配先贏
    expect(lookupSeat('10634999', '国泰海通证券股份有限公司上海江苏路证券营业部', registry))
      .toEqual({ type: 'quant', label: '某量化（碼優先）' });
  });

  test("deptCode='0'（机构专用共用碼）不可進精確匹配 — 落到內建規則", () => {
    const registry = reg([
      { deptCode: '0', label: '錯誤條目不可被命中', type: 'hot_money' },
    ]);
    expect(lookupSeat('0', '机构专用', registry)).toEqual({ type: 'institution', label: null });
  });

  test('namePattern substring 陣列序先列先贏', () => {
    const registry = reg([
      { namePattern: '杭州延安路', label: '先列', type: 'hot_money' },
      { namePattern: '中信证券股份有限公司杭州延安路', label: '後列更長但不該贏', type: 'quant' },
    ]);
    expect(lookupSeat('12345678', '中信证券股份有限公司杭州延安路证券营业部', registry))
      .toEqual({ type: 'hot_money', label: '先列' });
  });

  test('內建規則：拉萨 → retail_proxy（東財導流營業部全中）', () => {
    expect(lookupSeat('10001234', '东方财富证券股份有限公司拉萨团结路第二证券营业部', reg([])).type)
      .toBe('retail_proxy');
    expect(lookupSeat('10005678', '东方财富证券股份有限公司拉萨东环路第一证券营业部', reg([])).type)
      .toBe('retail_proxy');
  });

  test('內建規則：机构专用 → institution；沪股通/深股通 → northbound', () => {
    expect(lookupSeat('0', '机构专用', reg([]))).toEqual({ type: 'institution', label: null });
    expect(lookupSeat('10634757', '深股通专用', reg([]))).toEqual({ type: 'northbound', label: null });
    expect(lookupSeat('10634756', '沪股通专用', reg([]))).toEqual({ type: 'northbound', label: null });
  });

  test('registry 命中優先於內建規則（拉薩條目若被使用者收進 registry，以 registry 為準）', () => {
    const registry = reg([
      { namePattern: '拉萨团结路', label: '拉薩主力一團', type: 'retail_proxy' },
    ]);
    expect(lookupSeat('10001234', '东方财富证券股份有限公司拉萨团结路第二证券营业部', registry))
      .toEqual({ type: 'retail_proxy', label: '拉薩主力一團' });
  });

  test('都沒中 → unknown / label null', () => {
    const registry = reg([{ namePattern: '上海溧阳路', label: '孙哥', type: 'hot_money' }]);
    expect(lookupSeat('99999999', '某某证券股份有限公司平凡小镇证券营业部', registry))
      .toEqual({ type: 'unknown', label: null });
  });
});

describe('SEAT_REGISTRY_SEED 結構', () => {
  test('每條 seed 至少有 deptCode 或 namePattern、label 非空、type 合法', () => {
    const validTypes = new Set(['hot_money', 'institution', 'retail_proxy', 'quant', 'northbound', 'unknown']);
    expect(SEAT_REGISTRY_SEED.length).toBeGreaterThanOrEqual(40);
    for (const s of SEAT_REGISTRY_SEED) {
      expect(Boolean(s.deptCode || s.namePattern)).toBe(true);
      expect(s.label.length).toBeGreaterThan(0);
      expect(validTypes.has(s.type)).toBe(true);
    }
  });

  test('知名游資命中例：章盟主（上海江蘇路）/ 孙哥（上海溧陽路）', () => {
    const registry = reg(SEAT_REGISTRY_SEED);
    expect(lookupSeat('80000001', '国泰海通证券股份有限公司上海江苏路证券营业部', registry))
      .toEqual({ type: 'hot_money', label: '章盟主' });
    expect(lookupSeat('80000002', '中信证券股份有限公司上海溧阳路证券营业部', registry))
      .toEqual({ type: 'hot_money', label: '孙哥' });
  });
});
