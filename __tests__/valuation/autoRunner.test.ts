import { buildValuationCodexArgs, normalizeValuationOutput } from '@/lib/valuation/autoRunner';
import { validateValuationOutput } from '@/lib/valuation/outputValidation';

describe('valuation auto runner', () => {
  it('以 headless Codex 執行 valuation skill，不依賴 Terminal 或 AppleScript', () => {
    const args = buildValuationCodexArgs({
      workDir: '/tmp/rockstock-valuation/runtime/603268-job',
      questionPath: '/tmp/rockstock-valuation/runtime/603268-job/question.json',
      symbol: '603268',
      date: '2026-08-08',
      outputPath: '/tmp/rockstock-valuation/runtime/603268-job/valuation.json',
    });

    expect(args.slice(0, 6)).toEqual([
      'exec',
      '--ephemeral',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
    ]);
    expect(args).toContain('/tmp/rockstock-valuation/runtime/603268-job');
    expect(args.at(-1)).toContain('source-command-valuation skill');
    expect(args.at(-1)).toContain('/tmp/rockstock-valuation/runtime/603268-job/question.json');
    expect(args.at(-1)).toContain('只能把最終 JSON 寫入');
    expect(args.at(-1)).toContain('嚴禁修改其他檔案');
    expect(args.join(' ')).not.toContain('/workspace/rockstock');
    expect(args.join(' ')).not.toMatch(/Terminal|iTerm|osascript/);
  });

  it('增量模式只重查新公告並沿用未變的同業與估值模型', () => {
    const args = buildValuationCodexArgs({
      workDir: '/tmp/rockstock-valuation/runtime/3006-job',
      questionPath: '/tmp/rockstock-valuation/runtime/3006-job/question.json',
      symbol: '3006',
      date: '2026-08-09',
      outputPath: '/tmp/rockstock-valuation/runtime/3006-job/valuation.json',
      mode: 'incremental',
    });

    expect(args.at(-1)).toContain('這是增量估值');
    expect(args.at(-1)).toContain('不得把未變資料整份重新搜尋');
  });

  it('只正規化 Agent 的格式差異，不改動估值數字', () => {
    const scenario = {
      probability: 25,
      q2Revenue: 1,
      q3Revenue: 1,
      q4Revenue: 1,
      q2NetMargin: 0.1,
      q3NetMargin: 0.1,
      q4NetMargin: 0.1,
      q2Eps: 1,
      q3Eps: 1,
      q4Eps: 1,
      fullYearEps: 10,
      valuationEps: 10,
      valuationEpsBasis: '正常化完全稀釋 EPS 說明',
      forwardPe: 10,
      fairPe: 12,
      fairPrice: 120,
      upside: 0.2,
      assumptionEvidence: [
        { field: 'revenue', sourceUrl: 'https://example.com/a', rawQuote: 'a' },
        { field: 'margin', sourceUrl: 'https://example.com/b', rawQuote: 'b' },
      ],
    };
    const value = normalizeValuationOutput({
      symbol: '603268',
      date: '2026-08-08',
      generatedAt: '2026-08-08T23:30:00+08:00',
      monthlyEpsEstimate: {
        month: null,
        monthlyRevenue: null,
        netMarginUsed: null,
        estimatedNetIncome: null,
        estimatedEps: null,
        note: '陸股沒有月營收，不得虛構月 EPS。',
      },
      currentPriceContext: { currentPrice: 100, priceDate: '2026-08-07' },
      ttmPe: 20,
      scenarios: {
        pessimistic: scenario,
        base: { ...scenario, probability: 50 },
        optimistic: scenario,
      },
      dilution: {
        prePlacementShares: 970_778_303,
        fullyDilutedSharesUsed: 1_018_716_941,
        dilutionRateVsPrePlacement: 0.04938,
      },
      valuationMethod: {
        primary: { method: 'normalized forward PE' },
        crossValidation: { method: 'reverse EV/EBITDA' },
      },
    }, new Date('2026-08-08T14:47:00.000Z')) as {
      generatedAt: string;
      scenarios: Record<string, Record<string, unknown>>;
      dilution: Record<string, unknown>;
    };

    expect(value.generatedAt).toBe('2026-08-08T14:47:00.000Z');
    expect(value).toMatchObject({ monthlyEpsEstimate: null });
    expect(value.scenarios.base).toMatchObject({
      probability: 0.5,
      valuationEps: 10,
      valuationEpsBasis: 'fully_diluted',
      valuationEpsBasisNote: '正常化完全稀釋 EPS 說明',
    });
    expect(value.dilution).toMatchObject({
      originalShares: 970_778_303,
      newShares: 1_018_716_941,
      ratio: 0.04938,
      baseDilutedEps: 10,
      baseDilutedPrice: 120,
    });
    expect(value).toMatchObject({
      valuationMethod: {
        primaryModel: 'normalized forward PE',
        crossChecks: [{ method: 'reverse EV/EBITDA' }],
      },
    });
    expect(validateValuationOutput(value, new Date('2026-08-08T14:48:00.000Z')).valid).toBe(true);
  });

  it('以 Rockstar 的結構化輸入覆蓋 Agent 自由描述的資料指紋', () => {
    const expectedDataAsOf = {
      financialReportPeriod: '2026Q2',
      monthlyRevenuePeriod: '2026-07-01',
      sharesOutstanding: 289_082_000,
      dilutionSignature: '',
    };
    const value = normalizeValuationOutput({
      dataAsOf: {
        financialReportPeriod: '2026H1',
        dilutionSignature: 'agent free-form description',
      },
    }, new Date('2026-08-09T01:00:00.000Z'), expectedDataAsOf);

    expect(value).toMatchObject({ dataAsOf: expectedDataAsOf });
  });
});
