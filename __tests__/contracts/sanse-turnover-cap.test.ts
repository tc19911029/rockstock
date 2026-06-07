/**
 * 三色 universe 成交額粗篩（top-N）合約測試（鐵律 #7）。
 *
 * 鎖住三件不變量：
 *   1. TOP_N 數字對齊書本買法 MarketScanner.prefilterByL2（TW 500 / CN 800）—
 *      改動其一就必須同步、否則「跟其他策略一樣篩成交額前幾」的承諾破裂。
 *   2. topTurnoverRanks 純函式：不足 topN 全收（不誤殺）、超過則只留成交額最高的前 N 檔，
 *      且名次正確（1 = 成交額最大）。
 *   3. 端對端：scanSanSe 確實「套用」了 cap — fresh > topN 時只有成交額最高的前 N 檔進選股，
 *      其餘標記為 turnoverFiltered；evaluated = 入圍 universe 數。
 *      （有人把 cap 從 scan 拿掉，這條會立刻紅。）
 */
import type { Candle } from '@/types';

// ── Fixtures（端對端用）─────────────────────────────────────────────────────
const D_1 = '2026-05-28'; // 封存 frontier（盤後最新）

/** 產 n 根遞增日K，成交量固定 = volBase（讓「最後一根 close×volume」三檔各不同 → 可排序）。 */
function genCandles(endDate: string, n: number, volBase: number): Candle[] {
  const dates: string[] = [];
  const d = new Date(endDate + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.map((date, i) => {
    const base = 10 + i * 0.05;
    return { date, open: base, high: base * 1.02, low: base * 0.98, close: base, volume: volBase };
  });
}

// 三檔正常股，成交額 high(300k) > mid(200k) > low(100k)；皆封存到昨日 → 都 fresh。
const CANDLE_MAP: Record<string, Candle[]> = {
  '000001.SS': genCandles(D_1, 260, 100_000), // 大盤指數（不進股票池）
  '600001.SS': genCandles(D_1, 260, 300_000), // high turnover
  '600002.SS': genCandles(D_1, 260, 200_000), // mid
  '600003.SS': genCandles(D_1, 260, 100_000), // low → topN=1/2 時被剔
};

// universe 改用 CN_STOCKS（取代本地 cn_stocklist.json）
jest.mock('@/lib/scanner/cnStocks', () => ({
  CN_STOCKS: [
    { symbol: '600001.SS', name: '高量股' },
    { symbol: '600002.SS', name: '中量股' },
    { symbol: '600003.SS', name: '低量股' },
  ],
}));

// K 線改走 Blob-aware adapter（不再 raw fs），記憶體 fixture 餵 readCandleFile
jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: jest.fn(async (symbol: string) => {
    const c = CANDLE_MAP[symbol];
    return c ? { candles: c } : null;
  }),
}));

// 成交額索引不存在 → readTurnoverRank null → 前置粗掃帽 degrade to full；
// 端對端的 cap 由 scan 內 topTurnoverRanks(freshTurnovers, topN) 套用（本測試鎖的正是這條）。
jest.mock('@/lib/scanner/TurnoverRank', () => ({
  readTurnoverRank: jest.fn(async () => null),
  computeTurnoverRankAsOfDate: jest.fn(async () => new Map()),
}));

// 在 mock 宣告之後 import（ts-jest commonjs）
import { SANSE_TURNOVER_TOP_N, topTurnoverRanks } from '@/lib/cn-sanse/scan';
import { scanSanSe } from '@/lib/cn-sanse/scan';

// ───────────── Part 1：純函式 + 常數 ─────────────
describe('三色 universe 成交額粗篩 — 常數與純函式', () => {
  test('TOP_N 對齊書本買法：TW 500 / CN 800', () => {
    expect(SANSE_TURNOVER_TOP_N.TW).toBe(500);
    expect(SANSE_TURNOVER_TOP_N.CN).toBe(800);
  });

  test('不足 topN → 全收（不誤殺正常股），名次照成交額排', () => {
    const u = topTurnoverRanks(
      [{ symbol: 'A', turnover: 10 }, { symbol: 'B', turnover: 5 }],
      800,
    );
    expect(u.size).toBe(2);
    expect(u.get('A')).toBe(1); // 成交額較大 → 第 1 名
    expect(u.get('B')).toBe(2);
  });

  test('超過 topN → 只留成交額最高的前 N 檔，名次 1=最大、冷門薄量股被剔除', () => {
    const u = topTurnoverRanks(
      [{ symbol: 'low', turnover: 1 }, { symbol: 'mid', turnover: 50 }, { symbol: 'high', turnover: 100 }],
      2,
    );
    expect(u.size).toBe(2);
    expect(u.get('high')).toBe(1);
    expect(u.get('mid')).toBe(2);
    expect(u.has('low')).toBe(false);
  });
});

// ───────────── Part 2：端對端 — scanSanSe 確實套用 cap ─────────────
describe('三色掃描端對端套用成交額 cap', () => {
  test('topN=1 → 只有成交額最高的一檔進選股，其餘 turnoverFiltered', async () => {
    const r = await scanSanSe({ topN: 1 });
    expect(r.evaluated).toBe(1);             // 入圍 universe = 1 檔
    expect(r.turnoverFiltered).toBe(2);      // 中量+低量被剔
    expect(r.turnoverCap).toBe(1);
    const syms = [
      ...r.results.strict, ...r.results.medium, ...r.results.loose,
    ].map((h) => h.symbol).concat(r.records.map((x) => x.symbol));
    for (const s of syms) {
      expect(s).not.toBe('600002.SS');       // 中量被剔
      expect(s).not.toBe('600003.SS');       // 低量被剔
    }
  });

  test('topN ≥ fresh 數 → 全收、不剔除', async () => {
    const r = await scanSanSe({ topN: 10 });
    expect(r.evaluated).toBe(3);
    expect(r.turnoverFiltered).toBe(0);
  });
});
