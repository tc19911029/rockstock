import { resolveTwIntradayPriceState } from '@/lib/datasource/twIntradayPriceState';

describe('TW intraday display price state', () => {
  test('前兩次缺少成交價沿用最後真實成交，第三次才用雙邊中價', () => {
    const actual = resolveTwIntradayPriceState({
      close: 100,
      isActualTrade: true,
      updatedAt: '2026-08-31T01:00:00.000Z',
    });
    const missing1 = resolveTwIntradayPriceState({
      close: 100.5,
      indicativePrice: 100.5,
      isActualTrade: false,
      updatedAt: '2026-08-31T01:01:00.000Z',
    }, actual);
    const missing2 = resolveTwIntradayPriceState({
      close: 101,
      indicativePrice: 101,
      isActualTrade: false,
      updatedAt: '2026-08-31T01:02:00.000Z',
    }, missing1);
    const missing3 = resolveTwIntradayPriceState({
      close: 101.5,
      indicativePrice: 101.5,
      isActualTrade: false,
      updatedAt: '2026-08-31T01:03:00.000Z',
    }, missing2);

    expect(missing1).toMatchObject({ close: 100, priceKind: 'last_actual', consecutiveMissingActual: 1 });
    expect(missing2).toMatchObject({ close: 100, priceKind: 'last_actual', consecutiveMissingActual: 2 });
    expect(missing3).toMatchObject({ close: 101.5, priceKind: 'indicative', consecutiveMissingActual: 3 });
  });

  test('下一輪重新收到真實成交價會立即覆蓋並歸零', () => {
    const recovered = resolveTwIntradayPriceState({
      close: 102,
      isActualTrade: true,
      updatedAt: '2026-08-31T01:04:00.000Z',
    }, {
      close: 101.5,
      isActualTrade: false,
      priceKind: 'indicative',
      lastActualPrice: 100,
      consecutiveMissingActual: 5,
    });

    expect(recovered).toMatchObject({
      close: 102,
      isActualTrade: true,
      priceKind: 'actual',
      lastActualPrice: 102,
      consecutiveMissingActual: 0,
    });
  });

  test('沒有完整雙邊中價時，即使超過三輪仍只沿用最後成交價', () => {
    const state = resolveTwIntradayPriceState({
      close: 0,
      isActualTrade: false,
    }, {
      close: 88,
      isActualTrade: true,
      priceKind: 'last_actual',
      lastActualPrice: 88,
      consecutiveMissingActual: 3,
    });

    expect(state).toMatchObject({ close: 88, priceKind: 'last_actual', consecutiveMissingActual: 4 });
  });

  test('當日尚未成交時可沿用昨收作為最後已確認成交價', () => {
    const state = resolveTwIntradayPriceState({
      close: 0,
      previousClose: 50,
      isActualTrade: false,
    });
    expect(state).toMatchObject({ close: 50, priceKind: 'last_actual', consecutiveMissingActual: 1 });
  });
});
