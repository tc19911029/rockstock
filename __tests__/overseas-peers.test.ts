/**
 * 海外同業對照（純顯示層）單元測試
 *
 * 覆蓋：
 *   1. symbols.ts 海外 ticker 偵測 — .T / .KS 新後綴不可誤吃台股/陸股/基金
 *   2. peerMap 完整性 — 台股後綴格式、海外 ticker 格式、無重複
 *   3. computeHorizonReturns — d1/d5/d20/d60 計算與邊界
 *   4. dropUnsettledTodayBar — 未收盤今日半根不落地
 */

import {
  isUSTicker, isTokyoTicker, isSeoulTicker, isOverseasTicker, isIndexSymbol,
} from '../lib/utils/symbols';
import {
  PEER_THEMES, PEER_REFERENCE_TICKERS, getAllOverseasTickers,
} from '../lib/scanner/peerMap';
import { computeHorizonReturns, dropUnsettledTodayBar } from '../lib/overseas/peerReturns';
import type { Candle } from '../types';

// ── 1. symbols 偵測 ───────────────────────────────────────────────────────────

describe('overseas ticker detection (lib/utils/symbols)', () => {
  it.each(['MU', 'NVDA', 'AVGO', 'TSM', 'BRK-B', 'smci'])('isUSTicker(%s) = true', (s) => {
    expect(isUSTicker(s)).toBe(true);
  });

  it.each(['285A.T', '6981.T', '8035.T', '6146.t'])('isTokyoTicker(%s) = true', (s) => {
    expect(isTokyoTicker(s)).toBe(true);
  });

  it.each(['005930.KS', '000660.KS'])('isSeoulTicker(%s) = true', (s) => {
    expect(isSeoulTicker(s)).toBe(true);
  });

  // ⚠ 不可誤吃台股 / 陸股 / 場外基金 / 指數
  const domestic = ['2330.TW', '8299.TWO', '600519.SS', '000001.SZ', '000217.OF', '^TWII', '^SOX'];
  it.each(domestic)('isOverseasTicker(%s) = false（台/陸/基金/指數不受影響）', (s) => {
    expect(isOverseasTicker(s)).toBe(false);
  });

  it('US ticker 不吃帶後綴與數字開頭', () => {
    expect(isUSTicker('2330.TW')).toBe(false);
    expect(isUSTicker('005930.KS')).toBe(false);
    expect(isUSTicker('285A.T')).toBe(false);
    expect(isUSTicker('^IXIC')).toBe(false);
  });

  it('.T 不可誤吃 .TW / .TWO；.KS 不可誤吃 .SS/.SZ', () => {
    expect(isTokyoTicker('2330.TW')).toBe(false);
    expect(isTokyoTicker('8299.TWO')).toBe(false);
    expect(isSeoulTicker('000001.SS')).toBe(false);
    expect(isSeoulTicker('000001.SZ')).toBe(false);
  });

  it('isIndexSymbol 行為不變（^前綴 + 陸股指數白名單）', () => {
    expect(isIndexSymbol('^TWII')).toBe(true);
    expect(isIndexSymbol('000001.SS')).toBe(true);
    expect(isIndexSymbol('000001.SZ')).toBe(false);
    expect(isIndexSymbol('285A.T')).toBe(false);
    expect(isIndexSymbol('005930.KS')).toBe(false);
  });
});

// ── 2. peerMap 完整性 ────────────────────────────────────────────────────────

describe('peerMap integrity', () => {
  it('台股 symbol 格式：4 碼數字 + .TW/.TWO，且 code 與 symbol 一致', () => {
    for (const t of PEER_THEMES) {
      for (const s of t.twStocks) {
        expect(s.symbol).toMatch(/^\d{4}\.(TW|TWO)$/);
        expect(s.symbol.startsWith(`${s.code}.`)).toBe(true);
      }
    }
  });

  it('海外 ticker 全部是合法海外格式（美/日/韓或 ^指數）', () => {
    for (const ticker of getAllOverseasTickers()) {
      const ok = isOverseasTicker(ticker) || ticker.startsWith('^');
      expect({ ticker, ok }).toEqual({ ticker, ok: true });
    }
  });

  it('題材內台股代號無重複、海外 ticker 無重複', () => {
    const codes = PEER_THEMES.flatMap((t) => t.twStocks.map((s) => s.code));
    expect(new Set(codes).size).toBe(codes.length);
    const tickers = PEER_THEMES.flatMap((t) => t.overseas.map((o) => o.ticker));
    expect(new Set(tickers).size).toBe(tickers.length);
  });

  it('指數參考清單含 ^SOX / ^IXIC / TSM', () => {
    const tickers = PEER_REFERENCE_TICKERS.map((r) => r.ticker);
    expect(tickers).toEqual(expect.arrayContaining(['^SOX', '^IXIC', 'TSM']));
  });
});

