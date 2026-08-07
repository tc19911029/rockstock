import {
  detectIndustryTemplate,
  getReasonablePeRange,
  getTemplateLabel,
  INDUSTRY_PE_RANGE,
} from '@/lib/valuation/industryTemplate';

describe('valuation/industryTemplate', () => {
  it('detects high_growth_asic (IC 設計 / 設計服務 / ASIC 關鍵字)', () => {
    expect(detectIndustryTemplate('IC設計')).toBe('high_growth_asic');
    expect(detectIndustryTemplate('其他電子業 - 設計服務')).toBe('high_growth_asic');
    expect(detectIndustryTemplate('ASIC 設計')).toBe('high_growth_asic');
  });

  // 2026-06-03 (commit e3fd68d)：裸「半導體業」不再 blanket → high_growth_asic
  // （TWSE 對所有半導體股都只回「半導體業」，blanket PE50 會把威剛/南亞科等循環/成熟股灌爆）。
  // 半導體細分改走 SEMI_SYMBOL_TEMPLATE symbol 級白名單；未列入者落回 'other'。
  it('routes 半導體業 by symbol whitelist, not blanket high_growth_asic', () => {
    // 裸產業字串、無 symbol → 落回 other（中性 PE），不再預設高成長
    expect(detectIndustryTemplate('半導體業')).toBe('other');
    // 真·高成長：晶圓代工龍頭 / IC 設計 / ASIC / IP
    expect(detectIndustryTemplate('半導體業', '2330')).toBe('high_growth_asic'); // 台積電
    expect(detectIndustryTemplate('半導體業', '3661')).toBe('high_growth_asic'); // 世芯-KY (ASIC)
    // DRAM / 記憶體模組 → 景氣循環（威剛/南亞科不再被灌成 PE50）
    expect(detectIndustryTemplate('半導體業', '2408')).toBe('cyclical'); // 南亞科 (DRAM)
    expect(detectIndustryTemplate('半導體業', '3260')).toBe('cyclical'); // 威剛 (DRAM 模組)
    // 成熟代工 / 封測 → 穩定成熟
    expect(detectIndustryTemplate('半導體業', '2303')).toBe('stable_mature'); // 聯電 (成熟代工)
    expect(detectIndustryTemplate('半導體業', '3711')).toBe('stable_mature'); // 日月光投控 (封測)
    // 白名單外的半導體股 → other
    expect(detectIndustryTemplate('半導體業', '9999')).toBe('other');
    // symbol 後綴會被去除再比對
    expect(detectIndustryTemplate('半導體業', '2330.TW')).toBe('high_growth_asic');
  });

  it('routes the current TW/CN holdings to their business-model templates', () => {
    expect(detectIndustryTemplate('半導體業', '3006.TW')).toBe('cyclical');
    expect(detectIndustryTemplate('半導體業', '6770.TW')).toBe('stable_mature');
    expect(detectIndustryTemplate('光電業', '3081.TWO')).toBe('hype_extreme_growth');
    expect(detectIndustryTemplate(undefined, '000988.SZ')).toBe('high_growth_asic');
    expect(detectIndustryTemplate(undefined, '001309.SZ')).toBe('cyclical');
    expect(detectIndustryTemplate(undefined, '603986.SS')).toBe('cyclical');
  });

  it('detects cyclical', () => {
    expect(detectIndustryTemplate('面板')).toBe('cyclical');
    expect(detectIndustryTemplate('航運業')).toBe('cyclical');
    expect(detectIndustryTemplate('記憶體')).toBe('cyclical');
    expect(detectIndustryTemplate('鋼鐵')).toBe('cyclical');
  });

  it('detects distributor', () => {
    expect(detectIndustryTemplate('電子通路業')).toBe('distributor');
  });

  it('detects advanced_material', () => {
    expect(detectIndustryTemplate('電子零組件業')).toBe('advanced_material');
    expect(detectIndustryTemplate('PCB')).toBe('advanced_material');
  });

  it('detects stable_mature (金融保險 / 電信 / 公用)', () => {
    expect(detectIndustryTemplate('金融保險')).toBe('stable_mature');
    expect(detectIndustryTemplate('銀行')).toBe('stable_mature');
    expect(detectIndustryTemplate('電信')).toBe('stable_mature');
  });

  it('detects consumer_pharma_leader', () => {
    expect(detectIndustryTemplate('生技醫療')).toBe('consumer_pharma_leader');
    expect(detectIndustryTemplate('白酒')).toBe('consumer_pharma_leader');
  });

  it('falls back to other', () => {
    expect(detectIndustryTemplate('xx 不存在產業')).toBe('other');
    expect(detectIndustryTemplate(null)).toBe('other');
    expect(detectIndustryTemplate('')).toBe('other');
  });

  it('PE ranges follow asc order (pessimistic < base < optimistic)', () => {
    for (const range of Object.values(INDUSTRY_PE_RANGE)) {
      expect(range.pessimistic).toBeLessThan(range.base);
      expect(range.base).toBeLessThan(range.optimistic);
    }
  });

  it('getReasonablePeRange returns the mapped range', () => {
    const r = getReasonablePeRange('high_growth_asic');
    expect(r.pessimistic).toBe(40);
    expect(r.base).toBe(50);
    expect(r.optimistic).toBe(60);
  });

  it('getTemplateLabel returns Chinese label', () => {
    expect(getTemplateLabel('high_growth_asic')).toBe('高成長 ASIC / AI 半導體');
    expect(getTemplateLabel('cyclical')).toBe('景氣循環股');
  });
});
