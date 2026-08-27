import {
  OFFICIAL_INDUSTRY_NAMES,
  groupOfficialIndustryStocks,
  parseOfficialIndustryRows,
} from '@/lib/datasource/TWOfficialIndustry';
import { getTWConcept } from '@/lib/scanner/conceptMap';

describe('TWSE／TPEx 官方產業分類', () => {
  it('解析上市與上櫃官方欄位，並排除存託憑證及未知代碼', () => {
    const stocks = parseOfficialIndustryRows(
      [
        { 公司代號: '2330', 公司簡稱: '台積電', 產業別: '24' },
        { 公司代號: '2409', 公司簡稱: '友達', 產業別: '26' },
        { 公司代號: '9103', 公司簡稱: '美德醫療-DR', 產業別: '91' },
      ],
      [
        { SecuritiesCompanyCode: '3081', CompanyAbbreviation: '聯亞', SecuritiesIndustryCode: '27' },
        { SecuritiesCompanyCode: '9999', CompanyAbbreviation: '未知', SecuritiesIndustryCode: '99' },
      ],
    );

    expect(stocks).toEqual([
      { code: '2330', name: '台積電', market: 'TWSE', industryCode: '24', industry: '半導體業' },
      { code: '2409', name: '友達', market: 'TWSE', industryCode: '26', industry: '光電業' },
      { code: '3081', name: '聯亞', market: 'TPEx', industryCode: '27', industry: '通信網路業' },
    ]);
  });

  it('依正式產業代碼分組，一家公司只出現在一組', () => {
    const stocks = parseOfficialIndustryRows(
      [
        { 公司代號: '2330', 公司簡稱: '台積電', 產業別: '24' },
        { 公司代號: '2409', 公司簡稱: '友達', 產業別: '26' },
      ],
      [
        { SecuritiesCompanyCode: '8299', CompanyAbbreviation: '群聯', SecuritiesIndustryCode: '24' },
      ],
    );
    const groups = groupOfficialIndustryStocks(stocks);

    expect(groups.map((group) => [group.industryCode, group.industry, group.stocks.map((stock) => stock.code)])).toEqual([
      ['24', '半導體業', ['2330', '8299']],
      ['26', '光電業', ['2409']],
    ]);
    expect(groups.flatMap((group) => group.stocks)).toHaveLength(stocks.length);
  });

  it('相容函式不再以人工晶圓代工題材覆蓋官方半導體業', () => {
    expect(getTWConcept('2330', OFFICIAL_INDUSTRY_NAMES['24'])).toBe('半導體業');
    expect(getTWConcept('2330')).toBeUndefined();
  });
});
