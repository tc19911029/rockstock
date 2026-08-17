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
  toFullUpsertApiBody,
  mapServerToStoreHolding,
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

  test('stopLoss 缺值時預設 = costPrice × 0.95（最新版課程常用 5%）', () => {
    const r = mapStoreToServerHolding(makeHolding({ costPrice: 1000 }));
    expect(r.payload?.stopLoss).toBeCloseTo(950, 2);
  });

  test('已有 stopLoss 時同步保留原值，不重設成預設 5%', () => {
    const r = mapStoreToServerHolding(makeHolding({ stopLoss: 188.5 }));
    expect(r.payload?.stopLoss).toBe(188.5);
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

// ════════════════════════════════════════════════════════════════════════════
// 2026-05-31 補測：持倉改 server 唯一真相後 store 改用的全保真雙向映射
// （toFullUpsertApiBody / mapServerToStoreHolding）— 舊測只覆蓋簡化鏡像
// ════════════════════════════════════════════════════════════════════════════

describe('toFullUpsertApiBody (全保真：核心欄位 + ui blob)', () => {
  test('UI 富欄位進 ui blob，核心欄位留頂層；含 status/forcePrice', () => {
    const h: StorePortfolioHolding & Record<string, unknown> = {
      ...makeHolding(),
      triggerPrice: 200,
      operationMode: 'short',
      entryKbar: { open: 200, high: 210, low: 195, close: 205, date: '2026-05-20', volume: 100000 },
    };
    const body = toFullUpsertApiBody(h)!;
    expect(body).not.toBeNull();
    expect(body).toMatchObject({
      symbol: '2408.TW', name: '南亞科', market: 'TW',
      entryDate: '2026-05-20', entryPrice: 203.83, shares: 6000,
      status: 'open', forcePrice: true,
    });
    const ui = body.ui as Record<string, unknown>;
    expect(ui.triggerPrice).toBe(200);
    expect(ui.operationMode).toBe('short');
    expect(ui.entryKbar).toMatchObject({ close: 205 });
    // UI 欄位不可洩漏到頂層（reports/mini-agent 只讀核心欄位）
    expect(body.triggerPrice).toBeUndefined();
    expect(body.entryKbar).toBeUndefined();
  });

  test('無 UI 富欄位 → 不產生 ui key', () => {
    const body = toFullUpsertApiBody({ ...makeHolding() })!;
    expect(body.ui).toBeUndefined();
  });

  test('缺核心欄位（costPrice 無效）→ 回 null', () => {
    expect(toFullUpsertApiBody({ ...makeHolding({ costPrice: -1 }) })).toBeNull();
  });
});

describe('mapServerToStoreHolding (hydration：server → store)', () => {
  test('entryPrice→costPrice、entryDate→buyDate、id=srv-symbol', () => {
    const s = mapServerToStoreHolding({
      symbol: '2408.TW', name: '南亞科', market: 'TW',
      entryDate: '2026-05-20', entryPrice: 203.83, shares: 6000,
    })!;
    expect(s).not.toBeNull();
    expect(s.costPrice).toBe(203.83);
    expect(s.buyDate).toBe('2026-05-20');
    expect(s.id).toBe('srv-2408.TW');
    expect(s.market).toBe('TW');
  });

  test('server stopLoss hydration 回 store 頂層', () => {
    const s = mapServerToStoreHolding({
      symbol: '2408.TW', name: '南亞科', market: 'TW',
      entryDate: '2026-05-20', entryPrice: 203.83, shares: 6000, stopLoss: 188.5,
    })!;
    expect(s.stopLoss).toBe(188.5);
  });

  test('ui blob 原樣展開回頂層', () => {
    const s = mapServerToStoreHolding({
      symbol: '2408.TW', name: '南亞科', entryPrice: 203.83, shares: 6000,
      entryDate: '2026-05-20',
      ui: { triggerPrice: 200, operationMode: 'short' },
    })! as Record<string, unknown>;
    expect(s.triggerPrice).toBe(200);
    expect(s.operationMode).toBe('short');
  });

  test('核心欄位覆蓋 ui 同名欄位（ui 不可污染核心）', () => {
    const s = mapServerToStoreHolding({
      symbol: '2408.TW', name: '南亞科', entryPrice: 203.83, shares: 6000,
      entryDate: '2026-05-20',
      ui: { symbol: 'HACKED', costPrice: 999 },
    })!;
    expect(s.symbol).toBe('2408.TW');
    expect(s.costPrice).toBe(203.83);
  });

  test('.SS → market CN', () => {
    const s = mapServerToStoreHolding({
      symbol: '603986.SS', name: '兆易创新', market: 'CN',
      entryPrice: 302.95, shares: 3200, entryDate: '2026-05-20',
    })!;
    expect(s.market).toBe('CN');
  });

  test('缺 symbol → 回 null', () => {
    expect(mapServerToStoreHolding({ name: 'x', entryPrice: 1, shares: 1 })).toBeNull();
  });

  test('round-trip：store → server → store 保留 UI 富欄位與核心值', () => {
    const original: StorePortfolioHolding & Record<string, unknown> = {
      ...makeHolding(),
      triggerPrice: 200,
      operationMode: 'short',
    };
    const serverBody = toFullUpsertApiBody(original)!;
    const restored = mapServerToStoreHolding(serverBody)! as Record<string, unknown>;
    expect(restored.costPrice).toBe(203.83);
    expect(restored.buyDate).toBe('2026-05-20');
    expect(restored.triggerPrice).toBe(200);
    expect(restored.operationMode).toBe('short');
  });
});
