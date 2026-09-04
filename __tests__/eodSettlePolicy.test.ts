import {
  assessTwOfficialReadiness,
  canWriteSettlement,
  findConfirmedActivePendingSymbols,
  findTwOfficialNoTradeSymbols,
  mergeTwSettlementSymbols,
  shouldNotifySettlementFailure,
} from '@/lib/datasource/eodSettlePolicy';
import { settleSymbol, type SettleResult } from '@/lib/datasource/eodSettle';

function result(overrides: Partial<SettleResult> = {}): SettleResult {
  return {
    symbol: '3081.TWO',
    market: 'TW',
    date: '2026-08-26',
    status: 'settled-single-source',
    vendors: [],
    settled: { vendor: 'Yahoo', open: 3010, high: 3255, low: 2940, close: 3255, volume: 7470 },
    ...overrides,
  };
}

describe('EOD settlement fail-closed policy', () => {
  test('當日官方表的新代號會補進既有 L1 封存母體', () => {
    expect(mergeTwSettlementSymbols(
      ['2330.TW', '3081.TWO', '^TWII'],
      ['2330', '3711', '0050', '03001P'],
      ['3081', '3718', '00980A'],
    )).toEqual(['2330.TW', '3081.TWO', '^TWII', '3711.TW', '3718.TWO']);
  });

  test('同日相同 settlement 失敗原因不重複推播', () => {
    expect(shouldNotifySettlementFailure(null, 'readFailed=1')).toBe(true);
    expect(shouldNotifySettlementFailure({ status: 'complete' }, 'readFailed=1')).toBe(true);
    expect(shouldNotifySettlementFailure({ status: 'failed', reason: 'readFailed=2' }, 'readFailed=1')).toBe(true);
    expect(shouldNotifySettlementFailure({ status: 'failed', reason: 'readFailed=1' }, 'readFailed=1')).toBe(false);
  });

  test('16:00 前官方批次未到齊會 defer', () => {
    expect(assessTwOfficialReadiness({
      market: 'TW',
      targetDate: '2026-08-26',
      twseRows: 1_400,
      tpexRows: 0,
      now: new Date('2026-08-26T07:30:00.000Z'),
    })).toMatchObject({ ready: false, defer: true });
  });

  test('16:00 後官方仍未到齊也繼續 defer，不用非官方來源定稿', () => {
    expect(assessTwOfficialReadiness({
      market: 'TW',
      targetDate: '2026-08-26',
      twseRows: 1_400,
      tpexRows: 0,
      now: new Date('2026-08-26T08:30:00.000Z'),
    })).toMatchObject({ ready: false, defer: true });
  });

  test('TWSE 與 TPEx 都到齊才視為官方批次 ready', () => {
    expect(assessTwOfficialReadiness({
      market: 'TW',
      targetDate: '2026-08-26',
      twseRows: 1_400,
      tpexRows: 1_000,
      now: new Date('2026-08-26T07:30:00.000Z'),
    })).toEqual({ ready: true, defer: false, reason: undefined });
  });

  test('CN 不受 TW 官方批次 gate 影響', () => {
    expect(assessTwOfficialReadiness({
      market: 'CN',
      targetDate: '2026-08-26',
      twseRows: 0,
      tpexRows: 0,
      now: new Date('2026-08-26T07:30:00.000Z'),
    })).toEqual({ ready: true, defer: false });
  });

  test('TW 只接受官方錨，兩個非官方獨立來源一致也不得寫正式 L1', () => {
    expect(canWriteSettlement(result({ officialAnchor: true }), 'TW', false)).toBe(true);
    expect(canWriteSettlement(result({
      status: 'settled-multi-source',
      independentAgree: 2,
    }), 'TW', false)).toBe(false);
    expect(canWriteSettlement(result({ independentAgree: 1 }), 'TW', true)).toBe(false);
    expect(canWriteSettlement(result({
      status: 'pending-unverified',
      officialAnchor: true,
    }), 'TW', false)).toBe(false);
    expect(canWriteSettlement(result({
      status: 'skipped-already-correct',
      officialAnchor: true,
    }), 'TW', false)).toBe(false);
  });

  test('TW retry 遇到與官方 close/volume 一致的 L1 時快速跳過', async () => {
    const quote = { vendor: 'L1', open: 1_190, high: 1_210, low: 1_185, close: 1_205, volume: 20_000 };
    const settled = await settleSymbol('2330.TW', 'TW', '2026-09-01', quote, {
      market: 'TW',
      date: '2026-09-01',
      twseBulk: new Map([['2330', { open: 1_190, high: 1_210, low: 1_185, close: 1_205, volume: 20_000 }]]),
      tpexBulk: new Map(),
      eastMoneyBulk: new Map(),
    });

    expect(settled).toMatchObject({
      status: 'skipped-already-correct',
      officialAnchor: true,
      independentAgree: 1,
    });
    expect(settled.vendors.map(vendor => vendor.vendor)).toEqual(['TWSE', 'L1-existing']);
  });

  test('CN 維持缺檔時可用單源自癒的既有政策', () => {
    const cn = result({ market: 'CN' });
    expect(canWriteSettlement(cn, 'CN', true)).toBe(true);
    expect(canWriteSettlement(cn, 'CN', false)).toBe(false);
  });

  test('告警只計算官方當日交易母體內且未確認停牌的 pending', () => {
    const results: SettleResult[] = [
      result({ symbol: '2330.TW', status: 'pending-no-vendor-data', settled: undefined }),
      result({ symbol: '1563.TW', status: 'pending-no-vendor-data', settled: undefined }),
      result({ symbol: '^TWII', status: 'pending-unverified' }),
      result({ symbol: '2317.TW', status: 'pending-no-vendor-data', settled: undefined }),
      result({ symbol: '2454.TW', status: 'skipped-already-correct' }),
    ];

    expect(findConfirmedActivePendingSymbols(
      results,
      ['2330.TW', '2317.TW', '2454.TW'],
      ['2317.TW'],
    )).toEqual(['2330.TW']);
  });

  test('陸股歷史殘留不在官方交易母體時不觸發 activeWithoutOfficial', () => {
    const results: SettleResult[] = [
      result({ market: 'CN', symbol: '000004.SZ', status: 'pending-no-vendor-data', settled: undefined }),
      result({ market: 'CN', symbol: '600929.SS', status: 'pending-no-vendor-data', settled: undefined }),
    ];

    expect(findConfirmedActivePendingSymbols(
      results,
      ['600929.SS'],
      ['600929.SS'],
    )).toEqual([]);
  });

  test('完整官方日線缺席 + 13:25 後完整快照零量，可確認為當日無成交', () => {
    const results: SettleResult[] = [
      result({ symbol: '1538.TW', status: 'pending-no-vendor-data', settled: undefined }),
      result({ symbol: '2330.TW', status: 'pending-no-vendor-data', settled: undefined }),
      result({ symbol: '2073.TWO', status: 'settled-single-source' }),
    ];
    const snapshot = {
      date: '2026-09-01',
      updatedAt: '2026-09-01T05:29:19.935Z',
      count: 2_098,
      quotes: [
        {
          symbol: '1538', name: '正峰', open: 8.59, high: 8.59, low: 8.59, close: 8.59,
          volume: 0, prevClose: 8.96, changePercent: -4.13,
          isActualTrade: false, priceKind: 'indicative' as const,
        },
        {
          symbol: '2330', name: '台積電', open: 1_200, high: 1_210, low: 1_190, close: 1_205,
          volume: 20_000, prevClose: 1_195, changePercent: 0.84,
          isActualTrade: true, priceKind: 'last_actual' as const,
        },
      ],
    };

    expect(findTwOfficialNoTradeSymbols({
      targetDate: '2026-09-01',
      officialReady: true,
      results,
      canonicalSymbols: ['1538.TW', '2330.TW', '2073.TWO'],
      snapshot,
    })).toEqual(['1538.TW']);
  });

  test('官方批次未完整或快照早於 13:25 時，不可推定無成交', () => {
    const input = {
      targetDate: '2026-09-01',
      officialReady: true,
      results: [result({ symbol: '1538.TW', status: 'pending-no-vendor-data', settled: undefined })],
      canonicalSymbols: ['1538.TW'],
      snapshot: {
        date: '2026-09-01', updatedAt: '2026-09-01T05:24:59.000Z', count: 2_098,
        quotes: [{
          symbol: '1538', name: '正峰', open: 8.59, high: 8.59, low: 8.59, close: 8.59,
          volume: 0, prevClose: 8.96, changePercent: -4.13,
          isActualTrade: false, priceKind: 'indicative' as const,
        }],
      },
    };
    expect(findTwOfficialNoTradeSymbols(input)).toEqual([]);
    expect(findTwOfficialNoTradeSymbols({ ...input, officialReady: false })).toEqual([]);
  });
});
