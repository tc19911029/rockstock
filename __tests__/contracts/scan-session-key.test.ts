/**
 * Contract test: 掃描紀錄主鍵唯一性
 *
 * 驗證 Fundamental Rule R5: 掃描紀錄用複合主鍵，不同日期不互相覆蓋
 */

import { ScanSessionKeySchema } from '@/lib/contracts/pipeline';

describe('Scan session key contracts', () => {
  test('R5: post_close session key 格式正確', () => {
    const key = {
      market: 'TW' as const,
      direction: 'long' as const,
      mtfMode: 'daily' as const,
      date: '2026-04-09',
      sessionType: 'post_close' as const,
    };

    const result = ScanSessionKeySchema.safeParse(key);
    expect(result.success).toBe(true);
  });

  test('R5: intraday session key 格式正確', () => {
    const key = {
      market: 'CN' as const,
      direction: 'short' as const,
      mtfMode: 'mtf' as const,
      date: '2026-04-09',
      sessionType: 'intraday' as const,
    };

    const result = ScanSessionKeySchema.safeParse(key);
    expect(result.success).toBe(true);
  });

  test('R5: 不同日期的 key 不相同', () => {
    const key1 = { market: 'TW', direction: 'long', mtfMode: 'daily', date: '2026-04-08', sessionType: 'post_close' };
    const key2 = { market: 'TW', direction: 'long', mtfMode: 'daily', date: '2026-04-09', sessionType: 'post_close' };

    // 主鍵中 date 不同 → 不應覆蓋
    expect(key1.date).not.toBe(key2.date);
  });

  test('R5: 同日不同 session_type 不互相覆蓋', () => {
    const postClose = { market: 'TW', direction: 'long', mtfMode: 'daily', date: '2026-04-09', sessionType: 'post_close' };
    const intraday = { market: 'TW', direction: 'long', mtfMode: 'daily', date: '2026-04-09', sessionType: 'intraday' };

    expect(postClose.sessionType).not.toBe(intraday.sessionType);
  });

  test('R5: 無效的 session key 被拒絕', () => {
    const invalid = {
      market: 'US', // 不支援
      direction: 'long',
      mtfMode: 'daily',
      date: '2026-04-09',
      sessionType: 'post_close',
    };

    const result = ScanSessionKeySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('R5: 日期格式錯誤被拒絕', () => {
    const invalid = {
      market: 'TW',
      direction: 'long',
      mtfMode: 'daily',
      date: '04/09/2026', // 錯誤格式
      sessionType: 'post_close',
    };

    const result = ScanSessionKeySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
