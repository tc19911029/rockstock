import { collectCnStockCandidates, lookupCnStock } from '@/lib/cn-media/stockMaster';
import type { CnStockMasterEntry } from '@/lib/cn-media/types';

const master: CnStockMasterEntry[] = [
  { code: '600519', symbol: '600519.SS', name: '贵州茅台', exchange: 'SSE', industry: '白酒', aliases: ['茅台'] },
  { code: '300750', symbol: '300750.SZ', name: '宁德时代', exchange: 'SZSE', industry: '電池', aliases: ['宁王', '寧王'] },
  { code: '688981', symbol: '688981.SS', name: '中芯国际', exchange: 'SSE', industry: '半導體', aliases: ['中芯'] },
];

describe('陸股名稱與代號對照', () => {
  test('精確代號與市場別', () => {
    expect(lookupCnStock('600519', master)).toEqual(expect.objectContaining({
      code: '600519', name: '贵州茅台', market: 'SSE', confidence: 1, match_via: 'exact_code',
    }));
  });

  test('支援常見簡稱與繁體別名', () => {
    expect(lookupCnStock('茅台', master)?.code).toBe('600519');
    expect(lookupCnStock('寧王', master)?.code).toBe('300750');
  });

  test('從逐字稿同時抓名稱與六位代號並去重', () => {
    const result = collectCnStockCandidates([
      '今天談贵州茅台與寧王，另外注意 688981 的先進製程。600519 不重複加入。',
    ], master);
    expect(result.map(item => item.code).sort()).toEqual(['300750', '600519', '688981']);
  });

  test('過短或不存在的模糊名稱不猜測', () => {
    expect(lookupCnStock('中', master)).toBeNull();
    expect(lookupCnStock('999999', master)).toBeNull();
  });
});
