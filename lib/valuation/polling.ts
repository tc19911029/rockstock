export function buildValuationPollingUrls(symbol: string, jobDate: string, cacheBuster: number): {
  valuationUrl: string;
  statusUrl: string;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jobDate)) throw new Error('invalid valuation job date');
  const encodedSymbol = encodeURIComponent(symbol);
  return {
    valuationUrl: `/api/valuation/${encodedSymbol}?date=${jobDate}&_=${cacheBuster}`,
    statusUrl: `/api/valuation/prepare/${encodedSymbol}?date=${jobDate}&_=${cacheBuster}`,
  };
}
