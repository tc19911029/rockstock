import { formatTruncatedDecimal, truncateToDecimals } from '@/lib/format';

describe('投資損益與報酬的截斷格式', () => {
  test('正數向零截斷到小數點後兩位', () => {
    expect(truncateToDecimals(1234.567, 2)).toBe(1234.56);
    expect(formatTruncatedDecimal(1234.567)).toBe('1,234.56');
  });

  test('負數也向零截斷，不會往下取整', () => {
    expect(truncateToDecimals(-1234.567, 2)).toBe(-1234.56);
    expect(formatTruncatedDecimal(-1234.567)).toBe('-1,234.56');
  });

  test('固定顯示兩位並正規化負零', () => {
    expect(formatTruncatedDecimal(12)).toBe('12.00');
    expect(formatTruncatedDecimal(-0.001)).toBe('0.00');
  });

  test('不被浮點數的整數邊界誤差多截一分', () => {
    expect(formatTruncatedDecimal(1.15)).toBe('1.15');
    expect(formatTruncatedDecimal(-1.15)).toBe('-1.15');
    expect(formatTruncatedDecimal(1874.9999999999977)).toBe('1,875.00');
  });

  test('非有限數使用缺值符號', () => {
    expect(formatTruncatedDecimal(Number.NaN)).toBe('—');
    expect(formatTruncatedDecimal(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
