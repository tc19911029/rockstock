/**
 * 三色資金（台股）「盤中即時掃描」合約測試（鐵律 #7）。
 * 對齊 cn-sanse-intraday：用 fixture 餵 scanTwSanSe 盤中模式，鎖住三件最關鍵行為：
 *   1. 缺口防護（critical）：封存 K 線最後一根不是「前一交易日」的股票（停牌復牌 / 漏抓昨日），
 *      即使盤中有即時報價，也不可被貼成今日 → 必須當 staleSkipped 淘汰，不得進選股。
 *   2. archivedDate / sessionType 正確標記。
 *   3. 正常股（封存對齊昨日）盤中有報價 → 合成今日 bar 後納入評估。
 * 台股單一指數 ^TWII（無滬深雙基準）。不碰真實磁碟/網路：mock fs + LocalCandleStore + conceptMap。
 */
import type { Candle } from '@/types';

const D = '2026-05-29';   // 今日（盤中進行中）
const D_1 = '2026-05-28'; // 前一交易日（封存 frontier）
const D_2 = '2026-05-27'; // 再前一日

function genCandles(endDate: string, n: number): Candle[] {
  const dates: string[] = [];
  const d = new Date(endDate + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.map((date, i) => {
    const base = 100 + i * 0.05;
    return { date, open: base, high: base * 1.02, low: base * 0.98, close: base, volume: 200_000 + i * 100 };
  });
}

const CANDLE_MAP: Record<string, Candle[]> = {
  '^TWII': genCandles(D_1, 260),       // 加權指數，封存到昨日
  '2330.TW': genCandles(D_1, 260),     // 正常股 A，封存到昨日
  '6654.TWO': genCandles(D_1, 260),    // 上櫃正常股 B，封存到昨日
  '1234.TW': genCandles(D_2, 259),     // 缺口股：封存只到前天（漏抓昨日 / 停牌復牌）
};

const MASTER = {
  entries: [
    { code: '2330', name: '台積電', market: 'TWSE', aliases: [] },
    { code: '6654', name: '天正國際', market: 'TPEx', aliases: [] },
    { code: '1234', name: '測試停牌', market: 'TWSE', aliases: [] },
  ],
};

// 不打網路：stub TWSE 產業 fetch（保留真實 getTWConcept）
jest.mock('@/lib/scanner/conceptMap', () => ({
  ...jest.requireActual('@/lib/scanner/conceptMap'),
  fetchTWIndustryMap: jest.fn().mockResolvedValue(new Map()),
}));

// K 線 / universe 改走 Blob-aware adapter（本地 FS、Vercel Blob），不再 raw fs + readdir
jest.mock('@/lib/datasource/CandleStorageAdapter', () => ({
  readCandleFile: jest.fn(async (symbol: string) => {
    const c = CANDLE_MAP[symbol];
    return c ? { candles: c } : null;
  }),
  listCandleSymbols: jest.fn(async () => Object.keys(CANDLE_MAP)),
}));

// 成交額索引不存在 → readTurnoverRank null → 前置粗掃帽 degrade to full（缺口防護/新鮮度照驗）
jest.mock('@/lib/scanner/TurnoverRank', () => ({
  readTurnoverRank: jest.fn(async () => null),
  computeTurnoverRankAsOfDate: jest.fn(async () => new Map()),
}));

// loadNameMap 仍從 stock-master.json（fs）補中文名
jest.mock('fs/promises', () => ({
  readFile: jest.fn(async (p: string) => {
    const s = String(p);
    if (s.includes('stock-master')) return JSON.stringify(MASTER);
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

// scanTwSanSe 必須在 mock 宣告之後 import
import { scanTwSanSe } from '@/lib/tw-sanse/scan';

const BAR = { open: 130, high: 132, low: 129, close: 131, volume: 300_000 };

describe('tw-sanse 盤中即時掃描合約', () => {
  it('缺口股（封存非昨日）即使有盤中報價也被淘汰，不進選股（critical）', async () => {
    const quotes = new Map([
      ['2330', BAR],
      ['6654', BAR],
      ['1234', BAR], // 缺口股也給報價 — 若無防護會被貼成今日而誤評估
    ]);
    const indexBars = new Map([['^TWII', BAR]]);
    const result = await scanTwSanSe({ intraday: { date: D, quotes, indexBars } });

    expect(result.sessionType).toBe('intraday');
    expect(result.lastDate).toBe(D);          // 合成今日為最後一根
    expect(result.archivedDate).toBe(D_1);    // 封存 frontier = 昨日

    // 只有兩檔正常股被評估；缺口股被新鮮度檢查淘汰（防護生效）
    expect(result.evaluated).toBe(2);
    expect(result.staleSkipped).toBe(1);
  });

  it('盤後模式：archivedDate === lastDate，缺口股同樣淘汰', async () => {
    const result = await scanTwSanSe(); // 無 intraday → 盤後封存

    expect(result.sessionType).toBe('post_close');
    expect(result.lastDate).toBe(D_1);        // 封存最新 = 昨日
    expect(result.archivedDate).toBe(D_1);    // 盤後兩者一致
    expect(result.evaluated).toBe(2);         // 1234 last=前天 ≠ 昨日 → staleSkipped
    expect(result.staleSkipped).toBe(1);
  });
});
