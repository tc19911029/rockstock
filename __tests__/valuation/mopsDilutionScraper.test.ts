import { classifyDilutionSubject, inferDilutionStatus, parseNewShares } from '@/lib/datasource/MopsDilutionScraper';

describe('MOPS dilution classification', () => {
  it('keeps issuer capital raises and parses shares', () => {
    expect(classifyDilutionSubject('公告本公司現金增資發行新股 600 萬股')).toBe('rights_issue');
    expect(parseNewShares('發行新股 600 萬股')).toBe(6_000_000);
  });

  it.each([
    '代重要子公司公告現金增資',
    '公告本公司認購甲公司現金增資案',
    '公告取得乙公司私募普通股',
    '公告調整可轉換公司債轉換價格',
    '公告辦理減資彌補虧損',
  ])('rejects non-dilutive subject: %s', subject => {
    expect(classifyDilutionSubject(subject)).toBeNull();
  });

  it('retains cancellation status so active calculations can ignore it', () => {
    const subject = '公告本公司不繼續辦理私募普通股';
    expect(classifyDilutionSubject(subject)).toBe('private_placement');
    expect(inferDilutionStatus(subject)).toBe('cancelled');
  });
});
