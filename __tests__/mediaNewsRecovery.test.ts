jest.mock('@/lib/datasource/curlFetch', () => ({ fetchTextWithCurlFallback: jest.fn(), fetchJsonWithCurlFallback: jest.fn() }));
import { parseCompanyNewsRss, newsArticleTitles } from '@/lib/news/companyRss';
import { parseOwnership } from '@/lib/datasource/TWOfficialOwnership';
import { fetchYahooTwStockNews } from '@/lib/news/yahooTwStockNews';
import { fetchTextWithCurlFallback } from '@/lib/datasource/curlFetch';
const item = (title: string, date: string) => `<item><title><![CDATA[${title}]]></title><link>https://example.com/a</link><pubDate>${date}</pubDate><source>publisher</source></item>`;
test('rejects unrelated, undated, future and duplicate news while retaining distinct Chinese headlines', () => {
  const xml = item('台積電 新聞甲', '2026-09-09T01:00:00Z') + item('台積電 新聞乙', '2026-09-09T02:00:00Z')
    + item('台積電 新聞甲', '2026-09-09T01:00:00Z') + item('另一家公司', '2026-09-09T01:00:00Z')
    + item('台積電 無日期', '') + item('台積電 超前', '2026-09-10T00:00:00Z');
  expect(parseCompanyNewsRss(xml, '台積電', Date.parse('2026-09-06'), Date.parse('2026-09-10')).map(r => r.title)).toEqual(['台積電 新聞乙', '台積電 新聞甲']);
});
test('reads wrapped sentiment articles and excludes blank titles', () => {
  expect(newsArticleTitles([{ item: { title: '公司公告' }, score: 0 }, { title: '舊格式' }, { item: { title: '' } }])).toEqual(['公司公告', '舊格式']);
});
test('official TPEx holdings preserve real zero and unavailable ratios, normalize ROC dates', () => {
  expect(parseOwnership([{ Date: '1150909', SecuritiesCompanyCode: '1234', 'PercentageOfSharesOC/FMIHeld': '0%', 'PercentageOfAvailableInvestmentForOC/FI': '-' }], 'TPEx')).toEqual([{ code: '1234', date: '2026-09-09', pct: 0, remaining: null }]);
  expect(parseOwnership({ date: '20260909', data: [['1234', '', '', '', '', '', '', '-']] }, 'TWSE')).toEqual([]);
});
test('Yahoo retries the alternate exchange after a transport failure', async () => {
  (fetchTextWithCurlFallback as jest.Mock).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ text: '<h3><a href="/news/a">公告</a></h3><p>日期：2026年09月09日</p>' });
  expect(await fetchYahooTwStockNews('1234')).toHaveLength(1);
  expect(fetchTextWithCurlFallback).toHaveBeenLastCalledWith(expect.stringContaining('1234.TWO/news'), expect.objectContaining({ proxyFirst: true }));
});
test('unpublished TWSE current date falls back to a dated session and computes the actual four-week delta', async () => {
  const { fetchJsonWithCurlFallback } = await import('@/lib/datasource/curlFetch');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-10T02:00:00Z'));
  (fetchJsonWithCurlFallback as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('date=20260909')) return { data: { date: '20260909', data: [['2330', '', '', '', '', '', 25, 75]] } };
    if (url.includes('date=20260812')) return { data: { date: '20260812', data: [['2330', '', '', '', '', '', 27, 73]] } };
    return { data: [] };
  });
  try {
    const { getOfficialOwnership } = await import('@/lib/datasource/TWOfficialOwnership');
    expect(await getOfficialOwnership('2330')).toMatchObject({ data: { data_date: '2026-09-09', foreign_ownership_pct: 75, foreign_ownership_pct_4w_ago: 73, foreign_ownership_delta_4w: 2 }, source: expect.stringContaining('date=20260909') });
  } finally { clock.mockRestore(); }
});
test('successful but empty fundamentals are unavailable, not zero-valued observations', async () => {
  const previous = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { eps: null, per: null } }) });
  try {
    const { loadFundamental } = await import('@/lib/youtube/stockDataLoader');
    expect(await loadFundamental('2330')).toMatchObject({ data: null, freshness: 'unavailable' });
  } finally { global.fetch = previous; }
});
