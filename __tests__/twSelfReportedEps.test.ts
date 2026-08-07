import { parseSelfReportedMonthlyActuals } from '@/lib/datasource/TwSelfReportedEps';
import { parseYahooTwStockNewsHtml } from '@/lib/news/yahooTwStockNews';

const julyAnnouncement = `
  <li>
    <h3><a href="https://tw.stock.yahoo.com/news/3006-july.html">【公告】係因晶豪科有價證券於集中交易市場達公布注意交易資訊標準，故公布相關財務業務等重大訊息。</a></h3>
    <p>日 期：2026年08月07日公司名稱：晶豪科(3006)主 旨：注意交易資訊。3.財務業務資訊:期間 (月) (季) (最近四季累計) 最近一月 與去年同期 最近一季 與去年同期 114年第3季至科目 115年7月 增減% 115年第2季 增減% 115年第2季(合併自結數) (合併核閱數) (合併核閱數) 營業收入 6,785 491% 13,946 324% 29,597（百萬）稅前淨利 4,255 4,776% 7,332 1,072% 10,787（百萬）歸屬母公司業主淨利 3,490 4,021% 5,908 913% 9,020（百萬）每股盈餘 11.61 3,728% 20.21</p>
  </li>
`;

describe('TW attention-stock self-reported EPS', () => {
  it('extracts 3006 July monthly actuals from the Yahoo MOPS republication', () => {
    const news = parseYahooTwStockNewsHtml(julyAnnouncement);
    const actuals = parseSelfReportedMonthlyActuals(news);

    expect(news).toHaveLength(1);
    expect(actuals).toEqual([
      expect.objectContaining({
        period: '2026-07',
        revenue: 6_785_000_000,
        pretaxIncome: 4_255_000_000,
        netIncome: 3_490_000_000,
        eps: 11.61,
        announcedAt: '2026-08-07',
        audited: false,
      }),
    ]);
  });

  it('ignores ordinary monthly revenue announcements without EPS', () => {
    const html = `<h3><a href="/news/revenue.html">【公告】晶豪科 2026年7月合併營收67.85億元</a></h3><p>日 期：2026年08月04日營業收入6,784,662仟元</p>`;
    expect(parseSelfReportedMonthlyActuals(parseYahooTwStockNewsHtml(html))).toEqual([]);
  });
});
