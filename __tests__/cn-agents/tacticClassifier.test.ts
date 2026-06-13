import { classifyTactic, computeTechFeatures, type TechFeatures } from '@/lib/cn-agents/tacticClassifier';
import type { BaselineCandle } from '@/lib/backtest/eventBaseline';

const base: TechFeatures = { boards: 0, isLimitUpToday: false, cycleStage: 'main_rise' };

describe('classifyTactic', () => {
  it('換手漲停 1-3 板 → 打板', () => {
    const r = classifyTactic({ ...base, boards: 2, isLimitUpToday: true, isOneWord: false, themePosition: 'leader' });
    expect(r.primary).toBe('daban');
  });

  it('一字板 → 觀望（買不到）', () => {
    const r = classifyTactic({ ...base, boards: 3, isLimitUpToday: true, isOneWord: true });
    expect(r.eligible).toContain('observe');
    expect(r.primary).not.toBe('daban');
  });

  it('殺跌期逆風 → primary 一律觀望', () => {
    const r = classifyTactic({ ...base, boards: 2, isLimitUpToday: true, isOneWord: false, cycleStage: 'crash' });
    expect(r.primary).toBe('observe');
    expect(r.eligible).toContain('daban'); // 仍記錄資格
  });

  it('高位情緒股 → riskTag（高潮期 5 板）', () => {
    const r = classifyTactic({ ...base, boards: 5, isLimitUpToday: true, isOneWord: false, cycleStage: 'climax' });
    expect(r.riskTag).toBeTruthy();
  });

  it('昨炸板今穩 → 弱轉強 conditional', () => {
    const r = classifyTactic({ ...base, yesterdayBroken: true, todayPct: 1 });
    expect(r.conditional?.tactic).toBe('weakToStrong');
    expect(r.conditional?.trigger).toMatch(/競價/);
  });

  it('漲5-8%未封放量 → 半路', () => {
    const r = classifyTactic({ ...base, isLimitUpToday: false, todayPct: 6, volRatio5d: 2.5 });
    expect(r.eligible).toContain('banlu');
  });

  it('回踩MA5縮量 → 低吸', () => {
    const r = classifyTactic({ ...base, boards: 0, pctAboveMa5: 1.2, volRatio5d: 0.6 });
    expect(r.eligible).toContain('dixi');
  });

  it('補漲：題材龍頭3板、本股低位', () => {
    const r = classifyTactic({ ...base, boards: 1, themeLeaderBoards: 4, gain20d: 8 });
    expect(r.eligible).toContain('buchang');
  });
});

describe('computeTechFeatures', () => {
  const mk = (closes: number[]): BaselineCandle[] =>
    closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }));

  it('gain20d / MA 乖離 / 20日新高', () => {
    const closes = Array.from({ length: 21 }, (_, i) => 100 + i); // 穩定上升
    const f = computeTechFeatures(mk(closes));
    expect(f.gain20d).toBeGreaterThan(0);
    expect(f.pctAboveMa5).not.toBeNull();
    expect(f.isNew20dHigh).toBe(true);
  });

  it('資料不足 → 對應欄 null/空', () => {
    expect(computeTechFeatures(mk([100]))).toEqual({});
    expect(computeTechFeatures(null)).toEqual({});
  });

  it('量比放大偵測', () => {
    const candles = mk(Array.from({ length: 10 }, () => 100));
    candles[candles.length - 1].volume = 5000; // 今日爆量
    const f = computeTechFeatures(candles);
    expect(f.volRatio5d).toBeGreaterThan(1);
  });
});
