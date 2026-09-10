describe('TwseOpenApiProvider failure cache', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  test('bulk endpoint 失敗時同一輪掃描只嘗試一次，不對每檔股票重打', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('upstream unavailable'));
    global.fetch = fetchMock as typeof fetch;
    jest.resetModules();
    const { getTwseQuarterly } = await import('@/lib/datasource/TwseOpenApiProvider');

    await Promise.all(Array.from({ length: 10 }, (_, i) => getTwseQuarterly(String(2300 + i))));
    await getTwseQuarterly('2330');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TPEx quarterly schema', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; jest.resetModules(); });
  test.each([
    { SecuritiesCompanyCode: '1240', Year: '115', '基本每股盈餘': '2.85' },
    { '公司代號': '1240', '年度': '115', '基本每股盈餘(元)': '2.85' },
  ])('reads official and legacy company/year/EPS fields', async identity => {
    jest.resetModules();
    global.fetch = jest.fn(async (url: string) => ({ ok: true, json: async () => url.includes('t187ap14_L') ? [] : [{ ...identity, '季別': '2', '營業收入': '1440672', '營業利益': '87402', '稅後淨利': '126506' }] })) as unknown as typeof fetch;
    const { getQuarterlyAny } = await import('@/lib/datasource/TwseOpenApiProvider');
    expect(await getQuarterlyAny('1240')).toMatchObject({ code: '1240', rocYear: 115, season: 2, eps: 2.85, revenue: 1440672 });
    expect(await getQuarterlyAny('9999')).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
