/**
 * Contract test: per-symbol API routes 必須短路「大盤指數」。
 *
 * 防 bug（2026-06-10）：指數（^TWII / 000001.SS …）沒有籌碼/基本面/估值/軋空/成本資料；
 * 若 route 不擋，對指數打外部源會卡住、或回全 0 假分析被前端畫成誤導畫面。
 * 解法：共用 lib/utils/symbols.isIndexSymbol，於 route parse symbol 後立即短路回 4xx。
 *
 * 本測試做兩件事：
 *   (1) 驗證 isIndexSymbol 行為（含 000001.SS=指數 vs 000001.SZ=平安銀行 的後綴分辨）。
 *   (2) 確保已知的 per-symbol routes 原始碼仍呼叫 isIndexSymbol（防有人改掉 guard）。
 *       新增 per-symbol route 時，請一併加 isIndexSymbol 並把路徑列入 PER_SYMBOL_ROUTES。
 */

import { readFileSync } from 'fs';
import path from 'path';
import { isIndexSymbol } from '../../lib/utils/symbols';

const REPO = path.join(__dirname, '..', '..');

describe('isIndexSymbol', () => {
  it.each(['^TWII', '^TWOII', '^IXIC', '000001.SS', '000300.SS', '399001.SZ', '399006.SZ', '000001.ss'])(
    'treats %s as an index',
    (s) => expect(isIndexSymbol(s)).toBe(true),
  );

  // ⚠ 後綴權威：000001.SZ 是平安銀行（個股），不可被當成指數
  it.each(['2330', '2330.TW', '6770.TW', '600707.SS', '000858.SZ', '603986.SS', '000001.SZ', '000001'])(
    'treats %s as a real stock (not an index)',
    (s) => expect(isIndexSymbol(s)).toBe(false),
  );

  it('handles empty / nullish', () => {
    expect(isIndexSymbol('')).toBe(false);
    expect(isIndexSymbol(null)).toBe(false);
    expect(isIndexSymbol(undefined)).toBe(false);
  });
});

describe('per-symbol API routes guard against index symbols', () => {
  // 每條 route 在 parse symbol 後都應呼叫 isIndexSymbol 短路指數
  const PER_SYMBOL_ROUTES = [
    'app/api/squeeze/route.ts',
    'app/api/cost-basis/route.ts',
    'app/api/fundamentals/[ticker]/route.ts',
    'app/api/agents/decisions/[symbol]/route.ts',
    'app/api/realtime/bars/route.ts',
    'app/api/watchlist/price-at/route.ts',
  ];

  it.each(PER_SYMBOL_ROUTES)('%s calls isIndexSymbol() to reject indices', (rel) => {
    const src = readFileSync(path.join(REPO, rel), 'utf-8');
    expect(src).toMatch(/isIndexSymbol\s*\(/);
  });
});
