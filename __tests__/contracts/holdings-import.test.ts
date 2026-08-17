/**
 * Contract test：Holdings CSV 批量匯入
 *
 * 守的規則：
 *   - REQUIRED headers 缺一不可
 *   - shares 必須正整數、avgCost 必須正數
 *   - 預設 stopLoss = avgCost × 0.93（書本 7%）
 *   - 預設 entryDate = today（呼叫端傳入）
 *   - 不認識的 symbol 格式被擋
 *   - CSV 雙引號 + 跳脫支援
 */

import {
  parseCsv,
  parseImportCsv,
  parseRow,
  validateHeaders,
  applyDefaults,
  STOP_LOSS_DEFAULT_PCT,
  HOLDINGS_IMPORT_SCHEMA,
} from '@/lib/portfolio/holdingsImport';

describe('CSV parser', () => {
  test('純標頭 + 一 row', () => {
    const r = parseCsv('symbol,name,shares,avgCost\n3037.TW,欣興,30,856.5');
    expect(r.headers).toEqual(['symbol', 'name', 'shares', 'avgCost']);
    expect(r.rows).toEqual([['3037.TW', '欣興', '30', '856.5']]);
  });

  test('去 BOM', () => {
    const r = parseCsv('﻿symbol,name\nA,B');
    expect(r.headers).toEqual(['symbol', 'name']);
  });

  test('雙引號包裹欄位', () => {
    const r = parseCsv('symbol,notes\n3037.TW,"AI PCB, 強勢族群"');
    expect(r.rows[0]).toEqual(['3037.TW', 'AI PCB, 強勢族群']);
  });

  test('雙引號跳脫', () => {
    const r = parseCsv('symbol,notes\nA,"say ""hi"""');
    expect(r.rows[0]).toEqual(['A', 'say "hi"']);
  });

  test('CRLF 行尾', () => {
    const r = parseCsv('symbol,name\r\n3037.TW,欣興\r\n');
    expect(r.rows[0]).toEqual(['3037.TW', '欣興']);
  });

  test('空行過濾', () => {
    const r = parseCsv('symbol,name\n\nA,B\n\n');
    expect(r.rows).toEqual([['A', 'B']]);
  });
});

describe('validateHeaders', () => {
  test('齊全 OK', () => {
    expect(validateHeaders(['symbol', 'name', 'shares', 'avgCost']).ok).toBe(true);
  });
  test('多餘 OK', () => {
    expect(validateHeaders(['symbol', 'name', 'shares', 'avgCost', 'foo']).ok).toBe(true);
  });
  test('缺 symbol → reject', () => {
    const r = validateHeaders(['name', 'shares', 'avgCost']);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('symbol');
  });
  test('缺 avgCost → reject', () => {
    expect(validateHeaders(['symbol', 'name', 'shares']).ok).toBe(false);
  });
});

describe('parseRow', () => {
  const base = { symbol: '3037.TW', name: '欣興', shares: '30', avgCost: '856.5' };

  test('合法 row 通過', () => {
    const r = parseRow(base, 1);
    expect(r.ok).toBe(true);
    expect(r.row).toMatchObject({ symbol: '3037.TW', shares: 30, avgCost: 856.5 });
  });

  test('symbol 為空 → reject', () => {
    const r = parseRow({ ...base, symbol: '' }, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('symbol');
  });

  test('shares 為小數 → reject', () => {
    const r = parseRow({ ...base, shares: '1.5' }, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('shares');
  });

  test('avgCost 負數 → reject', () => {
    const r = parseRow({ ...base, avgCost: '-100' }, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('avgCost');
  });

  test('symbol 含特殊字元 → reject', () => {
    const r = parseRow({ ...base, symbol: '3037 .TW' }, 1);
    expect(r.ok).toBe(false);
  });

  test('entryDate 格式錯 → reject', () => {
    const r = parseRow({ ...base, entryDate: '5/22/2026' }, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('entryDate');
  });

  test('選填欄位空字串 → 不出現在 row', () => {
    const r = parseRow({ ...base, stopLoss: '', target1: '' }, 1);
    expect(r.ok).toBe(true);
    expect(r.row?.stopLoss).toBeUndefined();
    expect(r.row?.target1).toBeUndefined();
  });
});

describe('parseImportCsv (integration)', () => {
  test('multi-row, header + data', () => {
    const csv = [
      'symbol,name,shares,avgCost,entryDate,stopLoss,notes',
      '3037.TW,欣興,30,856.5,2026-04-15,800,AI PCB',
      '2330.TW,台積電,5,1100,2026-03-10,1020,',
    ].join('\n');
    const r = parseImportCsv(csv);
    expect(r.ok).toBe(true);
    expect(r.parsed).toHaveLength(2);
    expect(r.parsed.every(p => p.ok)).toBe(true);
  });

  test('header 缺 → 整份 reject', () => {
    const r = parseImportCsv('symbol,name\nA,B');
    expect(r.ok).toBe(false);
  });

  test('mixed ok + reject 不互擋', () => {
    const csv = [
      'symbol,name,shares,avgCost',
      '3037.TW,欣興,30,856.5',
      ',badrow,1,100',  // symbol 空
    ].join('\n');
    const r = parseImportCsv(csv);
    expect(r.ok).toBe(true);
    expect(r.parsed[0].ok).toBe(true);
    expect(r.parsed[1].ok).toBe(false);
  });
});

describe('applyDefaults', () => {
  test('TW symbol 自動分類市場 + 預設 entryDate + 預設 stopLoss = avgCost × 0.95', () => {
    const out = applyDefaults({ symbol: '3037.TW', name: '欣興', shares: 30, avgCost: 1000 }, '2026-05-23');
    expect(out.market).toBe('TW');
    expect(out.entryDate).toBe('2026-05-23');
    expect(out.stopLoss).toBeCloseTo(950, 2); // 1000 × 0.95
    expect(out.status).toBe('open');
  });

  test('使用者顯式 stopLoss 不被覆蓋', () => {
    const out = applyDefaults(
      { symbol: '3037.TW', name: '欣興', shares: 30, avgCost: 1000, stopLoss: 950 },
      '2026-05-23',
    );
    expect(out.stopLoss).toBe(950);
  });

  test('symbol 無法分類市場 → throw', () => {
    expect(() => applyDefaults({ symbol: 'AAPL', name: 'Apple', shares: 1, avgCost: 200 }, '2026-05-23')).toThrow();
  });

  test('STOP_LOSS_DEFAULT_PCT = 5%（最新版課程常用缺值 fallback）', () => {
    expect(STOP_LOSS_DEFAULT_PCT).toBeCloseTo(0.05, 4);
  });
});

describe('HOLDINGS_IMPORT_SCHEMA', () => {
  test('required headers 固定為 4 個', () => {
    expect(HOLDINGS_IMPORT_SCHEMA.required).toEqual(['symbol', 'name', 'shares', 'avgCost']);
  });
  test('schemaVersion = 1', () => {
    expect(HOLDINGS_IMPORT_SCHEMA.schemaVersion).toBe(1);
  });
});
