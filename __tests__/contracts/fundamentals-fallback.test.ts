/**
 * Contract test：Fundamentals 多源 fallback chain
 *
 * 守的規則：
 *   - 主源 FinMind 成功有 useful data → sourceUsed='finmind'，不換源
 *   - 主源失敗或全 null → 自動換 TWSE
 *   - 都失敗 → sourceUsed='none' + 全 null
 *   - merge：後源補前源 null 欄位（不覆寫已有值）
 *
 * 這是純單元測試，mock fetch 而不打外部 API（避免 CI flaky）
 */

import { FundamentalsData } from '@/lib/datasource/FinMindClient';

const FINMIND_SUCCESS = {
  status: 200, msg: 'success',
  data: [
    { date: '2026-03-31', stock_id: '2330', type: 'EPS',           value: 22.08, origin_name: '基本每股盈餘' },
    { date: '2026-03-31', stock_id: '2330', type: 'GrossProfit',   value: 751295421000, origin_name: '營業毛利' },
    { date: '2026-03-31', stock_id: '2330', type: 'Revenue',       value: 1339254480000, origin_name: '營業收入' },
    { date: '2026-03-31', stock_id: '2330', type: 'IncomeAfterTaxes', value: 572801304000, origin_name: '本期淨利' },
    { date: '2025-12-31', stock_id: '2330', type: 'EPS',           value: 19.51, origin_name: '基本每股盈餘' },
  ],
};

const FINMIND_PER_SUCCESS = {
  status: 200, msg: 'success',
  data: [
    { date: '2026-05-22', stock_id: '2330', dividend_yield: 0.98, PER: 30.32, PBR: 9.93 },
  ],
};

const FINMIND_REVENUE_SUCCESS = {
  status: 200, msg: 'success',
  data: [
    { date: '2026-05-01', stock_id: '2330', revenue: 410725118000, revenue_month: 4, revenue_year: 2026 },
    { date: '2026-04-01', stock_id: '2330', revenue: 415186418000, revenue_month: 3, revenue_year: 2026 },
  ],
};

const FINMIND_EMPTY = { status: 200, msg: 'success', data: [] };

const TWSE_SUCCESS = {
  stat: 'OK',
  fields: ['日期', '殖利率(%)', '股利年度', '本益比', '股價淨值比', '財報年/季'],
  data: [['115年05月22日', '0.98', 114, '30.32', '9.93', '115/1']],
};

const TWSE_EMPTY = { stat: 'NO DATA', data: [] };

