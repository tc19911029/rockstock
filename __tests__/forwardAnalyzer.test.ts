/**
 * ForwardAnalyzer 測試 — 驗證連假缺口場景
 *
 * 核心場景：本地 K 線停在連假前（如 04-02），連假後（04-07）數據缺失。
 * ForwardAnalyzer 應偵測到缺口並用 API 補足，而非使用不完整的本地數據。
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock loadLocalCandles — 模擬本地 K 線只到 04-02（清明連假前）
const mockLocalCandles = jest.fn();
jest.mock('../lib/datasource/LocalCandleStore', () => ({
  loadLocalCandles: (...args: unknown[]) => mockLocalCandles(...args),
}));

// Mock dataProvider.getCandlesRange — 0514 改用 MultiMarketProvider 多源 fallback
// （原本只走 Yahoo，TW 對 Yahoo Chart Node fetch 不穩 → forward 缺日）
const mockFetchRange = jest.fn();
jest.mock('../lib/datasource/MultiMarketProvider', () => ({
  dataProvider: {
    getCandlesRange: (...args: unknown[]) => mockFetchRange(...args),
  },
}));

// Mock rateLimiter
jest.mock('../lib/datasource/UnifiedRateLimiter', () => ({
  rateLimiter: {
    acquire: jest.fn().mockResolvedValue(undefined),
    reportSuccess: jest.fn(),
  },
}));

// Mock IntradayCache — 否則 ForwardAnalyzer 走真實 fs 拿 L2 snapshot 注入今日 K 棒，
// 導致 mockFetchRange 不被呼叫（pre-existing test failure，2026-05-08 修）
jest.mock('../lib/datasource/IntradayCache', () => ({
  readIntradaySnapshot: jest.fn().mockResolvedValue(null),
  refreshIntradaySnapshot: jest.fn(),
  getLastRefreshSummary: jest.fn(),
}));

import { analyzeForwardBatch } from '../lib/backtest/ForwardAnalyzer';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCandle(date: string, close: number, open = close * 0.99) {
  return {
    date, open, high: close * 1.02, low: close * 0.98,
    close, volume: 1_000_000,
  };
}

/** 本地數據：2026-03-27 ~ 2026-04-02（清明前最後交易日） */
const LOCAL_CANDLES_UNTIL_0402 = [
  makeCandle('2026-03-25', 50),
  makeCandle('2026-03-26', 51),
  makeCandle('2026-03-27', 52),
  makeCandle('2026-03-30', 51),
  makeCandle('2026-03-31', 53),
  makeCandle('2026-04-01', 54),
  makeCandle('2026-04-02', 55), // ← 最後一根，04-03~04-06 放假
];

