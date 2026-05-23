/**
 * Contract test：UI store → server holdings 映射 + sync 不變式
 *
 * 守的規則：
 *   - mapping 純函式：合法 UI holding → 合法 server payload
 *   - costPrice → entryPrice、buyDate → entryDate 對應正確
 *   - market 缺失時從 symbol 後綴推導
 *   - stopLoss 預設為 costPrice × 0.93（與 holdingsImport 一致）
 *   - UI-only 欄位（entryKbar / triggerPrice / operationMode / recentHigh 等）不會洩漏到 server payload
 *   - 批量映射不互擋（部分失敗、其他成功）
 *   - toUpsertApiBody 必含 forcePrice=true（防止均價驗證誤殺）
 */

import {
  mapStoreToServerHolding,
  mapStoreHoldingsToImportRows,
  shouldSyncToServer,
  toUpsertApiBody,
  type StorePortfolioHolding,
} from '@/lib/portfolio/storeToHoldingsMapping';

function makeHolding(o: Partial<StorePortfolioHolding> = {}): StorePortfolioHolding {
  return {
    id: '1716453000000',
    symbol: '2408.TW',
    name: '南亞科',
    shares: 6000,
    costPrice: 203.83,
    buyDate: '2026-05-20',
    market: 'TW',
    ...o,
  };
}

