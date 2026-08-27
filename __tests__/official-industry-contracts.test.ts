import { TW_OFFICIAL_CLASSIFICATION } from '@/lib/datasource/TWOfficialIndustry';
import { isSectorRankingFile, type SectorRankingFile } from '@/lib/themes/sectorRanking';
import { buildOfficialIndustryContextFromRanking } from '@/lib/themes/officialIndustryContext';
import { isValidYmd } from '@/lib/utils/ymd';

function ranking(): SectorRankingFile {
  return {
    date: '2026-08-27',
    generatedAt: '2026-08-27T10:00:00.000Z',
    classification: TW_OFFICIAL_CLASSIFICATION,
    themes: [{
      industryId: 'TPEx:22',
      industryCode: '22',
      markets: ['TPEx'],
      theme: '生技醫療',
      stockCount: 2,
      avgD1: 1,
      avgD5: 2,
      avgD20: 3,
      avgD60: 4,
      avgVolRatio: 1.2,
      breadth: 0.5,
      instNet5: 10,
      instAmt5: 1000,
      stage: '主升段',
      topStock: { code: '4162', name: '智擎', symbol: '4162.TWO', d1: 2 },
      members: [
        { code: '4162', name: '智擎', symbol: '4162.TWO', market: 'TPEx', d1: 2, d5: 3, d20: 4, d60: 5, volRatio: 1.2, turnover: 100, instNet5: 10, rets: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], instAmt: [1000, 1000, 1000, 1000, 1000, 1000, 1000], retailAmt: [0, 0, 0, 0, 0, 0, 0] },
        { code: '4743', name: '合一', symbol: '4743.TWO', market: 'TPEx', d1: 0, d5: 1, d20: 2, d60: 3, volRatio: 1, turnover: 80, instNet5: 0, rets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], instAmt: [0, 0, 0, 0, 0, 0, 0], retailAmt: [0, 0, 0, 0, 0, 0, 0] },
      ],
    }],
  };
}

describe('官方產業快照契約', () => {
  it('只接受正式名稱、穩定 industryId 與正確市場後綴', () => {
    const valid = ranking();
    expect(isSectorRankingFile(valid, valid.date)).toBe(true);

    const wrongSuffix = structuredClone(valid);
    wrongSuffix.themes[0].members[0].symbol = '4162.TW';
    expect(isSectorRankingFile(wrongSuffix, wrongSuffix.date)).toBe(false);

    const mergedCrossMarketName = structuredClone(valid);
    mergedCrossMarketName.themes[0].industryId = '22';
    expect(isSectorRankingFile(mergedCrossMarketName, mergedCrossMarketName.date)).toBe(false);

    const incompleteSeries = structuredClone(valid);
    incompleteSeries.themes[0].members[0].rets.pop();
    expect(isSectorRankingFile(incompleteSeries, incompleteSeries.date)).toBe(false);

    const weekend = structuredClone(valid);
    weekend.date = '2026-08-29';
    expect(isSectorRankingFile(weekend, weekend.date)).toBe(false);
  });

  it('從已驗證快照恢復官方同業與精確 symbol，不猜 .TW', () => {
    const context = buildOfficialIndustryContextFromRanking(ranking());
    expect(context.source).toBe('persisted_snapshot');
    expect(context.asOf).toBe('2026-08-27');
    expect(context.industryByCode.get('4162')).toBe('生技醫療');
    expect(context.peersByCode.get('4162')).toEqual(['4743']);
    expect(context.symbolByCode.get('4162')).toBe('4162.TWO');
  });
});

describe('YYYY-MM-DD 嚴格驗證', () => {
  it.each([
    ['2026-02-28', true],
    ['2024-02-29', true],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['2026-8-27', false],
  ])('%s → %s', (value, expected) => {
    expect(isValidYmd(value)).toBe(expected);
  });
});
