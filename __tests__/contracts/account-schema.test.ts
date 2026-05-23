/**
 * Contract test：Account 帳戶總資金 schema + 計算邏輯
 *
 * 守的規則：
 *   - schemaVersion = 1
 *   - totalCapital = cash + stockValue（不可被獨立 set）
 *   - cash 不可為負數
 *   - computeStockValue 純函式：shares × close，close=null 時不擋
 *   - asOfDate 取所有 holdings 最新一根 K 線日期
 */

import {
  ACCOUNT_SCHEMA_VERSION,
  computeStockValue,
  type AccountFile,
} from '@/lib/portfolio/account';
import type { MarketId } from '@/lib/scanner/types';

const makeHolding = (symbol: string, market: MarketId, shares: number) => ({ symbol, market, shares });

describe('computeStockValue', () => {
  test('空持股 → stockValue 0', () => {
    const r = computeStockValue([], new Map());
    expect(r.stockValue).toBe(0);
    expect(r.asOfDate).toBeNull();
    expect(r.holdingsSnapshot).toEqual([]);
  });

  test('單檔：shares × close', () => {
    const r = computeStockValue(
      [makeHolding('3037.TW', 'TW', 30000)],
      new Map([['3037.TW', { close: 970, date: '2026-05-22' }]]),
    );
    expect(r.stockValue).toBe(30000 * 970);
    expect(r.asOfDate).toBe('2026-05-22');
    expect(r.holdingsSnapshot[0]).toEqual({
      symbol: '3037.TW', market: 'TW', shares: 30000, close: 970,
      closeDate: '2026-05-22', value: 30000 * 970,
    });
  });

  test('多檔：總和 + asOfDate 取最新', () => {
    const r = computeStockValue(
      [
        makeHolding('3037.TW', 'TW', 30000),
        makeHolding('2330.TW', 'TW', 5000),
      ],
      new Map([
        ['3037.TW', { close: 970, date: '2026-05-22' }],
        ['2330.TW', { close: 1100, date: '2026-05-21' }],
      ]),
    );
    expect(r.stockValue).toBe(30000 * 970 + 5000 * 1100);
    expect(r.asOfDate).toBe('2026-05-22');
  });

  test('某檔 K 線缺 → value 0 但不擋（不誤殺）', () => {
    const r = computeStockValue(
      [
        makeHolding('3037.TW', 'TW', 30000),
        makeHolding('9999.TW', 'TW', 1000),
      ],
      new Map([
        ['3037.TW', { close: 970, date: '2026-05-22' }],
        ['9999.TW', null],
      ]),
    );
    expect(r.stockValue).toBe(30000 * 970);
    expect(r.holdingsSnapshot[1]).toMatchObject({ close: null, closeDate: null, value: 0 });
  });

  test('陸股 + 台股混合 → 各自 shares × close（不混匯率）', () => {
    const r = computeStockValue(
      [
        makeHolding('600000.SS', 'CN', 100),
        makeHolding('3037.TW', 'TW', 30000),
      ],
      new Map([
        ['600000.SS', { close: 10, date: '2026-05-22' }],
        ['3037.TW', { close: 970, date: '2026-05-22' }],
      ]),
    );
    expect(r.stockValue).toBe(100 * 10 + 30000 * 970);
  });
});

describe('AccountFile schema', () => {
  function validateAccount(d: unknown): { ok: true } | { ok: false; reason: string } {
    if (!d || typeof d !== 'object') return { ok: false, reason: 'not object' };
    const v = d as Record<string, unknown>;
    if (v.schemaVersion !== ACCOUNT_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion ≠ 1' };
    if (typeof v.cash !== 'number' || v.cash < 0) return { ok: false, reason: 'cash invalid' };
    if (typeof v.stockValue !== 'number' || v.stockValue < 0) return { ok: false, reason: 'stockValue invalid' };
    if (typeof v.totalCapital !== 'number') return { ok: false, reason: 'totalCapital invalid' };
    if (Math.abs(v.totalCapital - ((v.cash as number) + (v.stockValue as number))) > 0.01) {
      return { ok: false, reason: 'totalCapital ≠ cash + stockValue' };
    }
    if (!Array.isArray(v.holdingsSnapshot)) return { ok: false, reason: 'holdingsSnapshot missing' };
    return { ok: true };
  }

  const validAccount: AccountFile = {
    schemaVersion: 1,
    cash: 0,
    stockValue: 70_000_000,
    totalCapital: 70_000_000,
    asOfDate: '2026-05-22',
    holdingsSnapshot: [],
    updatedAt: '2026-05-23T00:00:00Z',
  };

  test('合法 account 通過', () => {
    expect(validateAccount(validAccount)).toEqual({ ok: true });
  });

  test('totalCapital ≠ cash + stockValue → reject（不變式）', () => {
    const r = validateAccount({ ...validAccount, totalCapital: 99_999_999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('totalCapital');
  });

  test('cash 負數 → reject', () => {
    expect(validateAccount({ ...validAccount, cash: -1 }).ok).toBe(false);
  });

  test('schemaVersion ≠ 1 → reject', () => {
    expect(validateAccount({ ...validAccount, schemaVersion: 2 }).ok).toBe(false);
  });

  test('ACCOUNT_SCHEMA_VERSION = 1（防止未通知地升級）', () => {
    expect(ACCOUNT_SCHEMA_VERSION).toBe(1);
  });
});
