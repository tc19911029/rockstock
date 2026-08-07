import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

describe('2026-08-08 holdings valuation refresh', () => {
  const symbols = ['3006', '6770', '3081', '000988', '001309', '603986'];

  it.each(symbols)('%s has a current, peer-calibrated three-scenario valuation', symbol => {
    const file = path.join(root, 'data', 'valuation', '2026-08-08', `${symbol}.json`);
    const valuation = JSON.parse(readFileSync(file, 'utf-8')) as any;
    expect(valuation.date).toBe('2026-08-08');
    expect(valuation.peerComparison.peers.filter((p: any) => !p.excluded).length).toBeGreaterThanOrEqual(3);
    expect(valuation.scenarios.pessimistic.fullYearEps).toBeGreaterThan(0);
    expect(valuation.scenarios.base.fullYearEps).toBeGreaterThan(valuation.scenarios.pessimistic.fullYearEps);
    expect(valuation.scenarios.optimistic.fullYearEps).toBeGreaterThan(valuation.scenarios.base.fullYearEps);
    expect(valuation.dataAsOf.dilutionSignature).toEqual(expect.any(String));
  });

  it('records 3006 July self-reported EPS and 3081 post-dividend shares', () => {
    const esmt = JSON.parse(readFileSync(path.join(root, 'data/valuation/2026-08-08/3006.json'), 'utf-8'));
    const landmark = JSON.parse(readFileSync(path.join(root, 'data/valuation/2026-08-08/3081.json'), 'utf-8'));
    expect(esmt.actualEpsYtd).toBeCloseTo(39.19, 2);
    expect(esmt.monthlyEpsActuals[0]).toMatchObject({ period: '2026-07', eps: 11.61 });
    expect(landmark.dataAsOf.sharesOutstanding).toBe(101_769_004);
  });

  it('reviews every TW and CN holding with a non-null current price', () => {
    const review = JSON.parse(readFileSync(path.join(root, 'data/agents/portfolio/reviews/2026-08-08.json'), 'utf-8'));
    expect(review.reviews).toHaveLength(6);
    expect(review.reviews.every((r: any) => r.currentPrice > 0)).toBe(true);
    expect(review.reviews.filter((r: any) => r.action === 'stop_loss').map((r: any) => r.symbol).sort()).toEqual([
      '000988.SZ', '001309.SZ', '603986.SS', '6770.TW',
    ]);
  });

  it('keeps 3081 total cost constant after the 10% stock dividend adjustment', () => {
    const holdings = JSON.parse(readFileSync(path.join(root, 'data/agents/portfolio/holdings.json'), 'utf-8'));
    const landmark = holdings.holdings.find((h: any) => h.symbol === '3081.TWO');
    expect(landmark.shares).toBe(22_000);
    expect(landmark.entryPrice).toBeCloseTo(2_032.5, 4);
    expect(landmark.shares * landmark.entryPrice).toBeCloseTo(20_000 * 2_235.75, 2);
  });
});
