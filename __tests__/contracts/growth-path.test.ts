/**
 * Contract test：資金成長路徑反推 + 進度判定
 *
 * 守的規則：
 *   - solveMonthlyRate：(1+r)^N = target/start 數學一致
 *   - generateMilestones：每月一筆、targetEnd 嚴格遞增、最後一筆 ≥ targetCapital
 *   - computeProgress：green/yellow/red 三帶判定正確
 *   - warningBands 預設 -5% 黃 / -10% 紅
 *   - 紀律：red 燈訊息含「降槓桿」字樣（避免被改成放寬選股）
 *   - schemaVersion = 1（不變式）
 */

import {
  GROWTH_PATH_SCHEMA_VERSION,
  solveMonthlyRate,
  monthsBetween,
  generateMilestones,
  buildGrowthPath,
  computeProgress,
} from '@/lib/portfolio/growthPath';

describe('monthsBetween', () => {
  test('同月 = 0', () => {
    expect(monthsBetween('2026-05-01', '2026-05-31')).toBe(0);
  });
  test('5/23 → 12/31 = 7 月', () => {
    expect(monthsBetween('2026-05-23', '2026-12-31')).toBe(7);
  });
  test('跨年', () => {
    expect(monthsBetween('2026-11-01', '2027-02-01')).toBe(3);
  });
});

describe('solveMonthlyRate', () => {
  test('60.45M → 300M / 7 月 ≈ 25.7% 月化', () => {
    const r = solveMonthlyRate(60_452_420, 300_000_000, 7);
    expect(r).toBeCloseTo(0.2574, 3);
  });

  test('70M → 300M / 7 月 ≈ 23.1% 月化', () => {
    const r = solveMonthlyRate(70_000_000, 300_000_000, 7);
    expect(r).toBeCloseTo(0.2311, 3);
  });

  test('已達目標：start = target → r = 0', () => {
    const r = solveMonthlyRate(100, 100, 12);
    expect(r).toBeCloseTo(0, 5);
  });

  test('months = 0 → r = 0', () => {
    expect(solveMonthlyRate(100, 200, 0)).toBe(0);
  });

  test('startCapital 0 → throw', () => {
    expect(() => solveMonthlyRate(0, 100, 12)).toThrow();
  });
});

describe('generateMilestones', () => {
  test('5/23 → 12/31 產 8 個 milestone（含 5 月）', () => {
    const ms = generateMilestones({
      startDate: '2026-05-23',
      startCapital: 60_000_000,
      targetDate: '2026-12-31',
      monthlyRate: 0.23,
    });
    expect(ms.length).toBeGreaterThanOrEqual(7);
    expect(ms[0].yearMonth).toBe('2026-05');
    expect(ms[ms.length - 1].yearMonth).toBe('2026-12');
  });

  test('targetEnd 嚴格遞增', () => {
    const ms = generateMilestones({
      startDate: '2026-05-23',
      startCapital: 60_000_000,
      targetDate: '2026-12-31',
      monthlyRate: 0.20,
    });
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i].targetEnd).toBeGreaterThan(ms[i - 1].targetEnd);
    }
  });

  test('每月一筆，無跳月', () => {
    const ms = generateMilestones({
      startDate: '2026-05-23',
      startCapital: 60_000_000,
      targetDate: '2026-12-31',
      monthlyRate: 0.20,
    });
    const monthIndices = ms.map(m => Number(m.yearMonth.split('-')[1]));
    for (let i = 1; i < monthIndices.length; i++) {
      expect(monthIndices[i] - monthIndices[i - 1]).toBe(1);
    }
  });
});

