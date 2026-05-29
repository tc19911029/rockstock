import {
  detectIndustryTemplate,
  getReasonablePeRange,
  getTemplateLabel,
  INDUSTRY_PE_RANGE,
} from '@/lib/valuation/industryTemplate';

describe('valuation/industryTemplate', () => {
  it('detects high_growth_asic', () => {
    expect(detectIndustryTemplate('半導體業')).toBe('high_growth_asic');
    expect(detectIndustryTemplate('IC設計')).toBe('high_growth_asic');
    expect(detectIndustryTemplate('其他電子業 - 設計服務')).toBe('high_growth_asic');
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
