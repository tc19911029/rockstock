jest.mock('@/lib/datasource/TWOfficialIndustry', () => ({ fetchTwOfficialIndustryRoster: jest.fn() }));
jest.mock('@/lib/datasource/FinMindClient', () => ({ getStockInfo: jest.fn() }));

afterEach(() => jest.resetModules());
test('parallel bundles use one official roster request and preserve its source', async () => {
  const { fetchTwOfficialIndustryRoster } = await import('@/lib/datasource/TWOfficialIndustry');
  const { getStockInfo } = await import('@/lib/datasource/FinMindClient');
  (fetchTwOfficialIndustryRoster as jest.Mock).mockResolvedValue([{ code: '1240', name: '茂生農經', industry: '農業科技', market: 'TPEx' }]);
  const { loadIndustry } = await import('@/lib/youtube/stockDataLoader');
  const rows = await Promise.all(Array.from({ length: 10 }, () => loadIndustry('1240')));
  expect(rows[0]).toMatchObject({ data: { industry_category: '農業科技', market_type: 'tpex' }, source: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O' });
  expect(fetchTwOfficialIndustryRoster).toHaveBeenCalledTimes(1);
  expect(getStockInfo).not.toHaveBeenCalled();
});
test('falls back to FinMind when official sources cannot be read', async () => {
  const { fetchTwOfficialIndustryRoster } = await import('@/lib/datasource/TWOfficialIndustry');
  const { getStockInfo } = await import('@/lib/datasource/FinMindClient');
  (fetchTwOfficialIndustryRoster as jest.Mock).mockRejectedValue(new Error('offline'));
  (getStockInfo as jest.Mock).mockResolvedValue({ stock_name: '台積電', industry_category: '半導體業', market_type: 'twse' });
  const { loadIndustry } = await import('@/lib/youtube/stockDataLoader');
  expect(await loadIndustry('2330')).toMatchObject({ source: 'finmind:TaiwanStockInfo', freshness: 'fresh' });
});
