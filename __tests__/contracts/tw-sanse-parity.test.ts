/**
 * 三色資金（台股）合約測試（鐵律 #7）。
 *
 * 鎖住三件 promote 台股三色時最關鍵的不變量：
 *   1. 掃描 ↔ 走圖 條件一致：掃描傳 precomputed series 進 evalConditions，走圖則讓它自己重算 series；
 *      兩者必須產出完全相同的 ConditionReport，否則掃描清單與走圖條件面板會各說各話。
 *   2. scanTwSanSe 股票池過濾：ETF(00xx)/存託憑證 DR(名稱含 DR)/指數 ^TWII 不可進池；
 *      封存非當日的停牌股必須 staleSkipped；公司名要從 stock-master 補上（非裸代號）。
 *   3. 台股捕撈季節門檻必須低於陸股（台股周轉率結構性偏低；calibrate-tw-season-tiers 校準）。
 *
 * 不碰真實磁碟：mock fs/promises + LocalCandleStore，全用記憶體 fixture。
 */
import type { Candle } from '@/types';
import { computeSanSe } from '@/lib/cn-sanse/selectors';
import { evalConditions, COMBO_RANK } from '@/lib/cn-sanse/conditions';
import { CN_TIER_THRESHOLDS, TW_TIER_THRESHOLDS } from '@/lib/cn-sanse/indicators';

// ── Fixtures ────────────────────────────────────────────────────────────────
const D_1 = '2026-05-28'; // 封存 frontier（盤後最新）
const D_2 = '2026-05-27'; // 停牌股只到前天

/** 產 n 根日K，帶趨勢+震盪（讓條件分支真的被觸發，非全平），日期以 endDate 結尾。 */
function genCandles(endDate: string, n: number): Candle[] {
  const dates: string[] = [];
  const d = new Date(endDate + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.map((date, i) => {
    const base = 50 + i * 0.1 + 5 * Math.sin(i / 7);
    return { date, open: base, high: base * 1.03, low: base * 0.97, close: base * (1 + 0.005 * Math.cos(i / 5)), volume: 100_000 + (i % 13) * 5_000 };
  });
}

// ───────────── Part 1 + 3：純函式不變量（不需 mock）─────────────
describe('tw-sanse 純不變量', () => {
  test('掃描↔走圖一致：evalConditions 傳 series 與自行重算 series 結果完全相同', () => {
    const candles = genCandles(D_1, 300);
    const index = genCandles(D_1, 300).map((c) => c.close);
    const series = computeSanSe(candles, index);
    const withSeries = evalConditions(candles, index, series);   // 掃描路徑（scanTwSanSe 傳 series）
    const recomputed = evalConditions(candles, index);           // 走圖路徑（chart route 不傳 series）
    expect(recomputed).toEqual(withSeries);
  });

  test('使用順序評級 combo 衍生欄位自洽（紅當前提/觸發/中線/rank↔grade；掃描走圖同步由上面 toEqual 保證）', () => {
    const candles = genCandles(D_1, 300);
    const index = genCandles(D_1, 300).map((c) => c.close);
    const r = evalConditions(candles, index);
    const combo = r.combo!;
    expect(combo).toBeDefined();
    expect(combo.redGate).toBe(r.scores.midStrength > 0);          // 前提＝紅(中線機構)在場
    expect(combo.trigger).toBe(r.doubleB.buyHit || r.catch.buyHit); // 觸發＝雙B或捕撈買進命中
    expect(combo.midline).toBe(r.scores.midStrength > 0 && r.scores.midControl > 0); // 中線骨架＝紅＋黃
    expect(combo.rank).toBe(COMBO_RANK[combo.grade]);              // rank 必對應 grade
    expect(combo.grade === 'top').toBe(r.groupBuyCount === 3);     // 最強 ⟺ 三組齊發(雙B+主力+捕撈=共振3/3)
    expect(combo.grade === 'weak').toBe(r.groupBuyCount !== 3 && !combo.redGate); // 弱 ⟺ 非3/3 且無紅
    if (combo.grade === 'prime') expect(combo.redGate && combo.trigger).toBe(true); // 主進場 ⟹ 紅在場＋觸發
  });

  test('台股捕撈季節 4 級門檻全部低於陸股（台股周轉率結構性偏低）', () => {
    expect(TW_TIER_THRESHOLDS).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(TW_TIER_THRESHOLDS[i]).toBeLessThan(CN_TIER_THRESHOLDS[i]);
      expect(TW_TIER_THRESHOLDS[i]).toBeGreaterThan(0);
    }
  });
});

