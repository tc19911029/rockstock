import { fetchTdccLatestWeek } from '@/lib/datasource/TdccProvider';
import { fetchTextWithCurlFallback } from '@/lib/datasource/curlFetch';
jest.mock('@/lib/datasource/curlFetch', () => ({ fetchTextWithCurlFallback: jest.fn() }));
it('fetches the official weekly CSV through the proxy-capable transport and retains its reference date', async () => {
  jest.mocked(fetchTextWithCurlFallback).mockResolvedValue({source:'curl',text:'資料日期,證券代號,持股分級,人數,股數,比例\n20260904,2330,12,10,5000000,1.25\n20260904,2330,15,20,9000000,80.5\n20260904,2330,17,30,14000000,100\n'});
  const result = await fetchTdccLatestWeek();
  expect(result.date).toBe('2026-09-04');
  expect(result.data.get('2330')).toEqual(expect.objectContaining({holder400Pct:81.75,holder1000Pct:80.5,holderCount:30}));
  expect(fetchTextWithCurlFallback).toHaveBeenCalledWith(expect.stringContaining('smart.tdcc.com.tw'),expect.objectContaining({proxyFirst:true}));
});
