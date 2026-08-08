import { validateValuationOutput } from '@/lib/valuation/outputValidation';

function scenario(valuationEps: number, fairPe: number, price = 100) {
  return {
    probability: valuationEps === 10 ? 0.5 : 0.25,
    q2Revenue: 10, q3Revenue: 10, q4Revenue: 10,
    q2NetMargin: 0.1, q3NetMargin: 0.1, q4NetMargin: 0.1,
    q2Eps: 1, q3Eps: 1, q4Eps: 1,
    fullYearEps: valuationEps,
    valuationEps,
    valuationEpsBasis: 'reported',
    forwardPe: price / valuationEps,
    fairPe,
    fairPrice: valuationEps * fairPe,
    upside: valuationEps * fairPe / price - 1,
    assumptionEvidence: [
      { field: 'revenue', sourceUrl: 'https://example.com/a', rawQuote: 'revenue evidence' },
      { field: 'margin', sourceUrl: 'https://example.com/b', rawQuote: 'margin evidence' },
    ],
  };
}

function validOutput() {
  const peers = [1, 2, 3].map(index => ({ symbol: String(index), excluded: false, currentYearPe: 10 + index }));
  return {
    generatedAt: '2026-08-07T18:00:00.000Z',
    currentPriceContext: { currentPrice: 100, priceDate: '2026-08-07', ttmEps: 10 },
    ttmPe: 10,
    scenarios: {
      pessimistic: scenario(5, 10),
      base: scenario(10, 10),
      optimistic: scenario(15, 10),
    },
    peerComparison: { peers },
    valuationMethod: { primaryModel: 'Forward PE', crossChecks: ['reverse DCF'], rationale: 'growth' },
    dilution: null,
  };
}

describe('valuation output validation', () => {
  const now = new Date('2026-08-07T18:15:00.000Z');

  it('accepts one consistent EPS basis for PE and fair price', () => {
    expect(validateValuationOutput(validOutput(), now).valid).toBe(true);
  });

  it('rejects future timestamps, missing evidence, and mixed EPS arithmetic', () => {
    const output = validOutput();
    output.generatedAt = '2026-08-08T13:00:00.000Z';
    output.scenarios.base.fairPrice = 999;
    output.scenarios.base.forwardPe = 1;
    output.scenarios.base.assumptionEvidence = [];
    const report = validateValuationOutput(output, now);
    expect(report.valid).toBe(false);
    expect(report.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'future_generated_at', 'insufficient_evidence', 'fair_price_mismatch', 'forward_pe_mismatch',
    ]));
  });

  it('allows loss-making TTM history and one-decimal CN fair-price rounding', () => {
    const output = validOutput();
    output.ttmPe = -146.29;
    output.currentPriceContext.currentPrice = 10.46;
    output.currentPriceContext.ttmEps = -0.0715;
    output.scenarios.pessimistic.forwardPe = 10.46 / output.scenarios.pessimistic.valuationEps;
    output.scenarios.optimistic.forwardPe = 10.46 / output.scenarios.optimistic.valuationEps;
    output.scenarios.base = {
      ...scenario(0.22353337295617826, 32, 10.46),
      probability: 0.5,
      fairPrice: 7.2,
    };
    const report = validateValuationOutput(output, now);
    expect(report.valid).toBe(true);
    expect(report.warnings.map(warning => warning.code)).toContain('ttm_pe_not_applicable');
  });
});
