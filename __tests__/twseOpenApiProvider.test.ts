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