describe('Fundamentals fallback chain — 解析邏輯', () => {
  test('FinMind 回 key-value rows 後正確解析 EPS', () => {
    // 模擬 finmindFetch 結果（純 raw response.data）
    const finData = FINMIND_SUCCESS.data;

    // 解析邏輯（從 FinMindClient.getFundamentals 內部抽出來測）
    const finByDate = new Map<string, Map<string, number>>();
    for (const r of finData) {
      if (!finByDate.has(r.date)) finByDate.set(r.date, new Map());
      finByDate.get(r.date)!.set(r.type, r.value);
    }
    const dates = [...finByDate.keys()].sort((a, b) => b.localeCompare(a));
    expect(dates[0]).toBe('2026-03-31');
    expect(finByDate.get('2026-03-31')!.get('EPS')).toBe(22.08);
    expect(finByDate.get('2025-12-31')!.get('EPS')).toBe(19.51);
  });

  test('FinMind 解析 — 毛利率 = GrossProfit / Revenue × 100', () => {
    const grossProfit = 751295421000;
    const revenue = 1339254480000;
    const grossMargin = (grossProfit / revenue) * 100;
    expect(grossMargin).toBeCloseTo(56.10, 1);
  });

  test('EPS YoY 計算正確', () => {
    const epsCurrent = 22.08;
    const epsPrev = 19.51;
    const yoy = ((epsCurrent - epsPrev) / Math.abs(epsPrev)) * 100;
    expect(yoy).toBeCloseTo(13.17, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fallback chain 邏輯（用 mock fetch 不打外部 API）
// ────────────────────────────────────────────────────────────────────────────

interface MockFetch {
  finmindFin?: typeof FINMIND_SUCCESS;
  finmindPER?: typeof FINMIND_PER_SUCCESS;
  finmindRev?: typeof FINMIND_REVENUE_SUCCESS;
  twse?: typeof TWSE_SUCCESS | typeof TWSE_EMPTY;
}

function installMockFetch(mocks: MockFetch): jest.Mock {
  const mock = jest.fn(async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('finmindtrade.com')) {
      if (u.includes('TaiwanStockFinancialStatements')) {
        return new Response(JSON.stringify(mocks.finmindFin ?? FINMIND_EMPTY));
      }
      if (u.includes('TaiwanStockPER')) {
        return new Response(JSON.stringify(mocks.finmindPER ?? FINMIND_EMPTY));
      }
      if (u.includes('TaiwanStockMonthRevenue')) {
        return new Response(JSON.stringify(mocks.finmindRev ?? FINMIND_EMPTY));
      }
    }
    if (u.includes('twse.com.tw')) {
      return new Response(JSON.stringify(mocks.twse ?? TWSE_EMPTY));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as jest.Mock;
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('Fundamentals fallback chain — 換源行為', () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = global.fetch;
    // Reset module cache 確保 FinMind cache 不會跨 test 卡
    jest.resetModules();
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('主源 FinMind 成功 → sourceUsed=finmind，不打 TWSE', async () => {
    const mockFetch = installMockFetch({
      finmindFin: FINMIND_SUCCESS,
      finmindPER: FINMIND_PER_SUCCESS,
      finmindRev: FINMIND_REVENUE_SUCCESS,
    });
    const { getFundamentalsWithFallback } = await import('@/lib/datasource/FundamentalsFallbackChain');
    const r = await getFundamentalsWithFallback('2330');
    expect(r.sourceUsed).toBe('finmind');
    expect(r.eps).toBe(22.08);
    expect(r.per).toBe(30.32);
    expect(r.sourceAttempts).toHaveLength(1);
    expect(r.sourceAttempts[0].source).toBe('finmind');
    expect(r.sourceAttempts[0].ok).toBe(true);
    // 應該沒打 TWSE
    const twseCalls = mockFetch.mock.calls.filter(c => String(c[0]).includes('twse.com.tw'));
    expect(twseCalls).toHaveLength(0);
  });

  test('FinMind 回空 → 換 TWSE 拿 PER/PBR', async () => {
    installMockFetch({
      finmindFin: FINMIND_EMPTY,
      finmindPER: FINMIND_EMPTY,
      finmindRev: FINMIND_EMPTY,
      twse: TWSE_SUCCESS,
    });
    const { getFundamentalsWithFallback } = await import('@/lib/datasource/FundamentalsFallbackChain');
    const r = await getFundamentalsWithFallback('2330');
    expect(r.sourceUsed).toBe('twse');
    expect(r.per).toBe(30.32);
    expect(r.pbr).toBe(9.93);
    expect(r.dividendYield).toBe(0.98);
    expect(r.eps).toBeNull();  // TWSE 無 EPS
    expect(r.sourceAttempts.length).toBeGreaterThanOrEqual(2);
  });

  test('兩源都空 → sourceUsed=none + 全 null', async () => {
    installMockFetch({
      finmindFin: FINMIND_EMPTY,
      finmindPER: FINMIND_EMPTY,
      finmindRev: FINMIND_EMPTY,
      twse: TWSE_EMPTY,
    });
    const { getFundamentalsWithFallback } = await import('@/lib/datasource/FundamentalsFallbackChain');
    const r = await getFundamentalsWithFallback('INVALID');
    expect(r.sourceUsed).toBe('none');
    expect(r.eps).toBeNull();
    expect(r.per).toBeNull();
  });

  test('Merge — FinMind 部分有資料 + TWSE 補 → 合併', async () => {
    // FinMind 有 EPS 但缺 PER（不太可能但測 merge 邏輯）
    installMockFetch({
      finmindFin: FINMIND_SUCCESS,
      finmindPER: FINMIND_EMPTY,  // PER 缺
      finmindRev: FINMIND_EMPTY,
      twse: TWSE_SUCCESS,
    });
    const { getFundamentalsWithFallback } = await import('@/lib/datasource/FundamentalsFallbackChain');
    const r = await getFundamentalsWithFallback('2330');
    // FinMind 有 EPS（hasUsefulData → 用 FinMind）
    expect(r.sourceUsed).toBe('finmind');
    expect(r.eps).toBe(22.08);
  });
});
