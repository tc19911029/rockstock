/**
 * 三色資金「盤中即時掃描」合約測試（鐵律 #7）。
 *
 * 用 fixture 餵 scanSanSe 的盤中模式，鎖住三件最關鍵的行為：
 *   1. 缺口防護（critical）：封存 K 線最後一根不是「前一交易日」的股票（停牌復牌 / 漏抓昨日），
 *      即使盤中有即時報價，也不可被貼成今日 → 必須當 staleSkipped 淘汰，不得進選股。
 *   2. archivedDate / sessionType 正確標記（前端判走圖是否真落後用）。
 *   3. 正常股（封存對齊昨日）盤中有報價 → 合成今日 bar 後納入評估。
 *
 * 不碰真實磁碟：mock 掉 LocalCandleStore 與 fs/promises，全用記憶體 fixture。
 */
import type { Candle } from '@/types';

// ── Fixtures ────────────────────────────────────────────────────────────────
const D = '2026-05-29';        // 今日（盤中進行中）
const D_1 = '2026-05-28';      // 前一交易日（封存 frontier）
const D_2 = '2026-05-27';      // 再前一日

/** 產 n 根遞增日K，日期序列以 endDate 結尾（往前推算曆日；指標位置式，不在意週末）。 */
function genCandles(endDate: string, n: number): Candle[] {
  const dates: string[] = [];
  const d = new Date(endDate + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.map((date, i) => {
    const base = 10 + i * 0.05;
    return { date, open: base, high: base * 1.02, low: base * 0.98, close: base, volume: 100_000 + i * 100 };
  });
}

const CANDLE_MAP: Record<string, Candle[]> = {
  '000001.SS': genCandles(D_1, 260),          // 大盤指數，封存到昨日
  '600001.SS': genCandles(D_1, 260),          // 正常股 A，封存到昨日
  '600002.SS': genCandles(D_1, 260),          // 正常股 B，封存到昨日
  '600003.SS': genCandles(D_2, 259),          // 缺口股：封存只到前天（漏抓昨日 / 停牌復牌）
};

const STOCKLIST = {
  stocks: [
    { symbol: '600001.SS', name: '測試一', industry: 'X' },
    { symbol: '600002.SS', name: '測試二', industry: 'X' },
    { symbol: '600003.SS', name: '缺口股', industry: 'X' },
  ],
};

jest.mock('@/lib/datasource/LocalCandleStore', () => ({
  getLocalCandleDir: () => '/fake/candles/CN',
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(async (p: string) => {
    const s = String(p);
    if (s.includes('cn_stocklist')) return JSON.stringify(STOCKLIST);
    const base = s.split('/').pop()!.replace('.json', '');
    if (CANDLE_MAP[base]) return JSON.stringify({ candles: CANDLE_MAP[base] });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

// scanSanSe 必須在 mock 宣告之後 require（ts-jest commonjs）
import { scanSanSe } from '@/lib/cn-sanse/scan';

const BAR = { open: 25, high: 26, low: 24, close: 25, volume: 200_000 };

describe('cn-sanse 盤中即時掃描合約', () => {
  it('缺口股（封存非昨日）即使有盤中報價也被淘汰，不進選股（critical）', async () => {
    const quotes = new Map([
      ['600001', BAR],
      ['600002', BAR],
      ['600003', BAR], // 缺口股也給報價 — 若無防護會被貼成今日而誤評估
    ]);
    const result = await scanSanSe({ intraday: { date: D, quotes, indexBar: BAR } });

    expect(result.sessionType).toBe('intraday');
    expect(result.lastDate).toBe(D);          // 合成今日為最後一根
    expect(result.archivedDate).toBe(D_1);    // 封存 frontier = 昨日

    // 只有兩檔正常股被評估；缺口股被新鮮度檢查淘汰（防護生效）
    expect(result.evaluated).toBe(2);
    expect(result.staleSkipped).toBe(1);
  });

  it('盤後模式：archivedDate === lastDate，缺口股同樣淘汰', async () => {
    const result = await scanSanSe(); // 無 intraday → 盤後封存

    expect(result.sessionType).toBe('post_close');
    expect(result.lastDate).toBe(D_1);        // 封存最新 = 昨日
    expect(result.archivedDate).toBe(D_1);    // 盤後兩者一致
    expect(result.evaluated).toBe(2);         // 600003 last=前天 ≠ 昨日 → staleSkipped
    expect(result.staleSkipped).toBe(1);
  });
});
