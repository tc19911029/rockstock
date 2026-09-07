jest.mock('node:fs', () => ({ promises: {
  readFile: jest.fn().mockRejectedValue(new Error('no cache')),
  mkdir: jest.fn().mockResolvedValue(undefined), writeFile: jest.fn().mockResolvedValue(undefined), rename: jest.fn().mockResolvedValue(undefined),
} }));
jest.mock('@/lib/datasource/twSymbolMarket', () => ({ expectedTwSymbol: jest.fn(async (s: string) => s === '2330.TW' ? s : null) }));
jest.mock('@/lib/datasource/curlFetch', () => ({ fetchJsonWithCurlFallback: jest.fn() }));
import { fetchJsonWithCurlFallback } from '@/lib/datasource/curlFetch';
import { fetchEmergingChart, resolveEmergingCompany } from '@/lib/datasource/TpexEmergingProvider';

it('automatically discovers an ESB stock, fetches official history/live data and adjusts before weekly aggregation', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-07T12:00:00+08:00'));
  const network = jest.mocked(fetchJsonWithCurlFallback);
  network.mockImplementation(async (url: string) => {
    let data: unknown;
    if (url.includes('mopsfin_t187ap03_R')) data = [{ SecuritiesCompanyCode: '7777', CompanyAbbreviation: '測試興櫃' }];
    else if (url.includes('finance.yahoo.com')) data = { chart: { result: [{ meta: { symbol: '7777.TWO' }, events: { splits: {
      event: { date: 1787187600, numerator: 10, denominator: 1 },
    } } }] } };
    else if (url.includes('emerging/historical')) data = { stat: 'ok', tables: [{
      fields: ['日期', '成交股數', '成交最高', '成交最低', '成交均價'],
      data: url.includes('2026/08') ? [['115/08/19', '1000', '960', '900', '930'], ['115/08/31', '10000', '100', '90', '96']] : [],
    }] };
    else if (url.includes('emerging/latest')) data = { stat: 'ok', tables: [{ date: '115年09月07日 11:59:03',
      fields: ['代號', '日最高', '日最低', '日均價', '成交量'], data: [['7777', '150', '110', '132', '30000']],
    }] };
    else throw new Error(`Unexpected data source ${url}`);
    return { data, source: 'curl' } as Awaited<ReturnType<typeof fetchJsonWithCurlFallback>>;
  });
  try {
    expect(await resolveEmergingCompany('2330')).toBeNull();
    expect(network).not.toHaveBeenCalled();
    const company = await resolveEmergingCompany('7777.TW');
    expect(company).toEqual({ code: '7777', name: '測試興櫃' });
    const chart = await fetchEmergingChart(company!, '1mo', '1d');
    expect(chart).toMatchObject({ ticker: '7777.TWO', stale: false, lastDate: '2026-09-07', adjustmentStatus: 'adjusted', marketBoard: 'emerging' });
    expect(chart.candles[0]).toMatchObject({ close: 93, volume: 10 });
    expect(chart.candles.at(-1)).toMatchObject({ close: 132, date: '2026-09-07' });
    const count = network.mock.calls.length;
    const weekly = await fetchEmergingChart(company!, '1mo', '1wk');
    expect(weekly.candles[0]).toMatchObject({ high: 96, priceBasis: 'esb-average' });
    expect(network).toHaveBeenCalledTimes(count); // 重複載圖不重打歷史/事件來源
  } finally { jest.useRealTimers(); }
});
