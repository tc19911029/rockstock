/**
 * Contract test：^TWII 大盤指數今日 bar 來源 (fetchTWIndexQuote)
 *
 * 背景（2026-06-09）：個股走圖用 getTWSEQuote(pureCode) 直抓今日 bar，但 ^TWII 沒有數字
 * code、個股報價端點對指數無效 → 過去只能靠 L2 snapshot fallback，快照在斷線期間刷新掉
 * 指數時走圖就停在昨日。修法是讓 route 注入鏈對 ^TWII 直接呼叫 fetchTWIndexQuote(t00)。
 *
 * 守的規則：
 *   - fetchTWIndexQuote 解析 mis.twse tse_t00 → 回 symbol:'^TWII' 的 OHLCV + prevClose/漲幅
 *   - 日期守門：mis 回非今日（盤前殘留上一交易日）→ 回 null（不可注入假今日 bar）
 *   - z='-'（休市/盤前無成交）→ 回 null
 *
 * 純單元測試，mock fetch 不打外部 API（避免 CI flaky）。
 */

import { fetchTWIndexQuote } from '@/lib/datasource/IntradayCache';

// mis.twse tse_t00 典型回應（z=成交, y=昨收, o/h/l, m=累計量, d=日期 YYYYMMDD）
const T00_OK = {
  msgArray: [{
    c: 't00', n: '發行量加權股價指數',
    z: '44382.35', y: '43502.78', o: '43900.00', h: '44400.00', l: '43850.00',
    m: '123456789', d: '20260609', ex: 'tse', ch: 't00.tw',
  }],
};

function mockFetch(payload: unknown, ok = true) {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify(payload), { status: ok ? 200 : 500 }),
  ) as unknown as typeof fetch;
}

describe('^TWII 指數今日 bar 來源 — fetchTWIndexQuote', () => {
  let realFetch: typeof fetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  test('解析 tse_t00 → 回 ^TWII 的 OHLCV + 漲幅', async () => {
    mockFetch(T00_OK);
    const q = await fetchTWIndexQuote('2026-06-09');
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe('^TWII');
    expect(q!.close).toBeCloseTo(44382.35, 2);
    expect(q!.prevClose).toBeCloseTo(43502.78, 2);
    expect(q!.open).toBeCloseTo(43900, 2);
    expect(q!.high).toBeCloseTo(44400, 2);
    expect(q!.low).toBeCloseTo(43850, 2);
    // (44382.35 - 43502.78) / 43502.78 × 100 ≈ 2.02%
    expect(q!.changePercent).toBeCloseTo(2.02, 1);
    expect(q!.volume).toBeGreaterThan(0);
  });

  test('日期守門：mis 回非今日（盤前殘留） → null，不注入假今日 bar', async () => {
    mockFetch({ msgArray: [{ ...T00_OK.msgArray[0], d: '20260608' }] });
    const q = await fetchTWIndexQuote('2026-06-09');
    expect(q).toBeNull();
  });

  test("z='-'（盤前/休市無成交）→ null", async () => {
    mockFetch({ msgArray: [{ ...T00_OK.msgArray[0], z: '-' }] });
    const q = await fetchTWIndexQuote('2026-06-09');
    expect(q).toBeNull();
  });

  test('HTTP 非 200 → null（不 throw）', async () => {
    mockFetch({}, false);
    const q = await fetchTWIndexQuote('2026-06-09');
    expect(q).toBeNull();
  });
});