// ── 3. computeHorizonReturns ─────────────────────────────────────────────────

function mkCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: c, high: c, low: c, close: c, volume: 1000,
  }));
}

describe('computeHorizonReturns', () => {
  it('d1/d5 基本計算（%、1 位小數）', () => {
    // 7 根：100,100,100,100,100,100,110 → d1 = +10.0%、d5 = 110/100-1 = +10.0%
    const r = computeHorizonReturns(mkCandles([100, 100, 100, 100, 100, 100, 110]));
    expect(r.last).toBe(110);
    expect(r.lastDate).toBe('2026-01-07');
    expect(r.d1).toBe(10.0);
    expect(r.d5).toBe(10.0);
    expect(r.d20).toBeNull(); // 不足 21 根
    expect(r.d60).toBeNull();
  });

  it('下跌方向與四捨五入到 1 位', () => {
    const r = computeHorizonReturns(mkCandles([100, 98.77]));
    expect(r.d1).toBe(-1.2); // -1.23% → -1.2
  });

  it('空陣列 / null → 全 null', () => {
    expect(computeHorizonReturns([])).toMatchObject({ last: null, d1: null, d60: null });
    expect(computeHorizonReturns(null)).toMatchObject({ last: null, d1: null });
  });

  it('d60：61 根剛好夠', () => {
    const closes = Array(60).fill(50).concat([60]); // 61 根
    const r = computeHorizonReturns(mkCandles(closes));
    expect(r.d60).toBe(20.0);
  });

  it('基期 ≤ 0 → null（防除以 0 / 髒資料）', () => {
    const r = computeHorizonReturns(mkCandles([0, 100]));
    expect(r.d1).toBeNull();
  });
});

// ── 4. dropUnsettledTodayBar ─────────────────────────────────────────────────

describe('dropUnsettledTodayBar', () => {
  const bar = (date: string): Candle => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 });

  it('美股盤中（ET 14:00）→ 丟掉今日 bar', () => {
    // 2026-06-11 14:00 ET = 2026-06-11T18:00:00Z（6 月 EDT = UTC-4）
    const now = new Date('2026-06-11T18:00:00Z');
    const out = dropUnsettledTodayBar('MU', [bar('2026-06-10'), bar('2026-06-11')], now);
    expect(out.map((c) => c.date)).toEqual(['2026-06-10']);
  });

  it('美股收盤後 +1h（ET 17:30）→ 保留今日 bar', () => {
    // 2026-06-11 17:30 ET = 2026-06-11T21:30:00Z
    const now = new Date('2026-06-11T21:30:00Z');
    const out = dropUnsettledTodayBar('MU', [bar('2026-06-10'), bar('2026-06-11')], now);
    expect(out.map((c) => c.date)).toEqual(['2026-06-10', '2026-06-11']);
  });

  it('東京盤中（JST 10:00）→ 丟今日；JST 17:00 → 保留', () => {
    // 2026-06-12 10:00 JST = 2026-06-12T01:00:00Z
    const intraday = new Date('2026-06-12T01:00:00Z');
    expect(
      dropUnsettledTodayBar('285A.T', [bar('2026-06-11'), bar('2026-06-12')], intraday)
        .map((c) => c.date),
    ).toEqual(['2026-06-11']);
    // 2026-06-12 17:00 JST = 2026-06-12T08:00:00Z（15:30 收盤 + 60min 緩衝後）
    const after = new Date('2026-06-12T08:00:00Z');
    expect(
      dropUnsettledTodayBar('285A.T', [bar('2026-06-11'), bar('2026-06-12')], after)
        .map((c) => c.date),
    ).toEqual(['2026-06-11', '2026-06-12']);
  });

  it('首爾收盤後（KST 17:00）→ 保留今日', () => {
    // 2026-06-12 17:00 KST = 2026-06-12T08:00:00Z
    const now = new Date('2026-06-12T08:00:00Z');
    const out = dropUnsettledTodayBar('005930.KS', [bar('2026-06-12')], now);
    expect(out.map((c) => c.date)).toEqual(['2026-06-12']);
  });

  it('未來日期的髒 bar 一律丟', () => {
    const now = new Date('2026-06-11T21:30:00Z'); // ET 17:30
    const out = dropUnsettledTodayBar('MU', [bar('2026-06-11'), bar('2026-06-15')], now);
    expect(out.map((c) => c.date)).toEqual(['2026-06-11']);
  });

  it('歷史 bar 不受影響', () => {
    const now = new Date('2026-06-11T18:00:00Z');
    const candles = [bar('2026-06-08'), bar('2026-06-09'), bar('2026-06-10')];
    expect(dropUnsettledTodayBar('MU', candles, now)).toHaveLength(3);
  });
});
