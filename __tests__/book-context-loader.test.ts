import { loadBookContext } from '@/lib/ai/bookContextLoader';

describe('AI 書本／課程上下文優先序', () => {
  it('先載入 2026 線上課程＋最新講義規格，再載入舊書整理', () => {
    const context = loadBookContext();
    const canonical = context.indexOf('<最高優先：朱老師 2026 線上課程＋最新講義交叉核對規格');
    const legacy = context.indexOf('<書本：五步法整理稿 v11');
    expect(canonical).toBeGreaterThanOrEqual(0);
    expect(legacy).toBeGreaterThan(canonical);
  });
});
