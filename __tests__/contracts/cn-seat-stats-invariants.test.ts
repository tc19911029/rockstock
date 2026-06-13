/**
 * 合約：席位績效統計檔不變量（真實 data/cn-agents/seats/stats.json；無檔 skip）
 *
 *   - 率（winD1/winD5/nextDayDumpRate）∈ [0,1]、無 NaN
 *   - deptCode 唯一
 *   - nEvents = nBuy + nSell ≥ recent 長度下限合理性
 *   - lastSeen 在 [windowFrom, windowTo] 內
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { SeatStatsFile } from '@/lib/cn-agents/types';

const STATS_PATH = path.join(process.cwd(), 'data', 'cn-agents', 'seats', 'stats.json');

const inUnit = (v: number | null): boolean => v === null || (Number.isFinite(v) && v >= 0 && v <= 1);
const finiteOrNull = (v: number | null): boolean => v === null || Number.isFinite(v);

describe('cn-seat-stats 不變量', () => {
  it('真實 stats.json 過檢', async () => {
    let stats: SeatStatsFile;
    try {
      stats = JSON.parse(await fs.readFile(STATS_PATH, 'utf-8')) as SeatStatsFile;
    } catch {
      console.warn('cn-seat-stats-invariants：無 stats.json，skip（seats cron 跑過後生效）');
      return;
    }
    expect(stats.windowFrom <= stats.windowTo).toBe(true);
    const seen = new Set<string>();
    for (const s of stats.seats) {
      expect(seen.has(s.deptCode)).toBe(false);
      seen.add(s.deptCode);
      expect(s.nEvents).toBe(s.nBuy + s.nSell);
      expect(s.nEvents).toBeGreaterThanOrEqual(s.recent.length > 0 ? 1 : 0);
      expect(inUnit(s.buyFwd.winD1)).toBe(true);
      expect(inUnit(s.buyFwd.winD5)).toBe(true);
      expect(inUnit(s.nextDayDumpRate)).toBe(true);
      expect(finiteOrNull(s.buyFwd.avgD1)).toBe(true);
      expect(finiteOrNull(s.buyFwd.avgD5)).toBe(true);
      expect(finiteOrNull(s.buyFwd.avgD10)).toBe(true);
      expect(s.lastSeen >= stats.windowFrom && s.lastSeen <= stats.windowTo).toBe(true);
    }
  });
});
