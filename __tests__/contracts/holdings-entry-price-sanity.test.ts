/**
 * Contract test：Holdings entryPrice 合理性驗證
 *
 * 守的規則（2026-05-22 加，因 3037 placeholder 215 vs 真實 970 事件）：
 *   - entryPrice 必須與 entryDate 那根 K 線 close 差距 ≤ ±20%
 *   - 假日 fallback：向前 5 自然日找最近 K 線
 *   - K 線檔不存在 / 沒有對應日期 → 視為「無法驗證」放行（不誤殺）
 *   - 偏離 ±20% → 拒絕，reason 必須清楚說明
 */

import {
  validateEntryPriceFromCandles,
  ENTRY_PRICE_TOLERANCE,
  ENTRY_PRICE_LOOKBACK_DAYS,
  type EntryPriceCandle,
} from '@/lib/agents/portfolio/validateEntryPrice';

const SAMPLE_CANDLES: EntryPriceCandle[] = [
  { date: '2026-05-18', close: 816 },
  { date: '2026-05-19', close: 818 },
  { date: '2026-05-20', close: 823 },
  { date: '2026-05-21', close: 905 },
  { date: '2026-05-22', close: 970 },
];

describe('validateEntryPriceFromCandles', () => {
  test('entryPrice 等於 K 線 close → ok', () => {
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-22', 970);
    expect(r.ok).toBe(true);
    expect(r.deviation).toBe(0);
    expect(r.actualClose).toBe(970);
    expect(r.actualDate).toBe('2026-05-22');
  });

  test('entryPrice 在 ±20% 內 → ok（接近上界 +19%）', () => {
    // 970 × 1.19 = 1154.3
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-22', 1154);
    expect(r.ok).toBe(true);
  });

  test('entryPrice 在 ±20% 內 → ok（接近下界 -19%）', () => {
    // 970 × 0.81 = 785.7
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-22', 786);
    expect(r.ok).toBe(true);
  });

  test('entryPrice 偏離 > +20% → reject（甚至 +30%）', () => {
    // 970 × 1.30 = 1261
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-22', 1261);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('970');
    expect(r.reason).toContain('30');
    expect(r.reason).toContain('forcePrice');
  });

  test('經典 3037 placeholder bug case：entryPrice 215 vs 970 close → reject', () => {
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-22', 215);
    expect(r.ok).toBe(false);
    expect(r.actualClose).toBe(970);
    expect(r.deviation).toBeLessThan(-0.7);
  });

  test('週末 entryDate 容錯：往前找 5 天內最近 K 線', () => {
    // 假設 2026-05-23 是週六；最近 K 線 2026-05-22
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-23', 970);
    expect(r.ok).toBe(true);
    expect(r.actualDate).toBe('2026-05-22');
  });

  test('entryDate 超過 5 天無 K 線 → 無法驗證放行', () => {
    // 最後 K 線 2026-05-22；entryDate 2026-05-30 差 8 天
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2026-05-30', 1500);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no_recent_kline');
  });

  test('entryDate 早於 K 線歷史 → 無法驗證放行', () => {
    const r = validateEntryPriceFromCandles(SAMPLE_CANDLES, '3037.TW', '2020-01-01', 999);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('entry_before_kline_history');
  });

  test('空 candles → 無法驗證放行（不誤殺）', () => {
    const r = validateEntryPriceFromCandles([], '9999.TW', '2026-05-22', 100);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no_kline_data');
  });

  test('TOLERANCE = 0.20、LOOKBACK = 5（防止常數被悄悄調寬）', () => {
    expect(ENTRY_PRICE_TOLERANCE).toBe(0.20);
    expect(ENTRY_PRICE_LOOKBACK_DAYS).toBe(5);
  });
});
