import { parseTpexNoticeRows } from '@/lib/datasource/AttentionListProvider';

describe('TPEx 上櫃注意股官方資料', () => {
  test('解析注意股並排除權證', () => {
    const rows = parseTpexNoticeRows([
      {
        Date: '1150814', SecuritiesCompanyCode: '3490', CompanyName: '單井',
        TradingInformation: '最近六個營業日累積漲幅達標',
      },
      {
        Date: '1150814', SecuritiesCompanyCode: '36053', CompanyName: '宏致三',
        TradingInformation: '權證注意資訊',
      },
    ]);
    expect(rows).toEqual([{
      code: '3490',
      name: '單井',
      exchange: 'TPEX',
      kind: 'notice',
      announceDate: '2026-08-14',
      reason: '最近六個營業日累積漲幅達標',
    }]);
  });
});