describe('buildGrowthPath', () => {
  test('60M → 300M / 7 月 — 完整 path', () => {
    const p = buildGrowthPath({
      startDate: '2026-05-23',
      startCapital: 60_000_000,
      targetDate: '2026-12-31',
      targetCapital: 300_000_000,
    });
    expect(p.schemaVersion).toBe(1);
    expect(p.monthlyRate).toBeCloseTo(0.2589, 3);
    expect(p.warningBands).toEqual({ yellowPct: -0.05, redPct: -0.10 });
    expect(p.milestones.length).toBeGreaterThan(0);
    const last = p.milestones[p.milestones.length - 1];
    // 最後一筆應接近 targetCapital（複利精確度允許 ±1%）
    expect(last.targetEnd).toBeGreaterThan(295_000_000);
    expect(last.targetEnd).toBeLessThan(305_000_000);
  });

  test('warningBands override', () => {
    const p = buildGrowthPath({
      startDate: '2026-05-23',
      startCapital: 60_000_000,
      targetDate: '2026-12-31',
      targetCapital: 300_000_000,
      warningBands: { yellowPct: -0.03, redPct: -0.07 },
    });
    expect(p.warningBands).toEqual({ yellowPct: -0.03, redPct: -0.07 });
  });
});

describe('computeProgress — 三帶判定', () => {
  function makePath() {
    return buildGrowthPath({
      startDate: '2026-05-23',
      startCapital: 60_000_000,
      targetDate: '2026-12-31',
      targetCapital: 300_000_000,
    });
  }

  test('5 月當月達標 → green', () => {
    const p = makePath();
    const targetMay = p.milestones.find(m => m.yearMonth === '2026-05')!.targetEnd;
    const prog = computeProgress(p, '2026-05-23', targetMay * 1.05);
    expect(prog.status).toBe('green');
    expect(prog.gapPct).toBeGreaterThan(0);
    expect(prog.message).toContain('綠燈');
  });

  test('落後 5% 黃燈', () => {
    const p = makePath();
    const targetMay = p.milestones.find(m => m.yearMonth === '2026-05')!.targetEnd;
    const prog = computeProgress(p, '2026-05-23', targetMay * 0.93);  // -7%
    expect(prog.status).toBe('yellow');
    expect(prog.gapPct).toBeLessThan(-0.05);
    expect(prog.gapPct).toBeGreaterThan(-0.10);
    expect(prog.message).toContain('黃燈');
  });

  test('落後 15% 紅燈 + message 含「降槓桿」', () => {
    const p = makePath();
    const targetMay = p.milestones.find(m => m.yearMonth === '2026-05')!.targetEnd;
    const prog = computeProgress(p, '2026-05-23', targetMay * 0.85);  // -15%
    expect(prog.status).toBe('red');
    expect(prog.gapPct).toBeLessThan(-0.10);
    expect(prog.message).toContain('紅燈');
    expect(prog.message).toContain('降槓桿');
  });

  test('紅燈訊息不含「放寬」(規則 #5 鐵則 — 落後不可放寬選股)', () => {
    const p = makePath();
    const targetMay = p.milestones.find(m => m.yearMonth === '2026-05')!.targetEnd;
    const prog = computeProgress(p, '2026-05-23', targetMay * 0.5);
    expect(prog.message).not.toContain('放寬');
    expect(prog.message).not.toContain('降低條件');
  });

  test('asOfDate 超出路徑 → status=unknown', () => {
    const p = makePath();
    const prog = computeProgress(p, '2028-01-15', 100_000_000);
    expect(prog.status).toBe('unknown');
    expect(prog.gapPct).toBeNull();
  });

  test('剩餘月化需求計算（76M now, target 300M, 7 月剩 → ~22%）', () => {
    const p = makePath();
    const prog = computeProgress(p, '2026-05-23', 76_000_000);
    expect(prog.requiredMonthlyRate).toBeGreaterThan(0);
    expect(prog.requiredMonthlyRate).toBeLessThan(0.25);
  });
});

describe('schema invariants', () => {
  test('GROWTH_PATH_SCHEMA_VERSION = 1（防悄悄升級）', () => {
    expect(GROWTH_PATH_SCHEMA_VERSION).toBe(1);
  });
});