/** API 回傳：連假後的數據 */
const API_CANDLES_AFTER_HOLIDAY = [
  makeCandle('2026-04-07', 56),
  makeCandle('2026-04-08', 57),
];

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // 固定「今天」為 2026-04-08，避免測試結果受實際日期影響
  jest.useFakeTimers();
  // 設定為 2026-04-08 15:00 UTC+8 = 2026-04-08 07:00 UTC
  jest.setSystemTime(new Date('2026-04-08T07:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ForwardAnalyzer — 連假缺口補足', () => {
  test('本地數據停在連假前，應用 API 補足缺口', async () => {
    // 本地有 K 線但只到 04-02
    mockLocalCandles.mockResolvedValue(LOCAL_CANDLES_UNTIL_0402);
    // API 回傳 04-07, 04-08（只補缺口部分）
    mockFetchRange.mockResolvedValue(API_CANDLES_AFTER_HOLIDAY);

    const { results } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    const perf = results[0];

    // d1 = 04-02 (本地保留), d2 = 04-07 (API 補足)
    expect(perf.d1Return).not.toBeNull();
    expect(perf.d2Return).not.toBeNull();
    // 應該有呼叫 API 補足，且 fetchStart 從 04-03 開始（nextDay of lastLocal 04-02）
    expect(mockFetchRange).toHaveBeenCalled();
    const fetchStart = mockFetchRange.mock.calls[0][1];
    expect(fetchStart).toBe('2026-04-03');
  });

  test('本地數據完全空白時，整段走 API', async () => {
    mockLocalCandles.mockResolvedValue(null);
    mockFetchRange.mockResolvedValue([
      makeCandle('2026-04-02', 55),
      ...API_CANDLES_AFTER_HOLIDAY,
    ]);

    // scanPrice 設為接近首根 K 線 close，避免 sanitizeCandles 的 15% 跳空閘
    // 把整批 candle 全部誤刪後進入 setTimeout retry 路徑（fake timer 下會 hang）
    const { results } = await analyzeForwardBatch(
      [{ symbol: '6419.TWO', name: '京晨科', scanPrice: 54 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    expect(results[0].d1Return).not.toBeNull();
    expect(mockFetchRange).toHaveBeenCalled();
  });

  test('本地數據已涵蓋到今天，不打 API', async () => {
    const fullCandles = [
      ...LOCAL_CANDLES_UNTIL_0402,
      ...API_CANDLES_AFTER_HOLIDAY,
    ];
    mockLocalCandles.mockResolvedValue(fullCandles);

    const { results } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    expect(results[0].d1Return).not.toBeNull();
    // 本地數據完整 → 不需要打 API
    expect(mockFetchRange).not.toHaveBeenCalled();
  });

  test('週一盤前、本地停在上週五：近期掃描日不為「今日(無收盤資料)」空打 API（regression）', async () => {
    // 場景重現「又沒有漲跌幅」：週一 08:00 盤前，本地 L1 還停在上週五 05-29。
    // 舊碼 safeEndStr 壓到今日 06-01 → needSupplement 對每檔打 FinMind 補週末+今日缺口
    //（無資料）→ 50 檔批次超時 → UI 漲跌幅全空。
    // 修正後：補抓上限取 getLastTradingDay = 05-29 → 不打 API，直接用本地算 d1~d3。
    jest.setSystemTime(new Date('2026-06-01T00:00:00Z')); // 週一 08:00 CST（盤前）
    const localUntilFri = [
      makeCandle('2026-05-22', 100),
      makeCandle('2026-05-26', 102),
      makeCandle('2026-05-27', 104),
      makeCandle('2026-05-28', 106),
      makeCandle('2026-05-29', 108),
    ];
    mockLocalCandles.mockResolvedValue(localUntilFri);
    mockFetchRange.mockResolvedValue([]); // 即使誤打也無資料

    const { results } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 102 }],
      '2026-05-26',
    );

    expect(results).toHaveLength(1);
    // 用本地 05-27 / 05-28 / 05-29 算出 d1 / d2 / d3（有漲跌幅）
    expect(results[0].d1Return).not.toBeNull();
    expect(results[0].d3Return).not.toBeNull();
    // 關鍵不變量：不為了「今日(盤前無收盤 K)」去打 FinMind 補抓 → 否則整批超時空白
    expect(mockFetchRange).not.toHaveBeenCalled();
  });

  test('掃描日就是最後收盤交易日（forward 窗口完全無資料）：不空打 API、秒回待定（regression：又沒漲跌幅）', async () => {
    // 本次「又沒有漲跌幅」根因，與上一個 test 的差別：
    // 這裡 scanDate = 最後收盤交易日「本身」(05-29)，本地 L1 也只到 05-29 →
    // loadForwardFromLocal(05-30..) 為空 → candles.length === 0。
    // 舊碼把「safeEndStr 壓到 lastClosed」的 cap 包在 `if (candles.length > 0)` 裡，
    // candles 為空時整段被跳過 → safeEndStr 仍 = 今日 06-01 → needSupplement(candles.length===0)
    // 對不存在的今日/週末 K 去打限流中的 FinMind，單檔卡 40-80s、整批 forward POST 超時 → 漲跌幅全空。
    // 修正後：cap 移出 → safeEndStr=05-29，且 startStr(05-30) > safeEndStr → needSupplement=false → 不打 API。
    jest.setSystemTime(new Date('2026-06-01T00:00:00Z')); // 週一 08:00 CST（盤前，今日尚未開盤）
    mockLocalCandles.mockResolvedValue([
      makeCandle('2026-05-27', 104),
      makeCandle('2026-05-28', 106),
      makeCandle('2026-05-29', 108), // ← 本地最後一根 = 掃描日 = 最後收盤交易日
    ]);
    mockFetchRange.mockResolvedValue([]); // 即使誤打也無資料

    const { results, nullCount } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 108 }],
      '2026-05-29',
    );

    expect(results).toHaveLength(1);
    // 關鍵不變量：scanDate 之後尚無「已收盤交易日」→ 不可為了「今日」空打 FinMind（否則整批超時）
    expect(mockFetchRange).not.toHaveBeenCalled();
    // 近期掃描（≤3 天）回待定結構：漲跌幅為 null（無未來資料）但不計為 null（非倖存者偏差）
    expect(nullCount).toBe(0);
    expect(results[0].d1Return).toBeNull();
  });

  test('隔日一字漲停：openReturn 照實顯示開盤缺口(+10%)，但 nextOpenPrice 維持 null（買不到）', async () => {
    // 用戶 2026-06-02 要求：隔日開盤若一字漲停，「隔日開」欄照實寫 % 數（如 +10%），
    // 不再因「散戶買不到」而留空「—」（會跟「無資料」混淆）。
    // 關鍵：只解耦顯示用的 openReturn；可成交進場價 nextOpenPrice / *FromOpen 仍須 null。
    // 掃描日 04-01 收 54；隔日 04-02 一字鎖死 59.4（open=high=low=close，+10%）
    const locked = { date: '2026-04-02', open: 59.4, high: 59.4, low: 59.4, close: 59.4, volume: 1_000_000 };
    mockLocalCandles.mockResolvedValue([
      makeCandle('2026-03-31', 53),
      makeCandle('2026-04-01', 54),
      locked,
      makeCandle('2026-04-07', 60),
    ]);
    mockFetchRange.mockResolvedValue([]);

    const { results } = await analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-01',
    );

    expect(results).toHaveLength(1);
    const perf = results[0];
    // 隔日開漲跌幅 = (59.4 - 54)/54 = +10% → 照實顯示，不再是 null
    expect(perf.openReturn).toBeCloseTo(10, 5);
    // 但可成交進場價維持 null（一字板買不到）→ 對齊回測進場、不誤導
    expect(perf.nextOpenPrice).toBeNull();
    expect(perf.d1ReturnFromOpen).toBeNull();
  });

  test('掃描日距今 ≤3 天且無數據，回傳待定結構而非 null', async () => {
    // 設定今天為 04-08，掃描日 04-07 = 距今 1 天
    mockLocalCandles.mockResolvedValue([]);
    mockFetchRange.mockResolvedValue([]);

    // analyzeOne 的 retry 路徑有 setTimeout(2000)，需要推進 fake timer
    const promise = analyzeForwardBatch(
      [{ symbol: '2330.TW', name: '台積電', scanPrice: 54 }],
      '2026-04-07',
    );
    // 推進 timer 讓 retry setTimeout 完成
    await jest.advanceTimersByTimeAsync(3000);

    const { results, nullCount } = await promise;

    // 近期掃描不應算作 null（避免倖存者偏差）
    expect(results).toHaveLength(1);
    expect(nullCount).toBe(0);
    expect(results[0].d1Return).toBeNull(); // 數據尚未產生
  });
});
