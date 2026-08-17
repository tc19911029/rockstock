import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateValuationOutput } from '@/lib/valuation/outputValidation';

const root = process.cwd();

interface PeerSnapshot { symbol: string; excluded?: boolean }
interface ScenarioSnapshot { fullYearEps: number }
interface ValuationSnapshot {
  date: string;
  symbol: string;
  peerComparison: { peers: PeerSnapshot[] };
  scenarios: {
    pessimistic: ScenarioSnapshot;
    base: ScenarioSnapshot;
    optimistic: ScenarioSnapshot;
  };
  dataAsOf: { dilutionSignature: string; sharesOutstanding: number };
  actualEpsYtd: number;
  monthlyEpsActuals: Array<{ period: string; eps: number }>;
}
interface ReviewSnapshot { reviews: Array<{ currentPrice: number; action: string; symbol: string }> }
interface HoldingsSnapshot { holdings: Array<{ symbol: string; shares: number; entryPrice: number }> }

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf-8')) as T;
}

describe('2026-08-08 holdings valuation refresh', () => {
  const symbols = ['3006', '6770', '3081', '000988', '001309', '603986'];

  it.each(symbols)('%s has a current, peer-calibrated three-scenario valuation', symbol => {
    const file = path.join(root, 'data', 'valuation', '2026-08-08', `${symbol}.json`);
    const valuation = readJson<ValuationSnapshot>(file);
    expect(valuation.date).toBe('2026-08-08');
    const includedPeers = valuation.peerComparison.peers.filter(p => !p.excluded).length;
    expect(includedPeers).toBeGreaterThanOrEqual(valuation.symbol === '6770' ? 2 : 3);
    expect(valuation.scenarios.pessimistic.fullYearEps).toBeGreaterThan(0);
    expect(valuation.scenarios.base.fullYearEps).toBeGreaterThan(valuation.scenarios.pessimistic.fullYearEps);
    expect(valuation.scenarios.optimistic.fullYearEps).toBeGreaterThan(valuation.scenarios.base.fullYearEps);
    expect(valuation.dataAsOf.dilutionSignature).toEqual(expect.any(String));
    expect(validateValuationOutput(valuation, new Date('2026-08-07T18:30:00.000Z')).valid).toBe(true);
  });

  it('excludes TSMC from PSMC core peer median', () => {
    const psmc = readJson<ValuationSnapshot>(path.join(root, 'data/valuation/2026-08-08/6770.json'));
    expect(psmc.peerComparison.peers.find(peer => peer.symbol === '2330')).toMatchObject({ excluded: true });
  });

  it('records 3006 July self-reported EPS and 3081 post-dividend shares', () => {
    const esmt = readJson<ValuationSnapshot>(path.join(root, 'data/valuation/2026-08-08/3006.json'));
    const landmark = readJson<ValuationSnapshot>(path.join(root, 'data/valuation/2026-08-08/3081.json'));
    expect(esmt.actualEpsYtd).toBeCloseTo(39.19, 2);
    expect(esmt.monthlyEpsActuals[0]).toMatchObject({ period: '2026-07', eps: 11.61 });
    expect(landmark.dataAsOf.sharesOutstanding).toBe(101_769_004);
  });

  it('reviews every TW and CN holding with a non-null current price', () => {
    const review = readJson<ReviewSnapshot>(path.join(root, 'data/agents/portfolio/reviews/2026-08-08.json'));
    expect(review.reviews).toHaveLength(6);
    expect(review.reviews.every(r => r.currentPrice > 0)).toBe(true);
    expect(review.reviews.filter(r => r.action === 'stop_loss').map(r => r.symbol).sort()).toEqual([
      '000988.SZ', '001309.SZ', '603986.SS', '6770.TW',
    ]);
  });

  it('keeps 3081 total cost constant after the 10% stock dividend adjustment', () => {
    const holdings = readJson<HoldingsSnapshot>(path.join(root, 'data/agents/portfolio/holdings.json'));
    const landmark = holdings.holdings.find(h => h.symbol === '3081.TWO');
    expect(landmark).toBeDefined();
    if (!landmark) throw new Error('3081.TWO holding missing');
    expect(landmark.shares).toBe(22_000);
    expect(landmark.entryPrice).toBeCloseTo(2_032.5, 4);
    expect(landmark.shares * landmark.entryPrice).toBeCloseTo(20_000 * 2_235.75, 2);
  });
});
