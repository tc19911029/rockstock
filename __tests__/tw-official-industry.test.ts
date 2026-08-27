import {
  buildOfficialIndustryPeerMap,
  groupOfficialIndustryStocks,
  officialIndustryName,
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
      { code: '2330', name: '台積電', market: 'TWSE', symbol: '2330.TW', industryCode: '24', industry: '半導體業' },
      { code: '2409', name: '友達', market: 'TWSE', symbol: '2409.TW', industryCode: '26', industry: '光電業' },
      { code: '3081', name: '聯亞', market: 'TPEx', symbol: '3081.TWO', industryCode: '27', industry: '通信網路業' },
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
    expect(buildOfficialIndustryPeerMap(stocks).get('2330')).toEqual(['8299']);
  });

  it('保留逐市場正式名稱；同代碼不同名稱不硬併', () => {
    const stocks = parseOfficialIndustryRows(
      [{ 公司代號: '2881', 公司簡稱: '富邦金', 產業別: '17' }],
      [{ SecuritiesCompanyCode: '6015', CompanyAbbreviation: '宏遠證', SecuritiesIndustryCode: '17' }],
    );
    const groups = groupOfficialIndustryStocks(stocks);

    expect(groups.map((group) => [group.id, group.industry, group.stocks.map((stock) => stock.symbol)])).toEqual([
      ['TWSE:17', '金融保險', ['2881.TW']],
      ['TPEx:17', '金融業', ['6015.TWO']],
    ]);
  });

  it('涵蓋 TPEx 正式電子商務與管理股票代碼', () => {
    expect(officialIndustryName('TPEx', '34')).toBe('電子商務');
    expect(officialIndustryName('TPEx', '80')).toBe('管理股票');
  });

  it('相容函式不再以人工晶圓代工題材覆蓋官方半導體業', () => {
    expect(getTWConcept('2330', officialIndustryName('TWSE', '24'))).toBe('半導體業');
    expect(getTWConcept('2330')).toBeUndefined();
  });
});
