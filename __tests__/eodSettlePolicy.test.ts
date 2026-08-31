import { assessTwOfficialReadiness, canWriteSettlement } from '@/lib/datasource/eodSettlePolicy';
import type { SettleResult } from '@/lib/datasource/eodSettle';

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
  });

  test('CN 維持缺檔時可用單源自癒的既有政策', () => {
    const cn = result({ market: 'CN' });
    expect(canWriteSettlement(cn, 'CN', true)).toBe(true);
    expect(canWriteSettlement(cn, 'CN', false)).toBe(false);
  });
});
