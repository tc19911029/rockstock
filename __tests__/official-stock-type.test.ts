import { classifyStockType } from '@/lib/spec-score/stockType';

describe('specScore 官方產業股票類型', () => {
  it('只依官方產業分類，不接受人工題材名稱', () => {
    expect(classifyStockType('半導體業')).toBe('ai_tech');
    expect(classifyStockType('航運業')).toBe('cyclical');
    expect(classifyStockType('AI伺服器')).toBe('general');
    expect(classifyStockType('CPO')).toBe('general');
    expect(classifyStockType(undefined)).toBe('general');
  });
});
