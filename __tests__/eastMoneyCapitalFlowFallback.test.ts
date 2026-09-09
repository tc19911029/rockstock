import { fetchCapitalFlow } from '@/lib/datasource/EastMoneyCapitalFlow';
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';

jest.mock('@/lib/datasource/curlFetch', () => ({ fetchJsonWithCurlFallback: jest.fn() }));

describe('CN capital flow Sina fallback', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses the proxy-capable fallback after EastMoney fails and preserves units and missing breakdowns', async () => {
    jest.mocked(fetchJsonWithCurlFallback).mockResolvedValue({
      source: 'curl', data: [{ opendate: '2026-09-09', r0_net: '-641850339.1000' }],
    });
    expect(await fetchCapitalFlow('600519.SS', 5)).toEqual([
      { date: '2026-09-09', mainNet: -641850339.1, superNet: null, largeNet: null },
    ]);
    expect(fetchJsonWithCurlFallback).toHaveBeenCalledWith(
      expect.stringContaining('daima=sh600519'),
      expect.objectContaining({ proxyFirst: true, timeoutMs: 10_000 }),
    );
  });

  it('does not turn missing or malformed source values into zero flows', async () => {
    jest.mocked(fetchJsonWithCurlFallback).mockResolvedValue({
      source: 'curl', data: [
        { opendate: '2026-09-09' },
        { opendate: '2026-09-09', r0_net: 'unavailable' },
        { opendate: 'bad-date', r0_net: '10' },
        { opendate: '2026-09-08', r0_net: '0' },
      ],
    });
    expect(await fetchCapitalFlow('000001.SZ')).toEqual([
      { date: '2026-09-08', mainNet: 0, superNet: null, largeNet: null },
    ]);
  });
});