// ───────────── Part 2：scanTwSanSe 股票池過濾 + 新鮮度（mock fs）─────────────
const CANDLE_MAP: Record<string, Candle[]> = {
  '^TWII': genCandles(D_1, 260),       // 指數，封存到昨日（行情日曆 + RS 基準）
  '2330.TW': genCandles(D_1, 260),     // 普通股，封存到昨日 → evaluated
  '6654.TWO': genCandles(D_1, 260),    // 上櫃普通股，封存到昨日 → evaluated
  '0050.TW': genCandles(D_1, 260),     // ETF（00 開頭）→ 池外
  '9103.TW': genCandles(D_1, 260),     // 存託憑證 DR（master 名稱含 DR）→ 池外
  '1234.TW': genCandles(D_2, 259),     // 停牌股：封存只到前天 → staleSkipped
};

const MASTER = {
  entries: [
    { code: '2330', name: '台積電', market: 'TWSE', aliases: [] },
    { code: '6654', name: '天正國際', market: 'TPEx', aliases: [] },
    { code: '9103', name: '美德醫療-DR', market: 'TWSE', aliases: [] }, // 名稱含 DR → 須排除
    { code: '1234', name: '測試停牌', market: 'TWSE', aliases: [] },
    { code: '0050', name: '元大台灣50', market: 'TWSE', aliases: [] },
  ],
};

jest.mock('@/lib/datasource/LocalCandleStore', () => ({
  getLocalCandleDir: () => '/fake/candles/TW',
}));

// 不打網路：stub TWSE/TPEx 產業 fetch（保留真實 getTWConcept 題材對照），合約測試維持 hermetic。
jest.mock('@/lib/scanner/conceptMap', () => ({
  ...jest.requireActual('@/lib/scanner/conceptMap'),
  fetchTWIndustryMap: jest.fn().mockResolvedValue(new Map([['2330', '半導體'], ['6654', '其他電子']])),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(async (p: string) => {
    const s = String(p);
    if (s.includes('stock-master')) return JSON.stringify(MASTER);
    const base = s.split('/').pop()!.replace('.json', '');
    if (CANDLE_MAP[base]) return JSON.stringify({ candles: CANDLE_MAP[base] });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  readdir: jest.fn(async () => Object.keys(CANDLE_MAP).map((s) => `${s}.json`)),
}));

// scanTwSanSe 必須在 mock 宣告之後 import
import { scanTwSanSe } from '@/lib/tw-sanse/scan';

describe('tw-sanse 股票池過濾 + 新鮮度合約', () => {
  test('ETF/DR/指數排除；停牌股 staleSkipped；只評估普通股', async () => {
    const r = await scanTwSanSe();
    expect(r.lastDate).toBe(D_1);
    // 池 = 2330 + 6654 + 1234（0050 ETF / 9103 DR / ^TWII 指數 不進池）
    // 1234 封存到前天 → staleSkipped；2330 + 6654 → evaluated
    expect(r.evaluated).toBe(2);
    expect(r.staleSkipped).toBe(1);
  });

  test('掃描結果不含 ETF / DR / 指數代號', async () => {
    const r = await scanTwSanSe();
    const allSymbols = [
      ...r.results.strict, ...r.results.medium, ...r.results.loose,
    ].map((h) => h.symbol).concat(r.records.map((x) => x.symbol));
    for (const sym of allSymbols) {
      expect(sym).not.toBe('0050.TW');   // ETF
      expect(sym).not.toBe('9103.TW');   // DR
      expect(sym).not.toBe('^TWII');     // 指數
      expect(sym).not.toBe('1234.TW');   // 停牌
    }
  });
});
