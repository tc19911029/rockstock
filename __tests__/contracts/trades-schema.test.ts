/**
 * Contract test：trades.json schema + ClosedTrade 計算
 *
 * 守的規則：
 *   - schemaVersion = 1
 *   - netPnL 必須 = calcNetPnL 輸出（不可獨立計算）
 *   - grossPnL = shares × (exit - entry)
 *   - fees = grossPnL - netPnL（反推扣費）
 *   - holdDays = exitDate - entryDate 天數
 *   - tradeId = symbol-entryDate-exitDate（dedup key）
 *   - exitDate ≥ entryDate
 *   - exitPrice / shares > 0
 *   - exitReason 必須在 enum 內
 */

import {
  TRADES_SCHEMA_VERSION,
  buildClosedTrade,
  diffDays,
  type CloseTradeInput,
} from '@/lib/portfolio/tradeRecorder';
import { calcNetPnL } from '@/lib/portfolio/fees';

const VALID_EXIT_REASONS = [
  'target_hit', 'stop_loss', 'discipline_break', 'risk_red',
  'hold_days_max', 'manual', 'swap', 'other',
] as const;

function makeInput(o: Partial<CloseTradeInput> = {}): CloseTradeInput {
  return {
    symbol: '3037.TW',
    name: '欣興',
    market: 'TW',
    entryDate: '2026-04-15',
    entryPrice: 856.5,
    shares: 30000,
    exitDate: '2026-05-22',
    exitPrice: 970,
    exitReason: 'target_hit',
    ...o,
  };
}

describe('buildClosedTrade', () => {
  test('grossPnL = shares × (exit - entry)', () => {
    const t = buildClosedTrade(makeInput());
    expect(t.grossPnL).toBeCloseTo(30000 * (970 - 856.5), 2);
  });

  test('netPnL 來自 calcNetPnL（含費）', () => {
    const input = makeInput();
    const expected = calcNetPnL(input.symbol, input.shares, input.entryPrice, input.exitPrice);
    const t = buildClosedTrade(input);
    expect(t.netPnL).toBeCloseTo(expected.pnl, 2);
    expect(t.netReturnPct).toBeCloseTo(expected.pnlPct, 4);
  });

  test('fees = grossPnL - netPnL (TW 含費反推合理)', () => {
    const t = buildClosedTrade(makeInput());
    // TW: 買 0.1425% + 賣 0.1425% + 0.3% = 約 0.585% 總成本
    // grossPnL - netPnL 應該 ≈ totalAmount × 0.585%
    expect(t.fees).toBeGreaterThan(0);
    const totalTraded = 30000 * (856.5 + 970);
    expect(t.fees).toBeLessThan(totalTraded * 0.01); // < 1%
    expect(t.fees).toBeGreaterThan(totalTraded * 0.003); // > 0.3%
  });

  test('holdDays 計算 (4/15 → 5/22 = 37 天)', () => {
    const t = buildClosedTrade(makeInput());
    expect(t.holdDays).toBe(37);
  });

  test('tradeId = symbol-entryDate-exitDate', () => {
    const t = buildClosedTrade(makeInput());
    expect(t.tradeId).toBe('3037.TW-2026-04-15-2026-05-22');
  });

  test('schemaVersion = 1', () => {
    const t = buildClosedTrade(makeInput());
    expect(t.schemaVersion).toBe(TRADES_SCHEMA_VERSION);
  });

  test('陸股使用 CN 費率', () => {
    const t = buildClosedTrade(makeInput({
      symbol: '600000.SS',
      market: 'CN',
      entryPrice: 10,
      exitPrice: 12,
      shares: 1000,
    }));
    // CN 費率較低（0.03% × 2 + 0.05% 印花稅 = 約 0.11%）
    expect(t.fees).toBeLessThan(t.grossPnL * 0.1);
  });

  test('進場時的關卡欄位被保留（後驗用）', () => {
    const t = buildClosedTrade(makeInput({
      stopLoss: 800,
      target1: 1050,
      target2: 1200,
      triggerSignal: 'N',
      matchedMethods: ['N', 'Q'],
    }));
    expect(t.stopLoss).toBe(800);
    expect(t.target1).toBe(1050);
    expect(t.target2).toBe(1200);
    expect(t.triggerSignal).toBe('N');
    expect(t.matchedMethods).toEqual(['N', 'Q']);
  });

  test('exitReason 必在 enum 內', () => {
    for (const reason of VALID_EXIT_REASONS) {
      const t = buildClosedTrade(makeInput({ exitReason: reason }));
      expect(t.exitReason).toBe(reason);
    }
  });

  test('停損 case：netPnL < 0', () => {
    const t = buildClosedTrade(makeInput({ exitPrice: 800, exitReason: 'stop_loss' }));
    expect(t.netPnL).toBeLessThan(0);
    expect(t.netReturnPct).toBeLessThan(0);
  });

  test('createdAt 為 ISO timestamp', () => {
    const t = buildClosedTrade(makeInput());
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('diffDays', () => {
  test('正向天數差', () => {
    expect(diffDays('2026-04-15', '2026-05-22')).toBe(37);
  });
  test('同日 = 0', () => {
    expect(diffDays('2026-05-22', '2026-05-22')).toBe(0);
  });
  test('反向 = 負數（不擋，由 appendTrade 守）', () => {
    expect(diffDays('2026-05-22', '2026-04-15')).toBe(-37);
  });
});

describe('TradesFile schema 不變式', () => {
  test('TRADES_SCHEMA_VERSION = 1（防止悄悄升級）', () => {
    expect(TRADES_SCHEMA_VERSION).toBe(1);
  });

  test('合法 trade 含所有必填欄位', () => {
    const t = buildClosedTrade(makeInput());
    expect(t.tradeId).toBeTruthy();
    expect(t.symbol).toBeTruthy();
    expect(t.name).toBeTruthy();
    expect(['TW', 'CN']).toContain(t.market);
    expect(t.entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.exitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof t.entryPrice).toBe('number');
    expect(typeof t.exitPrice).toBe('number');
    expect(typeof t.shares).toBe('number');
    expect(typeof t.grossPnL).toBe('number');
    expect(typeof t.fees).toBe('number');
    expect(typeof t.netPnL).toBe('number');
    expect(typeof t.netReturnPct).toBe('number');
    expect(typeof t.holdDays).toBe('number');
  });
});
