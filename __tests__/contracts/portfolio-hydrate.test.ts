/**
 * Contract test：hydrateHoldingsFromServer（2026-05-31 補）
 *
 * 守的規則（持倉改 server 唯一真相後的啟動關鍵路徑）：
 *   - 成功：server holdings（台股+陸股）灌入 store，回 true
 *   - server 非 200：回 false 且**保留**現有 holdings（不清空畫面）
 *   - fetch throw（網路斷）：回 false 且**保留**現有 holdings
 *   - 回應信封相容：{ data: { holdings } } 與 { holdings } 兩種都吃
 *   - 透過 mapServerToStoreHolding：entryPrice→costPrice、ui blob 展開
 *
 * 為什麼重要：hydrate 失敗時若清空 holdings，會讓暫時性網路問題抹掉使用者整個持倉畫面。
 *
 * 註：jest testEnvironment='node' 無 window，但 hydrate/sync 第一行就 `if (typeof window
 * === 'undefined') return` → 必須先 stub global.window，否則所有 case 都假性 return false。
 */

import { usePortfolioStore, hydrateHoldingsFromServer } from '@/store/portfolioStore';
import type { PortfolioHolding } from '@/store/portfolioStore';

function mkExisting(): PortfolioHolding {
  return {
    id: 'local-1', symbol: '2330.TW', name: '台積電',
    shares: 1000, costPrice: 1000, buyDate: '2026-05-01', market: 'TW',
  };
}

function serverRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: '2408.TW', name: '南亞科', market: 'TW',
    entryDate: '2026-05-20', entryPrice: 203.83, shares: 6000, ...o,
  };
}

const realFetch = global.fetch;
const hadWindow = 'window' in globalThis;

beforeAll(() => {
  // node 環境補一個最小 window，讓 browser-only 守衛 (typeof window) 通過
  if (!hadWindow) (globalThis as unknown as { window: unknown }).window = {};
});
afterAll(() => {
  global.fetch = realFetch;
  if (!hadWindow) delete (globalThis as unknown as { window?: unknown }).window;
});

beforeEach(() => {
  usePortfolioStore.setState({ holdings: [] });
});

describe('hydrateHoldingsFromServer', () => {
  test('成功：TW+CN 都灌入，entryPrice→costPrice，回 true', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { holdings: [
        serverRow({ stopLoss: 188.5 }),
        serverRow({ symbol: '603986.SS', name: '兆易创新', market: 'CN', entryPrice: 302.95, shares: 3200 }),
      ] } }),
    }) as unknown as typeof fetch;

    const ok = await hydrateHoldingsFromServer();
    expect(ok).toBe(true);
    const h = usePortfolioStore.getState().holdings;
    expect(h).toHaveLength(2);
    const tw = h.find(x => x.symbol === '2408.TW')!;
    expect(tw.costPrice).toBe(203.83);
    expect(tw.buyDate).toBe('2026-05-20');
    expect(tw.stopLoss).toBe(188.5);
    expect(h.some(x => x.market === 'CN')).toBe(true);
  });

  test('信封相容：{ holdings } 無 data 包裝也吃', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ holdings: [serverRow()] }),
    }) as unknown as typeof fetch;

    const ok = await hydrateHoldingsFromServer();
    expect(ok).toBe(true);
    expect(usePortfolioStore.getState().holdings).toHaveLength(1);
  });

  test('ui blob 展開回頂層', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ holdings: [serverRow({ ui: { triggerPrice: 200, operationMode: 'short' } })] }),
    }) as unknown as typeof fetch;

    await hydrateHoldingsFromServer();
    const h = usePortfolioStore.getState().holdings[0] as PortfolioHolding;
    expect(h.triggerPrice).toBe(200);
    expect(h.operationMode).toBe('short');
  });

  test('server 非 200：回 false 且保留現有 holdings（不清空）', async () => {
    usePortfolioStore.setState({ holdings: [mkExisting()] });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    }) as unknown as typeof fetch;

    const ok = await hydrateHoldingsFromServer();
    expect(ok).toBe(false);
    const h = usePortfolioStore.getState().holdings;
    expect(h).toHaveLength(1);
    expect(h[0].symbol).toBe('2330.TW');
  });

  test('fetch throw（網路斷）：回 false 且保留現有 holdings', async () => {
    usePortfolioStore.setState({ holdings: [mkExisting()] });
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const ok = await hydrateHoldingsFromServer();
    expect(ok).toBe(false);
    expect(usePortfolioStore.getState().holdings).toHaveLength(1);
  });
});
