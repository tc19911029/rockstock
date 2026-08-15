import { collectCnStockCandidates, loadCnStockMaster, lookupCnStock } from '@/lib/cn-media/stockMaster';
import type { CnStockMasterEntry } from '@/lib/cn-media/types';

const master: CnStockMasterEntry[] = [
  { code: '600519', symbol: '600519.SS', name: '贵州茅台', exchange: 'SSE', industry: '白酒', aliases: ['茅台'] },
  { code: '300750', symbol: '300750.SZ', name: '宁德时代', exchange: 'SZSE', industry: '電池', aliases: ['宁王', '寧王'] },
  { code: '688981', symbol: '688981.SS', name: '中芯国际', exchange: 'SSE', industry: '半導體', aliases: ['中芯'] },
  { code: '600664', symbol: '600664.SS', name: '哈药股份', exchange: 'SSE', industry: '醫藥', aliases: ['哈药', '哈耀'] },
  { code: '600721', symbol: '600721.SS', name: '百花医药', exchange: 'SSE', industry: '醫藥', aliases: ['百花'] },
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
    expect(lookupCnStock('哈耀', master)?.code).toBe('600664');
    expect(lookupCnStock('百花', master)?.code).toBe('600721');
  });

  test('B站標題與語音辨識簡稱可進入候選', () => {
    const result = collectCnStockCandidates(['哈药卡异动，百花能否穿越；转录读成哈耀。'], master);
    expect(result.map(item => item.code).sort()).toEqual(['600664', '600721']);
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

  test('可唯一確認的節目口語錯字會映射正式股票', async () => {
    const fullMaster = await loadCnStockMaster();
    expect(lookupCnStock('中期续创', fullMaster)?.name).toBe('中际旭创');
    expect(lookupCnStock('新一胜', fullMaster)?.name).toBe('新易盛');
    expect(lookupCnStock('安季食品', fullMaster)?.name).toBe('安记食品');
    expect(lookupCnStock('爱立家居', fullMaster)?.name).toBe('爱丽家居');
    expect(lookupCnStock('亨通光线', fullMaster)?.name).toBe('亨通光电');
  });
});
