// degenerateSnapshotReason — 盤中三色防呆：偵測「扁平根」退化快照（盤前競價 / 刷新凍結）。
// 背景：2026-06-09 早盤 DNS 斷線 → L2 快照凍在 09:17 盤前、3064 檔全扁平（O=H=L=C、量=0），
// 盤中三色用扁平根算捕撈動能憑空生假金叉 → 誤標 37 檔底反（走圖用即時報價卻無金叉）。
import { degenerateSnapshotReason, type IntradaySnapshot, type IntradayQuote } from '@/lib/datasource/IntradayCache';

const q = (over: Partial<IntradayQuote>): IntradayQuote => ({
  symbol: '000001', name: 't', open: 10, high: 11, low: 9, close: 10.5, volume: 1000, prevClose: 10, changePercent: 5, ...over,
});
const flat = (close: number): Partial<IntradayQuote> => ({ open: close, high: close, low: close, close, volume: 0 });
const snap = (quotes: IntradayQuote[]): IntradaySnapshot => ({ market: 'CN', date: '2026-06-09', updatedAt: '2026-06-09T01:17:00Z', count: quotes.length, quotes });

describe('degenerateSnapshotReason', () => {
  it('null / 空快照 → 退化', () => {
    expect(degenerateSnapshotReason(null)).toMatch(/不存在/);
    expect(degenerateSnapshotReason(snap([]))).toMatch(/無有效報價/);
    expect(degenerateSnapshotReason(snap([q({ close: 0 }), q({ close: -1 })]))).toMatch(/無有效報價/);
  });

  it('整片扁平根（盤前/凍結快照）→ 退化', () => {
    const quotes = Array.from({ length: 100 }, (_, i) => q({ symbol: String(i), ...flat(10 + i) }));
    expect(degenerateSnapshotReason(snap(quotes))).toMatch(/flat-dominated/);
  });

  it('正常盤中真實 OHLC（少數停牌扁平）→ 不退化', () => {
    const quotes = Array.from({ length: 100 }, (_, i) =>
      i < 3 ? q({ symbol: String(i), ...flat(10) })            // 3 檔停牌扁平（< 90%）
            : q({ symbol: String(i), open: 10, high: 11.2, low: 9.8, close: 10.6, volume: 5000 }));
    expect(degenerateSnapshotReason(snap(quotes))).toBeNull();
  });

  it('鎖漲停整日 O=H=L=C 但量>0 → 不算扁平、不退化', () => {
    const quotes = Array.from({ length: 100 }, (_, i) =>
      q({ symbol: String(i), open: 10, high: 10, low: 10, close: 10, volume: 8000 })); // 扁平價但有量（漲停鎖死）
    expect(degenerateSnapshotReason(snap(quotes))).toBeNull();
  });

  it('close<=0 的停牌檔不計入母數', () => {
    // 2 檔有效真實 + 50 檔停牌(close=0)：母數只算 2 檔有效、皆真實 → 不退化
    const quotes = [
      q({ symbol: 'a', open: 10, high: 11, low: 9, close: 10.5, volume: 100 }),
      q({ symbol: 'b', open: 20, high: 21, low: 19, close: 20.5, volume: 100 }),
      ...Array.from({ length: 50 }, (_, i) => q({ symbol: 'z' + i, close: 0 })),
    ];
    expect(degenerateSnapshotReason(snap(quotes))).toBeNull();
  });
});
