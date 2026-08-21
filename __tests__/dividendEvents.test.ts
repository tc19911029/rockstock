import {
  cashDividendAdjustedThreshold,
  cumulativeCashDividend,
  normalizeCashDividendEvents,
} from '@/lib/analysis/dividendEvents';

describe('現金除息事件與均線門檻調整', () => {
  const row = {
    year: '115年前半年度',
    CashEarningsDistribution: 0.23,
    CashStatutorySurplus: 0,
    CashExDividendTradingDate: '2026-08-27',
    CashDividendPaymentDate: '2026-09-29',
    AnnouncementDate: '2026-08-12',
  };

  it('只納入截至走圖日已公告、且落在預測窗內的事件', () => {
    expect(normalizeCashDividendEvents([row], '2026-08-21', '2026-09-30')).toEqual([{
      exDate: '2026-08-27',
      cashDividend: 0.23,
      paymentDate: '2026-09-29',
      announcementDate: '2026-08-12',
      yearLabel: '115年前半年度',
    }]);
    expect(normalizeCashDividendEvents([row], '2026-08-01', '2026-09-30')).toEqual([]);
  });

  it('除息日前不調整，除息日起用累計股息計算等值門檻', () => {
    const events = normalizeCashDividendEvents([row], '2026-08-21', '2026-09-30');
    expect(cumulativeCashDividend(events, '2026-08-26')).toBe(0);
    expect(cumulativeCashDividend(events, '2026-08-27')).toBeCloseTo(0.23);
    expect(cashDividendAdjustedThreshold(85.9, events, '2026-08-27')).toBeCloseTo(85.67);
  });
});