describe('mapStoreToServerHolding', () => {
  test('合法 UI holding → server payload', () => {
    const r = mapStoreToServerHolding(makeHolding());
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({
      symbol: '2408.TW',
      name: '南亞科',
      market: 'TW',
      entryDate: '2026-05-20',
      entryPrice: 203.83,
      shares: 6000,
    });
  });

  test('stopLoss 預設 = costPrice × 0.93（書本 7%）', () => {
    const r = mapStoreToServerHolding(makeHolding({ costPrice: 1000 }));
    expect(r.payload?.stopLoss).toBeCloseTo(930, 2);
  });

  test('market 缺失：從 .TW 後綴推導', () => {
    const r = mapStoreToServerHolding(makeHolding({ market: undefined, symbol: '3037.TW' }));
    expect(r.ok).toBe(true);
    expect(r.payload?.market).toBe('TW');
  });

  test('market 缺失：從 .SS 後綴推導為 CN', () => {
    const r = mapStoreToServerHolding(makeHolding({
      market: undefined, symbol: '603986.SS', name: '兆易创新',
    }));
    expect(r.ok).toBe(true);
    expect(r.payload?.market).toBe('CN');
  });

  test('symbol 格式錯 → reject', () => {
    const r = mapStoreToServerHolding(makeHolding({ symbol: '24 08.TW' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('symbol');
  });

  test('shares 為小數 → reject', () => {
    const r = mapStoreToServerHolding(makeHolding({ shares: 1.5 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('shares');
  });

  test('costPrice 負數 → reject', () => {
    const r = mapStoreToServerHolding(makeHolding({ costPrice: -100 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('costPrice');
  });

  test('buyDate 格式錯 → reject', () => {
    const r = mapStoreToServerHolding(makeHolding({ buyDate: '5/20/2026' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('buyDate');
  });

  test('name 空白 → reject', () => {
    const r = mapStoreToServerHolding(makeHolding({ name: '' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('name');
  });

  test('UI-only 欄位（triggerPrice / entryKbar / recentHigh 等）不會洩漏到 server payload', () => {
    const h: StorePortfolioHolding & Record<string, unknown> = {
      ...makeHolding(),
      triggerPrice: 200,
      triggerSignal: 'N',
      operationMode: 'short',
      enhancedDisciplineEnabled: true,
      endPhaseTriggered: false,
      recentHigh: 220,
      consolidationLow: 195,
      vBottom: 195,
      entryKbar: { open: 200, high: 210, low: 195, close: 205, date: '2026-05-20', volume: 100000 },
      entryPattern: { patternType: 'N', necklinePrice: 200, targetPrice: 240, kind: 'bottom' },
    };
    const r = mapStoreToServerHolding(h);
    expect(r.ok).toBe(true);
    const keys = Object.keys(r.payload!);
    // 不可有 UI-only 欄位
    expect(keys).not.toContain('triggerPrice');
    expect(keys).not.toContain('triggerSignal');
    expect(keys).not.toContain('operationMode');
    expect(keys).not.toContain('enhancedDisciplineEnabled');
    expect(keys).not.toContain('endPhaseTriggered');
    expect(keys).not.toContain('recentHigh');
    expect(keys).not.toContain('consolidationLow');
    expect(keys).not.toContain('vBottom');
    expect(keys).not.toContain('entryKbar');
    expect(keys).not.toContain('entryPattern');
  });

  test('notes 帶過去；無 notes 不出現在 payload', () => {
    const r1 = mapStoreToServerHolding(makeHolding({ notes: 'AI PCB' }));
    expect(r1.payload?.notes).toBe('AI PCB');

    const r2 = mapStoreToServerHolding(makeHolding({ notes: undefined }));
    expect(r2.payload?.notes).toBeUndefined();
  });
});

describe('mapStoreHoldingsToImportRows', () => {
  test('全合法 → 全進 rows', () => {
    const r = mapStoreHoldingsToImportRows([
      makeHolding(),
      makeHolding({ id: '2', symbol: '3661.TW', name: '世芯-KY', shares: 14000, costPrice: 3829.08 }),
    ]);
    expect(r.rows).toHaveLength(2);
    expect(r.rejections).toHaveLength(0);
    expect(r.skipped).toHaveLength(0);
  });

  test('部分失敗：合法仍進、不合法進 rejections', () => {
    const r = mapStoreHoldingsToImportRows([
      makeHolding(),
      makeHolding({ id: 'bad', symbol: '', name: 'broken', shares: 0 }),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rejections).toHaveLength(1);
    expect(r.rejections[0].id).toBe('bad');
  });

  test('預設 excludeCn=true：CN holdings 進 skipped 不進 rows（用戶 2026-05-23 決議）', () => {
    const r = mapStoreHoldingsToImportRows([
      makeHolding(),
      makeHolding({
        id: '2', symbol: '603986.SS', name: '兆易创新', market: 'CN',
        shares: 3200, costPrice: 302.95,
      }),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].symbol).toBe('2408.TW');
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].symbol).toBe('603986.SS');
    expect(r.skipped[0].reason).toContain('cn_excluded');
  });

  test('excludeCn=false（手動 opt-in）：CN 進 rows', () => {
    const r = mapStoreHoldingsToImportRows([
      makeHolding({ id: '2', symbol: '603986.SS', name: '兆易创新', market: 'CN',
        shares: 3200, costPrice: 302.95 }),
    ], { excludeCn: false });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].symbol).toBe('603986.SS');
    expect(r.skipped).toHaveLength(0);
  });

  test('import row 結構對齊 /api/portfolio/import schema', () => {
    const r = mapStoreHoldingsToImportRows([makeHolding({ notes: 'AI PCB' })]);
    expect(r.rows[0]).toMatchObject({
      symbol: '2408.TW',
      name: '南亞科',
      shares: 6000,
      avgCost: 203.83,
      entryDate: '2026-05-20',
      stopLoss: expect.any(Number),
      notes: 'AI PCB',
    });
  });

  test('shares 是股數（張 × 1000），avgCost 是 per 股價格', () => {
    // 6000 股 × 203.83 = 1,222,980 NTD（與 UI 顯示成本對齊）
    const r = mapStoreHoldingsToImportRows([makeHolding()]);
    const totalCost = r.rows[0].shares * r.rows[0].avgCost;
    expect(totalCost).toBeCloseTo(1222980, 2);
  });
});

describe('shouldSyncToServer (TW-only filter)', () => {
  test('TW symbol with explicit market → true', () => {
    expect(shouldSyncToServer(makeHolding({ market: 'TW' }))).toBe(true);
  });

  test('CN symbol with explicit market → false', () => {
    expect(shouldSyncToServer(makeHolding({
      symbol: '603986.SS', name: '兆易创新', market: 'CN',
    }))).toBe(false);
  });

  test('symbol .SS 推導為 CN → false', () => {
    expect(shouldSyncToServer({
      ...makeHolding(), symbol: '600000.SS', market: undefined,
    } as StorePortfolioHolding)).toBe(false);
  });

  test('symbol .SZ 推導為 CN → false', () => {
    expect(shouldSyncToServer({
      ...makeHolding(), symbol: '000001.SZ', market: undefined,
    } as StorePortfolioHolding)).toBe(false);
  });

  test('symbol .TW 推導為 TW → true', () => {
    expect(shouldSyncToServer({
      ...makeHolding(), symbol: '3037.TW', market: undefined,
    } as StorePortfolioHolding)).toBe(true);
  });
});

describe('toUpsertApiBody', () => {
  test('必含 forcePrice: true（防均價誤殺）', () => {
    const payload = mapStoreToServerHolding(makeHolding()).payload!;
    const body = toUpsertApiBody(payload);
    expect(body.forcePrice).toBe(true);
  });

  test('status default open', () => {
    const payload = mapStoreToServerHolding(makeHolding()).payload!;
    const body = toUpsertApiBody(payload);
    expect(body.status).toBe('open');
  });

  test('body 含 server 端必填欄位（symbol/name/market/entryDate/entryPrice/shares）', () => {
    const payload = mapStoreToServerHolding(makeHolding()).payload!;
    const body = toUpsertApiBody(payload);
    expect(body).toMatchObject({
      symbol: '2408.TW',
      name: '南亞科',
      market: 'TW',
      entryDate: '2026-05-20',
      entryPrice: 203.83,
      shares: 6000,
    });
  });
});
