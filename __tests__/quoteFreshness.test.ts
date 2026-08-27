import { assessQuoteFreshness } from '@/lib/datasource/quoteFreshness';

describe('使用者報價新鮮度契約', () => {
  test('交易日收盤後仍停在前一日必須標為 delayed', () => {
    expect(assessQuoteFreshness('TW', '2026-08-26', new Date('2026-08-27T07:00:00.000Z'))).toMatchObject({
      expectedDate: '2026-08-27',
      asOf: '2026-08-26',
      stale: true,
      status: 'delayed',
    });
  });

  test('交易日收盤後取得當日 MIS/L1 為 final', () => {
    expect(assessQuoteFreshness('TW', '2026-08-27', new Date('2026-08-27T07:00:00.000Z'))).toEqual({
      expectedDate: '2026-08-27',
      asOf: '2026-08-27',
      stale: false,
      status: 'final',
    });
  });

  test('交易日盤前以上一交易日為正確基準，不誤報延遲', () => {
    expect(assessQuoteFreshness('TW', '2026-08-26', new Date('2026-08-27T00:00:00.000Z'))).toMatchObject({
      expectedDate: '2026-08-26',
      stale: false,
      status: 'final',
    });
  });

  test.each(['2026-99-99', '2026-02-30', '2026-08-28'])(
    '無效或未來日期 %s 不得通過新鮮度檢查',
    asOf => {
      expect(assessQuoteFreshness('TW', asOf, new Date('2026-08-27T07:00:00.000Z'))).toMatchObject({
        stale: true,
        status: 'delayed',
      });
    },
  );
});
