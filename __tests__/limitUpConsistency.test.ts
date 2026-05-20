/**
 * Unit tests for checkLimitUpConsistency
 *
 * 確保 fake-zero detection：
 *   - 真正 mis.twse bug (一字板 + close=prevClose) → 觸發
 *   - 合法波動 day (amplitude 大、close 落在 [L,H]) → 不觸發
 *   - amplitude 邊界 case
 */
import { describe, it, expect } from '@jest/globals';
import { checkLimitUpConsistency } from '@/lib/datasource/limitUpConsistency';

describe('checkLimitUpConsistency', () => {
  it('真實 mis.twse fake-zero bug：一字漲停 + close 抓成 prevClose → suspicious', () => {
    const r = checkLimitUpConsistency([
      { symbol: '1234.TW', high: 110, low: 110, close: 100, prevClose: 100 },
    ]);
    expect(r.suspicious).toBe(1);
    expect(r.samples[0].reason).toBe('fake-zero-limit-up');
  });

  it('合法波動 day 收回平盤（漲停殺到 -3.5%）→ 不應 suspicious (false positive fix)', () => {
    // 2026-05-20 7709 榮田實況
    const r = checkLimitUpConsistency([
      { symbol: '7709.TWO', open: 101, high: 101, low: 88.8, close: 92.1, prevClose: 92.1 },
    ]);
    expect(r.suspicious).toBe(0);
  });

  it('一字跌停 + close 抓成 prevClose → suspicious', () => {
    const r = checkLimitUpConsistency([
      { symbol: '4567.TW', high: 90, low: 90, close: 100, prevClose: 100 },
    ]);
    expect(r.suspicious).toBe(1);
    expect(r.samples[0].reason).toBe('fake-zero-limit-down');
  });

  it('amplitude 剛好在邊界 (2%) — 算 suspicious', () => {
    // amplitude = 0.019/100 = 1.9% < 2%
    const r = checkLimitUpConsistency([
      { symbol: '5555.TW', high: 109.6, low: 109.6 - 0.019 * 100, close: 100, prevClose: 100 },
    ]);
    // high 109.6 ≥ 100 * 1.095 = 109.5 觸漲停
    expect(r.suspicious).toBe(1);
  });

  it('amplitude 略大於閾值 (2.5%) — 不算', () => {
    const r = checkLimitUpConsistency([
      { symbol: '6666.TW', high: 110, low: 107.5, close: 100, prevClose: 100 },
    ]);
    // amplitude = 2.5% > 2%、但 close=100 < low=107.5 → out of range → 仍 suspicious
    expect(r.suspicious).toBe(1);
  });

  it('change > 1% 不算 fake-zero', () => {
    const r = checkLimitUpConsistency([
      { symbol: '7777.TW', high: 115, low: 100, close: 105, prevClose: 100 },
    ]);
    expect(r.suspicious).toBe(0);
  });

  it('沒觸漲停也沒跌停 → 不算', () => {
    const r = checkLimitUpConsistency([
      { symbol: '8888.TW', high: 102, low: 99, close: 100, prevClose: 100 },
    ]);
    expect(r.suspicious).toBe(0);
  });
});
