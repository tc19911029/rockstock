import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildOfficialIndustryPeerMap,
  duplicateOfficialStockCodes,
  groupOfficialIndustryStocks,
  officialIndustryGroupId,
  officialIndustryName,
  parseOfficialIndustryRows,
  parseOfficialIndustrySectorFallback,
  unknownOfficialIndustryCodes,
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

  it('使用 TPEx 現行正式名稱，並移除已併入新產業的舊代碼', () => {
    expect(officialIndustryName('TPEx', '22')).toBe('生技醫療');
    expect(officialIndustryName('TPEx', '33')).toBe('農業科技業');
    expect(officialIndustryName('TPEx', '80')).toBe('管理股票');
    expect(officialIndustryName('TPEx', '18')).toBeUndefined();
    expect(officialIndustryName('TPEx', '34')).toBeUndefined();
  });

  it('市場正式名稱不同時，即使只收到單一市場，industryId 仍保持穩定', () => {
    expect(officialIndustryGroupId('17', '金融保險', ['TWSE'])).toBe('TWSE:17');
    expect(officialIndustryGroupId('22', '生技醫療', ['TPEx'])).toBe('TPEx:22');
    expect(officialIndustryGroupId('24', '半導體業', ['TPEx'])).toBe('24');
  });

  it('可偵測官方新增未知代碼與跨來源重複股票代碼', () => {
    const twse = [{ 公司代號: '2330', 公司簡稱: '台積電', 產業別: '99' }];
    const tpex = [{ SecuritiesCompanyCode: '2330', CompanyAbbreviation: '重複', SecuritiesIndustryCode: '24' }];
    expect(unknownOfficialIndustryCodes(twse, tpex)).toEqual({ TWSE: ['99'], TPEx: [] });
    expect(duplicateOfficialStockCodes(twse, tpex)).toEqual(['2330']);
  });

  it('相容函式不再以人工晶圓代工題材覆蓋官方半導體業', () => {
    expect(getTWConcept('2330', officialIndustryName('TWSE', '24'))).toBe('半導體業');
    expect(getTWConcept('2330')).toBeUndefined();
  });

  it('官方 OpenAPI 忙線時可從最近的完整官方產業封存還原名單', () => {
    const file = JSON.parse(readFileSync(
      path.join(process.cwd(), 'data', 'sectors', 'TW', '2026-08-27.json'),
      'utf8',
    )) as unknown;
    const stocks = parseOfficialIndustrySectorFallback(file);

    expect(stocks).toHaveLength(1975);
    expect(stocks?.find((stock) => stock.code === '3081')).toEqual({
      code: '3081',
      name: '聯亞',
      market: 'TPEx',
      symbol: '3081.TWO',
      industryCode: '27',
      industry: '通信網路業',
    });
  });

  it('本地官方產業封存若代號後綴遭竄改就拒絕降級', () => {
    const file = JSON.parse(readFileSync(
      path.join(process.cwd(), 'data', 'sectors', 'TW', '2026-08-27.json'),
      'utf8',
    )) as { themes: Array<{ members: Array<{ symbol: string }> }> };
    file.themes[0].members[0].symbol = '0000.TW';

    expect(parseOfficialIndustrySectorFallback(file)).toBeNull();
  });
});
