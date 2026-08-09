import {
  PAPER_OBSERVATIONS,
  PRODUCTION_STRATEGY_IDS,
  R_SHORT_TOP1_PAPER_CANDIDATE,
  SANSE_NARROW_PAPER_CANDIDATE,
  getBuyMethodEvidence,
  getSanSeEvidence,
  getStrategyEvidence,
} from '@/lib/strategy/strategyEvidence';

describe('strategy evidence contract', () => {
  test('catalog covers the 30 production strategy units exactly once', () => {
    expect(PRODUCTION_STRATEGY_IDS).toHaveLength(30);
    expect(new Set(PRODUCTION_STRATEGY_IDS).size).toBe(30);
  });

  test('no production strategy is currently promoted as tradeable', () => {
    for (const id of PRODUCTION_STRATEGY_IDS) {
      for (const market of ['TW', 'CN'] as const) {
        expect(getStrategyEvidence(id, market).status).not.toBe('trade');
      }
    }
  });

  test('paper observations are limited to the audited market-specific slices', () => {
    expect(PAPER_OBSERVATIONS.map(item => `${item.id}:${item.market}`)).toEqual([
      'buy:E:CN',
      'buy:F:CN',
      'buy:M:CN',
      'backend:X:TW',
    ]);
  });

  test('buy-method evidence does not leak a paper result across markets or directions', () => {
    expect(getBuyMethodEvidence('F', 'CN').status).toBe('paper');
    expect(getBuyMethodEvidence('F', 'TW').status).toBe('research');
    expect(getBuyMethodEvidence('R', 'CN', 'short').status).toBe('research');
    expect(getBuyMethodEvidence('R', 'CN', 'long').status).toBe('research');
    expect(R_SHORT_TOP1_PAPER_CANDIDATE.status).toBe('paper');
    expect(R_SHORT_TOP1_PAPER_CANDIDATE.constraint).toContain('現行做空按鈕是 Top10');
  });

  test('all selectable SanSe levels remain research-only', () => {
    const levels = PRODUCTION_STRATEGY_IDS
      .filter(id => id.startsWith('sanse:'))
      .map(id => id.slice('sanse:'.length));

    for (const level of levels) {
      expect(getSanSeEvidence(level, 'TW').status).toBe('research');
      expect(getSanSeEvidence(level, 'CN').status).toBe('research');
    }
  });

  test('narrow SanSe candidate cannot be confused with the selectable reversal level', () => {
    expect(SANSE_NARROW_PAPER_CANDIDATE.status).toBe('paper');
    expect(SANSE_NARROW_PAPER_CANDIDATE.constraint).toContain('尚未做成介面按鈕');
    expect(getSanSeEvidence('reversal', 'CN').status).toBe('research');
  });
});
