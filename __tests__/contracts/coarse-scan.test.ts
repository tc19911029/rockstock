/**
 * Contract test: 粗掃效能與格式
 *
 * 驗證 Fundamental Rule R7: 全市場掃描用快照粗掃，不逐檔拉分時K
 */

import { coarseScan, CoarseScanResult } from '@/lib/scanner/CoarseScanner';
import { IntradaySnapshot, MABaseSnapshot } from '@/lib/datasource/IntradayCache';
import { CoarseCandidateSchema } from '@/lib/contracts/pipeline';
import { SCAN_PERFORMANCE } from '@/lib/contracts/fundamentals';

// ── Mock Data ───────────────────────────────────────────────────────────────

function makeMockSnapshot(count: number): IntradaySnapshot {
  const quotes = Array.from({ length: count }, (_, i) => ({
    symbol: `${(2330 + i).toString().padStart(4, '0')}`,
    name: `股票${i}`,
    open: 100 + Math.random() * 50,
    high: 110 + Math.random() * 50,
    low: 90 + Math.random() * 50,
    close: 105 + Math.random() * 50,
    volume: Math.floor(Math.random() * 10000000),
    prevClose: 100 + Math.random() * 50,
    changePercent: (Math.random() - 0.3) * 10,
  }));
  return {
    market: 'TW',
    date: '2026-04-09',
    updatedAt: new Date().toISOString(),
    count,
    quotes,
  };
}

function makeMockMABase(count: number): MABaseSnapshot {
  const data: Record<string, { closes: number[]; volumes: number[] }> = {};
  for (let i = 0; i < count; i++) {
    const symbol = `${(2330 + i).toString().padStart(4, '0')}`;
    data[symbol] = {
      closes: Array.from({ length: 20 }, () => 100 + Math.random() * 50),
      volumes: Array.from({ length: 20 }, () => Math.floor(Math.random() * 10000000)),
    };
  }
  return {
    market: 'TW',
    date: '2026-04-08',
    updatedAt: new Date().toISOString(),
    data,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CoarseScanner contracts', () => {
  test('R7: 粗掃 1900 檔 < 3 秒', () => {
    const snapshot = makeMockSnapshot(1900);
    const maBase = makeMockMABase(1900);

    const start = Date.now();
    const result: CoarseScanResult = coarseScan(snapshot, maBase);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(SCAN_PERFORMANCE.COARSE_MAX_MS);
    expect(result.total).toBe(1900);
    expect(result.candidateCount).toBeGreaterThanOrEqual(0);
    expect(result.scanTimeMs).toBeLessThan(SCAN_PERFORMANCE.COARSE_MAX_MS);
  });

  test('R7: 粗掃 5000 檔 (陸股) < 3 秒', () => {
    const snapshot = makeMockSnapshot(5000);
    snapshot.market = 'CN';
    const maBase = makeMockMABase(5000);
    maBase.market = 'CN';

    const start = Date.now();
    const result = coarseScan(snapshot, maBase);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(SCAN_PERFORMANCE.COARSE_MAX_MS);
    expect(result.total).toBe(5000);
  });

  test('粗掃候選符合 CoarseCandidateSchema', () => {
    const snapshot = makeMockSnapshot(100);
    const maBase = makeMockMABase(100);

    const result = coarseScan(snapshot, maBase);

    for (const candidate of result.candidates.slice(0, 10)) {
      const parsed = CoarseCandidateSchema.safeParse(candidate);
      expect(parsed.success).toBe(true);
    }
  });

  test('無 MA Base 時仍可執行粗掃', () => {
    const snapshot = makeMockSnapshot(100);

    const result = coarseScan(snapshot, null);

    expect(result.total).toBe(100);
    // 沒有 MA 過濾，候選數會更多
    expect(result.candidateCount).toBeGreaterThanOrEqual(0);
  });

  test('做空粗掃', () => {
    const snapshot = makeMockSnapshot(100);
    const maBase = makeMockMABase(100);

    const result = coarseScan(snapshot, maBase, { direction: 'short' });

    expect(result.total).toBe(100);
    expect(result.candidateCount).toBeGreaterThanOrEqual(0);
  });

  test('空快照回傳 0 候選', () => {
    const snapshot: IntradaySnapshot = {
      market: 'TW',
      date: '2026-04-09',
      updatedAt: new Date().toISOString(),
      count: 0,
      quotes: [],
    };

    const result = coarseScan(snapshot, null);
    expect(result.candidateCount).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });
});
