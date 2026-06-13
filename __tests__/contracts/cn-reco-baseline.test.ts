/**
 * 合約測試：事件基準價/報酬「單一事實」提升到 lib/backtest/ 後不可 fork drift。
 *
 * 背景（2026-06-13 陸股情緒系統 P2）：
 *   settleBaseline（一字板 no_fill 守衛）與 computeEventReturns 從 lib/youtube/
 *   原樣搬移到 lib/backtest/eventBaseline.ts / eventReturns.ts，youtube 端改 thin
 *   re-export。陸股回測迴圈直接 import lib/backtest 版本 — 兩邊必須是同一個函式
 *   reference，任何人把 youtube 端改回本地實作（fork）此測試就會抓到。
 *
 * golden cases 依 settleBaseline 實際邏輯造（lib/backtest/eventBaseline.ts）：
 *   - 一字鎖死判定：open === high 且 low > 0 且 (high − low)/low < 0.5% → no_fill
 *   - 停牌假根：volume === 0 且 O===C 且 H===L → 跳下一根
 *   - 污染守衛：|entry_open / mention_close − 1| > 25% → no_data
 *   - 提及日後 5 個交易日內無有效 bar → no_data
 */

import { settleBaseline as ytSettleBaseline } from '@/lib/youtube/recoBaseline';
import { computeEventReturns as ytComputeEventReturns } from '@/lib/youtube/recoPerformance';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const NOW = '2026-06-13T08:00:00.000Z';

function bar(
  date: string, open: number, high: number, low: number, close: number, volume = 1_000_000,
): BaselineCandle {
  return { date, open, high, low, close, volume };
}

describe('contract: lib/backtest 事件基準價單一事實（防 fork drift）', () => {
  it('lib/youtube/recoBaseline.settleBaseline 與 lib/backtest/eventBaseline 是同一個函式 reference', () => {
    expect(ytSettleBaseline).toBe(settleBaseline);
  });

  it('lib/youtube/recoPerformance.computeEventReturns 與 lib/backtest/eventReturns 是同一個函式 reference', () => {
    expect(ytComputeEventReturns).toBe(computeEventReturns);
  });
});

describe('contract: CN 一字板 no_fill golden', () => {
  it('主板 10% 一字板（O=H=L=C=昨收×1.1，有量）→ no_fill', () => {
    const candles = [
      bar('2026-06-10', 9.85, 10.05, 9.70, 10.00),         // 提及日 D，收 10.00
      bar('2026-06-11', 11.00, 11.00, 11.00, 11.00, 50_000), // 一字封死 +10%
    ];
    const b = settleBaseline('2026-06-10', candles, NOW);
    expect(b.status).toBe('no_fill');
    expect(b.base_date).toBe('2026-06-11');
    expect(b.entry_open).toBeNull();
    expect(b.mention_close).toBe(10.00);
    expect(b.settled_at).toBe(NOW);
  });

  it('創業板 20cm 一字板（O=H=L=C=昨收×1.2，有量）→ no_fill', () => {
    const candles = [
      bar('2026-06-10', 19.60, 20.20, 19.40, 20.00),        // 提及日 D，收 20.00
      bar('2026-06-11', 24.00, 24.00, 24.00, 24.00, 80_000), // 20cm 一字封死
    ];
    const b = settleBaseline('2026-06-10', candles, NOW);
    expect(b.status).toBe('no_fill');
    expect(b.base_date).toBe('2026-06-11');
    expect(b.entry_open).toBeNull();
  });

  it('開在漲停但盤中打開（open===high、振幅 ≥0.5%）→ filled，買得到', () => {
    const candles = [
      bar('2026-06-10', 9.85, 10.05, 9.70, 10.00),
      bar('2026-06-11', 11.00, 11.00, 10.60, 11.00), // 開漲停但殺到 10.60 又封回
    ];
    const b = settleBaseline('2026-06-10', candles, NOW);
    expect(b.status).toBe('filled');
    expect(b.base_date).toBe('2026-06-11');
    expect(b.entry_open).toBe(11.00);
  });

  it('非一字漲停（低開後拉漲停，盤中有振幅）→ filled，entry_open=次日開盤', () => {
    const candles = [
      bar('2026-06-10', 9.90, 10.10, 9.80, 10.00),
      bar('2026-06-11', 10.50, 11.00, 10.40, 11.00), // 開 10.50 拉到漲停
    ];
    const b = settleBaseline('2026-06-10', candles, NOW);
    expect(b.status).toBe('filled');
    expect(b.base_date).toBe('2026-06-11');
    expect(b.entry_open).toBe(10.50);
    expect(b.mention_close).toBe(10.00);
  });
});

describe('contract: no_data 與污染守衛 golden', () => {
  it('無 K 線（null / 空陣列）→ no_data', () => {
    expect(settleBaseline('2026-06-10', null, NOW).status).toBe('no_data');
    expect(settleBaseline('2026-06-10', [], NOW).status).toBe('no_data');
  });

  it('提及日後 5 個交易日全是停牌假根（量 0、O===C、H===L）→ no_data', () => {
    const candles = [
      bar('2026-06-10', 9.90, 10.10, 9.80, 10.00),
      // 連續 6 根停牌假根（> MAX_SKIP_DAYS=5，排除「還在等」的 pending 分支）
      ...['2026-06-11', '2026-06-12', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18']
        .map(d => bar(d, 10.00, 10.00, 10.00, 10.00, 0)),
    ];
    const b = settleBaseline('2026-06-10', candles, NOW);
    expect(b.status).toBe('no_data');
    expect(b.entry_open).toBeNull();
  });

  it('污染守衛：隔夜跳空 >25%（撞庫/壞 bar）→ no_data 不進場', () => {
    const candles = [
      bar('2026-06-10', 9.90, 10.10, 9.80, 10.00),       // 提及日收 10.00
      bar('2026-06-11', 13.00, 13.50, 12.80, 13.20),      // 開 13.00 = +30%，隔夜不可能
    ];
    const b = settleBaseline('2026-06-10', candles, NOW);
    expect(b.status).toBe('no_data');
    expect(b.base_date).toBe('2026-06-11');
    expect(b.entry_open).toBeNull();
    expect(b.mention_close).toBe(10.00);
  });
});
