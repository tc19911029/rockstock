import { computeIndicators } from '@/lib/indicators';
import { evaluateShortCourseSetup } from '@/lib/analysis/shortCandidate';

describe('正式做空 S1–S7 入口', () => {
  it('S7 最新講義量能選配：量未放大仍可成為候選，六條件量只記品質分', () => {
    const raw = Array.from({ length: 35 }, (_, i) => {
      const close = 150 - i * 1.5;
      return {
        date: `2026-02-${String(i + 1).padStart(2, '0')}`,
        open: close + 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
      };
    });
    raw[33] = { ...raw[33], open: 97, high: 101, low: 96, close: 100, volume: 1000 };
    raw[34] = { ...raw[34], open: 97, high: 98, low: 93, close: 94, volume: 1000 };

    const candles = computeIndicators(raw);
    const setup = evaluateShortCourseSetup(candles, candles.length - 1);
    const s7 = setup.entries.find(s => s.position === 7);

    expect(s7).toBeDefined();
    expect(s7?.sourceVariant).toBe('latest_handout_volume_optional');
    expect(s7?.hasVolume).toBe(false);
    expect(setup.quality.volume.pass).toBe(false);
    expect(setup.isEntryReady).toBe(true);
  });
});
